#!/usr/bin/env node
// E2E bot test runner. Drives the real bot flow with an LLM-simulated customer,
// runs each scenario N times, and asserts a success-rate threshold per scenario
// (because OpenAI responses are non-deterministic).
//
// Usage:
//   node run.js                          # all scenarios, defaults
//   node run.js --scenario reclamo       # only scenarios whose id includes "reclamo"
//   node run.js --runs 10 --threshold 0.7
//   node run.js --draft                  # test the draft flow instead of published
//   node run.js --debug                  # verbose per-turn logging
//   node run.js --list                   # list scenarios and exit

const path = require('path');
const { config } = require('./config');
const { scenarios } = require('./scenarios');
const { TiledeskDriver, detectTurnOutcome, isControlMessage } = require('./driver');
const { nextUserMessage } = require('./simulated-user');
const { writeReport } = require('./reporter');

function parseArgs(argv) {
  const a = { scenario: null, runs: null, threshold: null, draft: false, debug: false, list: false, concurrency: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--scenario') a.scenario = argv[++i];
    else if (t === '--runs') a.runs = Number(argv[++i]);
    else if (t === '--threshold') a.threshold = Number(argv[++i]);
    else if (t === '--concurrency') a.concurrency = Number(argv[++i]);
    else if (t === '--draft') a.draft = true;
    else if (t === '--debug') a.debug = true;
    else if (t === '--list') a.list = true;
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
    // Per-scenario override of the {{payload.message.*}} flow variables.
    driver.messagePayload = { ...cfg.messagePayload, ...(scenario.payload || {}) };
    transcript.push({ from: 'user', text: cfg.opener });
    await driver.sendUserMessage(cfg.opener);

    let turns = 0;
    let botMsgs = await driver.waitForBotTurn();
    if (!botMsgs.length) return done({ status: 'error', error: 'no bot reply to opener', turns });

    while (turns < cfg.maxTurns) {
      for (const m of botMsgs) if (!isControlMessage(m)) transcript.push({ from: 'bot', text: m.text || '' });
      const { terminal, intents: turnIntents } = detectTurnOutcome(botMsgs);
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

// Simple concurrency pool.
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  if (args.draft) config.draft = true;
  if (args.runs) config.runs = args.runs;
  if (args.threshold != null) config.threshold = args.threshold;
  if (args.concurrency) config.concurrency = args.concurrency;

  let list = scenarios;
  if (args.scenario) list = scenarios.filter((s) => s.id.includes(args.scenario));

  if (args.list) {
    console.log('Escenarios:');
    for (const s of scenarios) console.log(`  - ${s.id}  (espera: ${s.expected.join(' | ') || '—'})`);
    return;
  }
  if (!list.length) { console.error(`No hay escenarios que coincidan con "${args.scenario}"`); process.exit(2); }
  if (!config.sim.apiKey) {
    console.error('✗ Falta OPENAI_API_KEY (para el usuario simulado). Exportala y reintentá:\n    export OPENAI_API_KEY=sk-...');
    process.exit(2);
  }

  console.log(`\nSuite E2E — bot ${config.botId} @ ${config.baseUrl}  (flujo: ${config.draft ? 'DRAFT' : 'PUBLICADO'})`);
  console.log(`Escenarios: ${list.length} · runs c/u: ${config.runs} · umbral: ${Math.round(config.threshold * 100)}% · concurrencia: ${config.concurrency}\n`);

  // Build the flat task list (scenario × runs) and execute with a concurrency pool.
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

  // Persist + print the report (terminal + files).
  const dir = path.join(__dirname, 'results', startedAt.replace(/[:.]/g, '-'));
  const { text, allPass } = writeReport(dir, { config, list, outcomes, startedAt });
  console.log(text + '\n');
  console.log(`Reporte + transcripts en: ${path.relative(process.cwd(), dir)}/`);
  console.log('  · summary.txt   · report.json   · <escenario>__runNN__<resultado>.txt (uno por conversación)\n');

  // Surface a few errors to help debugging.
  const errs = outcomes.filter((o) => o.status === 'error').slice(0, 5);
  if (errs.length) {
    console.log('Errores (muestra):');
    for (const e of errs) console.log(`  - [${e.scenarioId}] ${e.error}`);
    console.log('');
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
