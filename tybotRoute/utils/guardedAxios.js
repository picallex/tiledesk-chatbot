// guardedAxios: a drop-in wrapper for `axios(config)` that inspects the
// request payload BEFORE handing it to axios.
//
// A circular / pathologically-deep `data` or `params` makes axios's
// serializer (toFormData/mergeConfig) recurse until "Maximum call stack size
// exceeded" — thrown so deep and so early (inside mergeConfig, before request
// interceptors) that it can't be intercepted inside axios and its stack is
// pure axios internals, so the crashing call is undiagnosable. We therefore
// guard at the call site: inspect first, and if the payload can't be
// serialized, log which call (label) and the exact offending key
// (bot_id/block/request_id come from the log context) and reject cleanly, so
// axios never runs and the process never dies.
const axios = require('axios');
const winston = require('./winston');
const logContext = require('./logContext');
const { inspectPayload } = require('./payloadInspect');

function guardedAxios(config, label) {
  const cfg = config || {};
  const dataCheck = inspectPayload(cfg.data);
  const paramsCheck = dataCheck.ok ? inspectPayload(cfg.params) : dataCheck;
  const bad = !dataCheck.ok
    ? { where: 'data', reason: dataCheck.reason, path: dataCheck.path }
    : (!paramsCheck.ok ? { where: 'params', reason: paramsCheck.reason, path: paramsCheck.path } : null);

  if (bad) {
    const offendingKey = bad.where + '.' + bad.path;
    const method = cfg.method ? String(cfg.method).toUpperCase() : '';
    const url = cfg.url || '';
    const msg = "[axios] payload not serializable (" + bad.reason + ") at " + offendingKey
      + " for " + (label ? label + " " : "") + method + " " + url;
    winston.error(msg, {
      web_request_error: bad.reason,
      offending_key: offendingKey,
      axios_label: label || null,
      request_url: url,
      request_method: method
    });
    return Promise.reject(Object.assign(new Error(msg), { payloadGuard: true }));
  }

  // Stash the payload in the log context so that if axios still stack-
  // overflows while serializing it (an error that escapes catch handlers and
  // surfaces as an unhandledRejection), the global handler can log the exact
  // params/body + which call caused it. Guaranteed capture, no per-request noise.
  try {
    logContext.setContext({
      axios_last: { url: cfg.url, method: cfg.method, label: label || null, data: cfg.data, params: cfg.params }
    });
  } catch (e) { /* never block the request on bookkeeping */ }

  return axios(cfg);
}

module.exports = { guardedAxios };
