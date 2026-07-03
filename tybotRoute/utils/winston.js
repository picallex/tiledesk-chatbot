require('dotenv').config();
var appRoot = require('app-root-path');
var winston = require('winston');
var { getContext } = require('./logContext');
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

// Global crash handlers. We log these explicitly (instead of winston's
// built-in handleExceptions) so the record is clean JSON carrying the full
// stack trace — the built-in handler emitted a degraded, stack-less line,
// especially on "Maximum call stack size exceeded". These fire outside any
// bot execution, so there's no request context (no bot_id/block); the stack
// is what locates the fault. exitOnError:false semantics are preserved: we
// log and let the process keep running.
process.on('uncaughtException', function (err) {
  try {
    logger.error('uncaughtException: ' + ((err && err.message) || err), {
      err_type: 'uncaughtException',
      stack: (err && err.stack) || undefined
    });
  } catch (e) {
    // Last resort if logging itself fails during the crash.
    console.error('uncaughtException (logger failed):', err && err.stack ? err.stack : err);
  }
});

process.on('unhandledRejection', function (reason) {
  var e = reason instanceof Error ? reason : new Error(String(reason));
  try {
    logger.error('unhandledRejection: ' + e.message, {
      err_type: 'unhandledRejection',
      stack: e.stack
    });
  } catch (err) {
    console.error('unhandledRejection (logger failed):', e.stack);
  }
});


module.exports = logger;
