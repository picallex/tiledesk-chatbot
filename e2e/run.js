#!/usr/bin/env node
// Runner E2E multi-flujo. El driver, el cliente simulado y el reporte son genéricos;
// lo específico de cada tipo de bot vive en flows/<flow>/flow.js (escenarios +
// detección + payload). Se elige con --flow, y el bot con --project/--bot (o env).
//
// Uso:
//   node run.js                                  # flujo por defecto, sus 8 escenarios
//   node run.js --flow schedule-appointment             # elegir tipo de flujo
//   node run.js --project <projId> --bot <botId> # correr contra OTRO bot del mismo tipo
//   node run.js --scenario reclamo               # filtra escenarios por id
//   node run.js --runs 10 --threshold 0.7
//   node run.js --draft                          # flujo DRAFT
//   node run.js --debug
//   node run.js --list                           # lista escenarios del flujo
//   node run.js --flows                          # lista tipos de flujo disponibles

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { TiledeskDriver, detectTurnOutcome, isControlMessage } = require('./driver');
const { nextUserMessage } = require('./simulated-user');
const { writeReport } = require('./reporter');

const FLOWS_DIR = path.join(__dirname, 'flows');
const DEFAULT_FLOW = process.env.E2E_FLOW || 'schedule-appointment';

function listFlows() {
  try {
    return fs.readdirSync(FLOWS_DIR).filter((d) => fs.existsSync(path.join(FLOWS_DIR, d, 'flow.js')));
  } catch { return []; }
}
function loadFlow(id) {
  const file = path.join(FLOWS_DIR, id, 'flow.js');
  if (!fs.existsSync(file)) return null;
  return require(file);
}

function parseArgs(argv) {
  const a = { flow: DEFAULT_FLOW, project: null, bot: null, scenario: null, runs: null,
    threshold: null, concurrency: null, draft: false, debug: false, list: false, flows: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--flow') a.flow = argv[++i];
    else if (t === '--project') a.project = argv[++i];
    else if (t === '--bot') a.bot = argv[++i];
    else if (t === '--scenario') a.scenario = argv[++i];
    else if (t === '--runs') a.runs = Number(argv[++i]);
    else if (t === '--threshold') a.threshold = Number(argv[++i]);
    else if (t === '--concurrency') a.concurrency = Number(argv[++i]);
    else if (t === '--draft') a.draft = true;
    else if (t === '--debug') a.debug = true;
    else if (t === '--list') a.list = true;
    else if (t === '--flows') a.flows = true;
  }
  return a;
}

// Run one full conversation. Returns { status, motivo, turns, intents, error, transcript }.
async function runConversation(cfg, scenario, debug) {
  const driver = new TiledeskDriver(cfg, { debug });
  const transcript = [];
  const intents = [];
  const done = (o) => ({ transcript, intents, ...o });
  try {
    await driver.signin();
    driver.newConversation();
    driver.messagePayload = { ...cfg.messagePayload, ...(scenario.payload || {}) };
    transcript.push({ from: 'user', text: cfg.opener });
    await driver.sendUserMessage(cfg.opener);

    let turns = 0;
    let botMsgs = await driver.waitForBotTurn();
    if (!botMsgs.length) return done({ status: 'error', error: 'no bot reply to opener', turns });

    while (turns < cfg.maxTurns) {
      for (const m of botMsgs) if (!isControlMessage(m, cfg.detection)) transcript.push({ from: 'bot', text: m.text || '' });
      const { terminal, intents: turnIntents } = detectTurnOutcome(botMsgs, cfg.detection);
      intents.push(...turnIntents);
      if (terminal && (terminal.finalizar || terminal.motivo)) {
        return done({ status: 'terminated', motivo: terminal.motivo || '', turns });
      }
      const userMsg = await nextUserMessage(cfg, scenario, transcript);
      transcript.push({ from: 'user', text: userMsg });
      await driver.sendUserMessage(userMsg);
      turns++;
      botMsgs = await driver.waitForBotTurn();
      if (!botMsgs.length) return done({ status: 'no-termination', turns });
    }
    return done({ status: 'no-termination', turns });
  } catch (e) {
    return done({ status: 'error', error: e.message, turns: transcript.filter((t) => t.from === 'user').length });
  }
}

// Concurrency pool.
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.max(1, limit) }, async () => {
    while (idx < items.length) { const i = idx++; results[i] = await worker(items[i], i); }
  }));
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();

  if (args.flows) {
    console.log('Tipos de flujo disponibles:');
    for (const id of listFlows()) { const f = loadFlow(id); console.log(`  - ${id}${f && f.label ? '  —  ' + f.label : ''}`); }
    return;
  }

  const flow = loadFlow(args.flow);
  if (!flow) {
    console.error(`✗ Flujo "${args.flow}" no encontrado. Disponibles: ${listFlows().join(', ') || '(ninguno)'}`);
    process.exit(2);
  }

  // Resolver bot/opener/payload/detection: CLI > env > flow.
  config.flowId = flow.id;
  config.flowLabel = flow.label;
  config.projectId = args.project || config.projectId || flow.defaults.projectId;
  config.botId = args.bot || config.botId || flow.defaults.botId;
  config.opener = config.opener || flow.opener || '/start';
  config.messagePayload = flow.messagePayload || {};
  config.detection = flow.detection || {};
  if (args.draft) config.draft = true;
  if (args.runs) config.runs = args.runs;
  if (args.threshold != null) config.threshold = args.threshold;
  if (args.concurrency) config.concurrency = args.concurrency;

  let list = flow.scenarios || [];
  if (args.scenario) list = list.filter((s) => s.id.includes(args.scenario));

  if (args.list) {
    console.log(`Escenarios del flujo "${flow.id}":`);
    for (const s of flow.scenarios) console.log(`  - ${s.id}  (espera: ${s.expected.join(' | ') || '—'})`);
    return;
  }
  if (!list.length) { console.error(`No hay escenarios que coincidan con "${args.scenario}"`); process.exit(2); }
  if (!config.sim.apiKey) {
    console.error('✗ Falta OPENAI_API_KEY (para el cliente simulado). Exportala y reintentá:\n    export OPENAI_API_KEY=sk-...');
    process.exit(2);
  }

  console.log(`\nSuite E2E — flujo "${flow.id}" (${flow.label || ''})`);
  console.log(`Bot ${config.botId} · proyecto ${config.projectId} · ${config.draft ? 'DRAFT' : 'PUBLICADO'} @ ${config.baseUrl}`);
  console.log(`Escenarios: ${list.length} · runs c/u: ${config.runs} · umbral: ${Math.round(config.threshold * 100)}% · concurrencia: ${config.concurrency}\n`);

  const tasks = [];
  for (const s of list) for (let r = 0; r < config.runs; r++) tasks.push({ s, r });
  let done = 0;
  const outcomes = await pool(tasks, config.concurrency, async ({ s, r }) => {
    const res = await runConversation(config, s, args.debug);
    done++;
    process.stdout.write(`\r  progreso: ${done}/${tasks.length}   `);
    return { scenarioId: s.id, run: r, expected: s.expected, ...res };
  });
  process.stdout.write('\n\n');

  const dir = path.join(__dirname, 'results', `${flow.id}__${startedAt.replace(/[:.]/g, '-')}`);
  const { text, allPass } = writeReport(dir, { config, list, outcomes, startedAt });
  console.log(text + '\n');
  console.log(`Reporte + transcripts en: ${path.relative(process.cwd(), dir)}/`);
  console.log('  · summary.txt   · report.json   · <escenario>__runNN__<resultado>.txt (uno por conversación)\n');

  const errs = outcomes.filter((o) => o.status === 'error').slice(0, 5);
  if (errs.length) {
    console.log('Errores (muestra):');
    for (const e of errs) console.log(`  - [${e.scenarioId}] ${e.error}`);
    console.log('');
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
