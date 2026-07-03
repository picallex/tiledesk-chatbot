// Per-execution logging context via AsyncLocalStorage.
//
// enterWith() sets the context for the current async execution (one bot
// execution / HTTP request) without wrapping the whole handler in a
// callback, so wiring an entrypoint is a single line. Every winston log
// emitted downstream in that async chain picks up the context
// automatically (see utils/winston.js), so individual log call sites
// (even deep ones like TiledeskExpression) don't need to pass ids around.
//
// setContext() merges fields into the current context — used to update the
// current block as the flow advances.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Start (or replace) the context for the current async execution.
function enterWith(ctx) {
  als.enterWith({ ...ctx });
}

// Merge fields into the current context (no-op if none is active).
function setContext(partial) {
  const store = als.getStore();
  if (store) {
    Object.assign(store, partial);
  }
}

function getContext() {
  return als.getStore();
}

module.exports = { als, enterWith, setContext, getContext };
