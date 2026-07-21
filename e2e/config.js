// Configuración GENÉRICA de la suite (no depende del bot). Lo específico de cada
// tipo de bot vive en flows/<flow>/flow.js. project/bot/opener/messagePayload/detection
// los resuelve run.js combinando: CLI (--project/--bot) > env > el flow seleccionado.

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));

const config = {
  // Stack de Tiledesk (proxy dev).
  baseUrl: process.env.E2E_BASE_URL || 'http://localhost:8090/api',

  // Bot a testear. Si quedan null, run.js toma los defaults del flow.
  projectId: process.env.E2E_PROJECT_ID || null,
  botId: process.env.E2E_BOT_ID || null,
  departmentId: process.env.E2E_DEPARTMENT_ID || '',
  draft: bool(process.env.E2E_DRAFT, false),
  opener: process.env.E2E_OPENER || null,      // si null, usa flow.opener (o "/start")

  // Parámetros de corrida.
  runs: num(process.env.E2E_RUNS, 5),
  threshold: num(process.env.E2E_THRESHOLD, 0.8),
  maxTurns: num(process.env.E2E_MAX_TURNS, 10),
  concurrency: num(process.env.E2E_CONCURRENCY, 2),

  // Polling / tiempos (ms).
  pollMs: num(process.env.E2E_POLL_MS, 800),
  quietMs: num(process.env.E2E_QUIET_MS, 3500),       // gap sin nuevo msg del bot => turno cerrado
  turnTimeoutMs: num(process.env.E2E_TURN_TIMEOUT_MS, 45000),

  // Cliente simulado (LLM que interpreta al cliente).
  sim: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.E2E_SIM_ENDPOINT || 'https://api.openai.com/v1',
    model: process.env.E2E_SIM_MODEL || 'gpt-4.1-mini',
  },

  // Inyectados por run.js desde el flow seleccionado:
  messagePayload: {},   // vars {{payload.message.*}}
  detection: {},        // { resultAttribute, finishSentinel, intentToMotivo }
  flowId: null,
  flowLabel: null,
};

module.exports = { config };
