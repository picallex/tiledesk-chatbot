const { TiledeskChatbot } = require('../engine/TiledeskChatbot');
const winston = require('../utils/winston');

const MAX_BODY_LEN = 1000;

function unresolvedVariables(template, filledBody, params) {
  const found = new Set();
  const has = (name) => {
    if (!params) return false;
    const top = String(name).split('.')[0].split('[')[0].trim();
    return params[top] !== undefined;
  };
  if (typeof template === 'string') {
    (template.match(/\$\{[^}]+\}/g) || []).forEach((t) => {
      const name = t.slice(2, -1).trim();
      if (!has(name)) found.add(name);
    });
    (template.match(/\{\{\s*[^}|]+\s*\}\}/g) || []).forEach((t) => {
      const name = t.replace(/[{}]/g, '').trim();
      if (name && !has(name)) found.add(name);
    });
  }
  if (typeof filledBody === 'string') {
    (filledBody.match(/\$\{[^}]+\}/g) || []).forEach((t) => found.add(t.slice(2, -1).trim()));
  }
  return Array.from(found);
}

function blockNameFromContext(context) {
  return context && context.reply && context.reply.attributes && context.reply.attributes.intent_info
    ? context.reply.attributes.intent_info.intent_name
    : null;
}

async function publishFlowError(opts) {
  const tdcache = opts.tdcache;
  const requestId = opts.requestId;
  const directive = opts.directive;
  const message = opts.message;
  const filledBody = (opts.filledBody != null) ? String(opts.filledBody) : undefined;
  const parseError = opts.parseError;
  const blockName = blockNameFromContext(opts.context);
  const unresolved = unresolvedVariables(opts.template, filledBody, opts.params);

  const payload = {
    success: false,
    error: 'flow_response_error',
    message: message,
    block: blockName,
    directive: directive
  };
  if (parseError) payload.detail = parseError;
  if (unresolved.length) payload.unresolvedVariables = unresolved;
  if (filledBody !== undefined) {
    payload.body = filledBody.length > MAX_BODY_LEN ? (filledBody.slice(0, MAX_BODY_LEN) + '…') : filledBody;
  }

  const summary = `[block: ${blockName || directive}] ${message}`
    + (unresolved.length ? ` | unresolved vars: ${unresolved.join(', ')}` : '')
    + (parseError ? ` | ${parseError}` : '');

  if (!tdcache) {
    return;
  }

  try { await TiledeskChatbot.addParameterStatic(tdcache, requestId, "flowError", summary); } catch (e) { /* best effort */ }
  try {
    tdcache.publish(`/webhooks/${requestId}`, JSON.stringify({ status: 502, payload: payload }));
    winston.error("(FlowError) flow error surfaced to webhook response: " + summary + (filledBody !== undefined ? ` | body: ${payload.body}` : ''));
  } catch (e) {
    winston.error("(FlowError) failed publishing error response: ", e);
  }
}

module.exports = { publishFlowError, unresolvedVariables };
