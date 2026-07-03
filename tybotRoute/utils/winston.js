require('dotenv').config();
// Capture deeper stacks. The default of 10 frames shows only the innermost
// axios recursion on a "Maximum call stack size exceeded" and hides where it
// was actually called from / what recursed. 100 frames reveals the pattern
// (axios-internal vs bot-engine recursion) without bloating normal logs.
Error.stackTraceLimit = 100;
var appRoot = require('app-root-path');
var winston = require('winston');
var { getContext } = require('./logContext');
var { safePreview, isStackOverflow } = require('./payloadInspect');
var level = process.env.LOG_LEVEL || "info";

// Merge the per-execution context (bot/project/execution ids + current
// block) into every log record. Reads AsyncLocalStorage, so no call site
// needs to pass ids. See utils/logContext.js.
var injectContext = winston.format(function (info) {
  var ctx = getContext();
  if (ctx) {
    if (ctx.bot_id) info.bot_id = ctx.bot_id;
    if (ctx.project_id) info.project_id = ctx.project_id;
    if (ctx.execution_id) info.execution_id = ctx.execution_id;
    if (ctx.request_id) info.request_id = ctx.request_id;
    if (ctx.block) info.block = ctx.block;
  }
  return info;
});

var options = {
  file: {
    level:level ,
    filename: `${appRoot}/logs/app.log`,
    json: false,
    maxsize: 5242880, // 5MB
    maxFiles: 5,
    colorize: false,
    format: winston.format.simple()
  },
  console: {
    level: level,
    // JSON so the log shipper (Vector) parses fields into columns in
    // OpenObserve (bot_id, project_id, execution_id, block, ...).
    format: winston.format.combine(
      injectContext(),
      winston.format.timestamp(),
      winston.format.json()
    )
  },
};

let logger = winston.createLogger({    
  transports: [
   new (winston.transports.Console)(options.console),
   new (winston.transports.File)(options.file),
  ],
  exitOnError: false, // do not exit on handled exceptions
});

logger.stream = {
  write: function(message, encoding) {
    logger.info(message);
  },
};

// On a "Maximum call stack size exceeded", the stack is pure axios internals
// (the app frame is buried under ~10k recursion frames) so it tells us
// nothing. The real context — which axios call and what payload triggered it
// — is stashed in the log context by guardedAxios / DirWebRequestV2 right
// before the call. Read it back here so the crash log carries the offending
// URL + params/body (cycle-safe preview, so a circular payload shows its
// shape and where the cycle is). bot_id/block/request_id are added by
// injectContext.
function overflowContext(err) {
  if (!isStackOverflow(err)) return {};
  try {
    var ctx = getContext();
    var last = ctx && ctx.axios_last;
    if (!last) return { overflow_axios: 'no axios payload stashed (overflow outside a guarded axios call)' };
    return {
      overflow_axios_label: last.label || null,
      overflow_axios_url: last.url || null,
      overflow_axios_method: last.method || null,
      overflow_payload_preview: safePreview(last.data, 6000),
      overflow_params_preview: safePreview(last.params, 2000)
    };
  } catch (e) {
    return { overflow_axios: 'context read failed: ' + ((e && e.message) || e) };
  }
}

// Global crash handlers. We log these explicitly (instead of winston's
// built-in handleExceptions) so the record is clean JSON carrying the full
// stack trace + (for stack overflows) the axios payload that caused it.
// exitOnError:false semantics are preserved: we log and keep the process up.
process.on('uncaughtException', function (err) {
  try {
    logger.error('uncaughtException: ' + ((err && err.message) || err), Object.assign({
      err_type: 'uncaughtException',
      stack: (err && err.stack) || undefined
    }, overflowContext(err)));
  } catch (e) {
    // Last resort if logging itself fails during the crash.
    console.error('uncaughtException (logger failed):', err && err.stack ? err.stack : err);
  }
});

process.on('unhandledRejection', function (reason) {
  var e = reason instanceof Error ? reason : new Error(String(reason));
  try {
    logger.error('unhandledRejection: ' + e.message, Object.assign({
      err_type: 'unhandledRejection',
      stack: e.stack
    }, overflowContext(e)));
  } catch (err) {
    console.error('unhandledRejection (logger failed):', e.stack);
  }
});


module.exports = logger;
