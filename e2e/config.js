// Central configuration for the E2E bot test suite.
// Everything is overridable via env vars so the same suite runs against any
// project/bot/environment without code changes.

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));

const config = {
  // Tiledesk stack (the dev proxy).
  baseUrl: process.env.E2E_BASE_URL || 'http://localhost:8090/api',
  projectId: process.env.E2E_PROJECT_ID || '6a16f36e359f3a001200357b',
  botId: process.env.E2E_BOT_ID || '6a16f3b0359f3a00120035c6',
  // Optional: pin a department. If empty, participants:["bot_<id>"] drives routing.
  departmentId: process.env.E2E_DEPARTMENT_ID || '',
  // false = published flow (prod), true = draft (what you edit in CDS).
  draft: bool(process.env.E2E_DRAFT, false),

  // Conversation opener (first user message). "/start" triggers the welcome block.
  opener: process.env.E2E_OPENER || '/start',

  // Run parameters.
  runs: num(process.env.E2E_RUNS, 5),
  threshold: num(process.env.E2E_THRESHOLD, 0.8),
  maxTurns: num(process.env.E2E_MAX_TURNS, 10),
  concurrency: num(process.env.E2E_CONCURRENCY, 2),

  // Polling / timing (ms).
  pollMs: num(process.env.E2E_POLL_MS, 800),
  quietMs: num(process.env.E2E_QUIET_MS, 3500),      // gap with no new bot msg => turn done
  turnTimeoutMs: num(process.env.E2E_TURN_TIMEOUT_MS, 45000),

  // Simulated user (LLM playing the customer).
  sim: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.E2E_SIM_ENDPOINT || 'https://api.openai.com/v1',
    model: process.env.E2E_SIM_MODEL || 'gpt-4.1-mini',
  },

  // The terminal reasons the flow can end with (from the OpenAI Chat Prompt).
  knownMotivos: ['CONTACTAR YA', 'LLAMAR MAS TARDE', 'NO MOLESTAR', 'RECLAMO'],

  // Custom message payload exposed to the flow as {{payload.message.*}}.
  // These are NOT platform fields; the flow author defined them and in production
  // they come from the channel (e.g. the WhatsApp contact name). We inject them via
  // message.attributes.payload.message so the flow behaves as in prod. Each scenario
  // may override any key via its own `payload`.
  //
  // NOTE: preLeadId feeds the Picallex Salesforce directives (DirPicallexSf*). A
  // non-empty value can create/update real CRM records at terminal edges. Left empty
  // by default to avoid side effects — set E2E_PRELEAD_ID to a safe/sandbox id if you
  // want to exercise that path.
  messagePayload: {
    conversationName: process.env.E2E_CONVERSATION_NAME || 'Jorge 👨🏾‍🦲',
    preLeadId: process.env.E2E_PRELEAD_ID || '',
  },
};

module.exports = { config };
