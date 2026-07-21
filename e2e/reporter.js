// Report writer: terminal summary + persisted report.json + summary.txt + one
// transcript file per conversation (all of them, not just failures).

const fs = require('fs');
const path = require('path');

// Classify a single run outcome.
function classify(o) {
  if (o.status === 'error') return 'error';
  if (o.status !== 'terminated') return 'no-termination';
  return o.expected && o.expected.includes(o.motivo) ? 'ok' : 'wrong-edge';
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function buildSummary({ config, list, outcomes }) {
  const lines = [];
  lines.push(`Suite E2E — bot ${config.botId} @ ${config.baseUrl}  (flujo: ${config.draft ? 'DRAFT' : 'PUBLICADO'})`);
  lines.push(`Escenarios: ${list.length} · runs c/u: ${config.runs} · umbral: ${Math.round(config.threshold * 100)}% · modelo sim: ${config.sim.model}`);
  lines.push('');
  lines.push(pad('Escenario', 30) + pad('runs', 6) + pad('éxito', 7) + pad('tasa', 7) + 'detalle');
  lines.push('-'.repeat(96));
  let allPass = true;
  for (const s of list) {
    const rs = outcomes.filter((o) => o.scenarioId === s.id);
    const dist = {}; let success = 0, turnsSum = 0, turnsN = 0;
    for (const o of rs) {
      const c = classify(o);
      if (c === 'ok') { success++; dist[o.motivo] = (dist[o.motivo] || 0) + 1; }
      else if (c === 'wrong-edge') { const k = o.motivo || '(sin motivo)'; dist[k] = (dist[k] || 0) + 1; }
      else if (c === 'error') dist['(error)'] = (dist['(error)'] || 0) + 1;
      else dist['(sin cierre)'] = (dist['(sin cierre)'] || 0) + 1;
      if (typeof o.turns === 'number') { turnsSum += o.turns; turnsN++; }
    }
    const rate = rs.length ? success / rs.length : 0;
    const pass = rate >= config.threshold; if (!pass) allPass = false;
    const distStr = Object.entries(dist).map(([k, v]) => `${k}×${v}`).join(', ');
    lines.push(pad(s.id, 30) + pad(rs.length, 6) + pad(success, 7) + pad(`${Math.round(rate * 100)}%`, 6) +
      (pass ? '✅ ' : '⚠️ ') + distStr + (turnsN ? `  · turnos~${(turnsSum / turnsN).toFixed(1)}` : ''));
  }
  lines.push('-'.repeat(96));
  const totalSuccess = outcomes.filter((o) => classify(o) === 'ok').length;
  const overall = outcomes.length ? totalSuccess / outcomes.length : 0;
  lines.push(`TOTAL: ${totalSuccess}/${outcomes.length} (${Math.round(overall * 100)}%)  ·  umbral ${Math.round(config.threshold * 100)}%  ->  ${allPass ? 'PASS ✅' : 'FAIL ❌'}`);
  return { text: lines.join('\n'), allPass, overall };
}

function transcriptText(o, scenario) {
  const lines = [
    `Escenario : ${o.scenarioId}  (run ${o.run + 1})`,
    `Persona   : ${scenario ? scenario.persona : '-'}`,
    `Esperado  : ${scenario ? scenario.expected.join(' | ') : '-'}`,
    `Resultado : ${classify(o)}   ·   motivo=${o.motivo || '-'}   ·   turnos=${o.turns}`,
    `Aristas   : ${(o.intents || []).join(' > ') || '-'}`,
  ];
  if (o.error) lines.push(`Error     : ${o.error}`);
  lines.push('', '--- Conversación ---');
  for (const t of (o.transcript || [])) lines.push(`${t.from === 'bot' ? 'BOT  ' : 'USER '}| ${t.text}`);
  return lines.join('\n');
}

function writeReport(dir, { config, list, outcomes, startedAt }) {
  fs.mkdirSync(dir, { recursive: true });
  const summary = buildSummary({ config, list, outcomes });
  fs.writeFileSync(path.join(dir, 'summary.txt'), summary.text + '\n');

  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  for (const o of outcomes) {
    const label = classify(o);
    const fname = `${o.scenarioId}__run${String(o.run + 1).padStart(2, '0')}__${label}.txt`;
    fs.writeFileSync(path.join(dir, fname), transcriptText(o, byId[o.scenarioId]) + '\n');
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      baseUrl: config.baseUrl, projectId: config.projectId, botId: config.botId,
      draft: config.draft, runs: config.runs, threshold: config.threshold, simModel: config.sim.model,
    },
    allPass: summary.allPass,
    overallRate: summary.overall,
    scenarios: list.map((s) => {
      const rs = outcomes.filter((o) => o.scenarioId === s.id);
      const success = rs.filter((o) => classify(o) === 'ok').length;
      const rate = rs.length ? success / rs.length : 0;
      return {
        id: s.id, expected: s.expected, successRate: rate, pass: rate >= config.threshold,
        runs: rs.map((o) => ({ run: o.run + 1, status: o.status, result: classify(o), motivo: o.motivo || null, intents: o.intents || [], turns: o.turns, error: o.error || null })),
      };
    }),
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return summary;
}

module.exports = { writeReport, buildSummary, classify };
