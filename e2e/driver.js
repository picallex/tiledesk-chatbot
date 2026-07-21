// TiledeskDriver — drives a bot conversation end-to-end over the public HTTP API,
// exactly like the widget does: anonymous signin -> POST user message -> poll GET
// messages for the bot reply. The bot reply is async (never in the POST response).

const { randomUUID } = require('crypto');

async function http(method, url, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = token; // signin returns "JWT <...>"
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const err = new Error(`${method} ${url} -> ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

class TiledeskDriver {
  constructor(config, { debug = false } = {}) {
    this.c = config;
    this.debug = debug;
    this.token = null;
    this.userId = null;
    this.requestId = null;
    this.seen = new Set(); // message ids already consumed
    // Injected into message.attributes.payload.message → resolves {{payload.message.*}}.
    this.messagePayload = { ...(config.messagePayload || {}) };
  }

  log(...a) { if (this.debug) console.log('   [driver]', ...a); }

  async signin() {
    const j = await http('POST', `${this.c.baseUrl}/auth/signinAnonymously`, {
      body: { id_project: this.c.projectId, firstname: 'E2E Test' },
    });
    this.token = j.token && j.token.startsWith('JWT ') ? j.token : `JWT ${j.token}`;
    this.userId = j.user && j.user._id;
    if (!this.token || !this.userId) throw new Error('signin: missing token/user in response');
    this.log('signed in as', this.userId);
    return this;
  }

  newConversation() {
    this.requestId = `support-group-${this.c.projectId}-${randomUUID().replace(/-/g, '')}`;
    this.seen.clear();
    this.log('request_id', this.requestId);
    return this.requestId;
  }

  async sendUserMessage(text) {
    const draftFlag = this.c.draft ? '?td_draft=true' : '';
    const attributes = { sourcePage: `http://localhost/e2e${draftFlag}` };
    // Expose custom flow variables as {{payload.message.*}} (see config.messagePayload).
    if (this.messagePayload && Object.keys(this.messagePayload).length) {
      attributes.payload = { message: { ...this.messagePayload } };
    }
    const body = {
      sender: this.userId,
      senderFullname: 'E2E Test',
      text,
      type: 'text',
      participants: [`bot_${this.c.botId}`],
      attributes,
      language: 'es',
      preflight: true,
    };
    if (this.c.departmentId) body.departmentid = this.c.departmentId;
    await http('POST', `${this.c.baseUrl}/${this.c.projectId}/requests/${this.requestId}/messages`, {
      token: this.token, body,
    });
    this.log('> user:', text);
  }

  async getMessages() {
    return http('GET', `${this.c.baseUrl}/${this.c.projectId}/requests/${this.requestId}/messages`, { token: this.token });
  }

  isBot(m) {
    if (typeof m.sender !== 'string') return false;
    // The bot message sender is the raw bot id (not prefixed with "bot_").
    return m.sender === this.c.botId || m.sender.startsWith('bot_');
  }

  // Wait for the bot's reply to the current turn. Collects all NEW bot messages,
  // returning once a quiet gap passes with no further bot output (the flow can emit
  // several messages per turn) or the turn times out.
  async waitForBotTurn() {
    const start = Date.now();
    const collected = [];
    let lastArrival = null;
    while (Date.now() - start < this.c.turnTimeoutMs) {
      await sleep(this.c.pollMs);
      let msgs;
      try { msgs = await this.getMessages(); } catch (e) { this.log('poll error', e.message); continue; }
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        if (this.seen.has(m._id)) continue;
        this.seen.add(m._id);
        if (this.isBot(m)) {
          collected.push(m);
          lastArrival = Date.now();
          this.log('< bot:', (m.text || '').slice(0, 120));
        }
      }
      // Turn considered complete once we got >=1 bot msg and it went quiet.
      if (collected.length && lastArrival && Date.now() - lastArrival >= this.c.quietMs) break;
    }
    return collected;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- Outcome / termination detection --------------------------------------

// The OpenAI Chat Prompt returns {finalizar, motivo, respuesta}. The engine stashes
// the raw model output on the reply message attributes, and the flow branches per
// motivo. We recover the outcome from (in order): _raw_message, any JSON-looking
// attribute/text with finalizar/motivo, and the executing block's intent_name.
function parseOutcomeFromString(s) {
  if (typeof s !== 'string') return null;
  const tryParse = (str) => { try { return JSON.parse(str); } catch { return null; } };
  let o = tryParse(s);
  if (!o) {
    const m = s.match(/\{[\s\S]*\}/); // JSON embedded in text
    if (m) o = tryParse(m[0]);
  }
  if (o && (typeof o.finalizar !== 'undefined' || typeof o.motivo !== 'undefined')) {
    return { finalizar: o.finalizar === true || o.finalizar === 'true', motivo: (o.motivo || '').toString().trim() };
  }
  return null;
}

const FINISH_SENTINEL = '--FINISH--';

// Terminal block/intent name -> motivo. Lets us recover the edge even when the
// terminal turn's message doesn't carry the parsed OpenAI JSON (e.g. it closed via
// the --FINISH-- sentinel, or via the "Error en respuesta" branch).
const INTENT_TO_MOTIVO = {
  'contactar ya': 'CONTACTAR YA',
  'llamar mas tarde': 'LLAMAR MAS TARDE',
  'no molestar': 'NO MOLESTAR',
  'reclamo': 'RECLAMO',
  'cliente escribe': 'CLIENTE ESCRIBE',
  'error en respuesta': 'ERROR EN RESPUESTA',
};
const norm = (s) => (s || '').toString().trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function outcomeFromMessage(m) {
  const attrs = m.attributes || {};
  const fa = attrs.flowAttributes || {};
  // Authoritative: the raw OpenAI JSON the flow stored (respuestaAIExito), then
  // other raw variants, then the message text.
  const o = parseOutcomeFromString(fa.respuestaAIExito)
    || parseOutcomeFromString(attrs._raw_message)
    || parseOutcomeFromString(m.text);
  let finalizar = o ? o.finalizar : (fa.finalizar === true || fa.finalizar === 'true');
  let motivo = (o && o.motivo) || (fa.motivo || '').toString().trim();
  const intent = attrs.intentName || attrs?.intent_info?.intent_name || null;
  const finish = typeof m.text === 'string' && m.text.trim() === FINISH_SENTINEL;
  // Reinforcement: terminal-ish turn without a captured motivo -> infer from the
  // executing block/intent name so the report shows the real edge (not "(sin motivo)").
  if ((finish || finalizar) && !motivo && intent) {
    const mapped = INTENT_TO_MOTIVO[norm(intent)];
    if (mapped) { motivo = mapped; finalizar = true; }
  }
  return {
    finalizar: !!finalizar,
    motivo,
    intent,
    finish,
    source: o ? 'raw' : (motivo ? 'intent' : 'none'),
  };
}

// Inspect a collected bot turn: did the flow reach a terminal reason this turn?
function detectTurnOutcome(botMessages) {
  let terminal = null;
  let finish = false;
  const intents = [];
  for (const m of botMessages) {
    const o = outcomeFromMessage(m);
    if (o.intent) intents.push(o.intent);
    if (o.finish) finish = true;
    if (o.finalizar || (o.motivo && o.motivo.length)) terminal = o;
  }
  // Saw the FINISH sentinel but no motivo captured — still terminal.
  if (!terminal && finish) terminal = { finalizar: true, motivo: '', finish: true };
  return { terminal, intents, finish };
}

// A control/sentinel message that must not be shown to the simulated user.
function isControlMessage(m) {
  return typeof m.text === 'string' && m.text.trim() === FINISH_SENTINEL;
}

module.exports = { TiledeskDriver, detectTurnOutcome, outcomeFromMessage, parseOutcomeFromString, isControlMessage, sleep };
