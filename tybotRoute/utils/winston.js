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
    handleExceptions: true,
    json: false,
    maxsize: 5242880, // 5MB
    maxFiles: 5,
    colorize: false,
    format: winston.format.simple()
  },
  console: {
    level: level,
    handleExceptions: true,
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


module.exports = logger;
