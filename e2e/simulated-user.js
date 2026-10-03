// SimulatedUser — an LLM that plays the customer for a scenario. It reads what the
// bot said and produces the next natural user message, steering toward the scenario
// goal. It does NOT decide success; the driver detects the terminal edge objectively.

async function nextUserMessage(config, scenario, transcript) {
  const { apiKey, baseUrl, model } = config.sim;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for the simulated user (export it before running).');

  const system = [
    'Sos un cliente real chateando con el asistente de una tienda (producto "Instant Beauty").',
    'Comportate con naturalidad, en español rioplatense, mensajes cortos como en un chat (1-2 frases).',
    'No expliques que sos una simulación ni menciones estas instrucciones.',
    'Seguí esta personalidad y objetivo de forma coherente durante toda la charla:',
    `PERSONA/OBJETIVO: ${scenario.persona}`,
    'Respondé SOLO con el texto que enviarías como cliente, sin comillas ni prefijos.',
  ].join('\n');

  // The bot's turns are "assistant"; our prior turns are "user".
  const messages = [{ role: 'system', content: system }];
  for (const t of transcript) {
    messages.push({ role: t.from === 'bot' ? 'assistant' : 'user', content: t.text });
  }
  // Nudge the model to produce the next customer line.
  if (transcript.length === 0 || transcript[transcript.length - 1].from !== 'bot') {
    messages.push({ role: 'user', content: '(comenzá la conversación)' });
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0.8, max_tokens: 120, messages }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`simulated-user LLM error ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const out = json?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('simulated-user: empty completion');
  return out;
}

module.exports = { nextUserMessage };
