const { Filler } = require('../Filler');
const { TiledeskChatbot } = require('../../engine/TiledeskChatbot');
const { TiledeskChatbotUtil } = require('../../utils/TiledeskChatbotUtil');
const winston = require('../../utils/winston');
let axios = require('axios');
const { Logger } = require('../../Logger');

class DirWebResponse {

  constructor(context) {
    if (!context) {
      throw new Error('context object is mandatory.');
    }
    this.context = context;
    this.projectId = context.projectId;
    this.requestId = context.requestId;
    this.token = context.token;
    this.tdcache = context.tdcache;
    
    this.logger = new Logger({ request_id: this.requestId, dev: this.context.supportRequest?.draft, intent_id: this.context.reply?.intent_id || this.context.reply?.attributes?.intent_info?.intent_id });
  }

  execute(directive, callback) {
    winston.debug("Execute WebResponse directive: ", directive);
    let action;
    if (directive.action) {
      action = directive.action;
    }
    else {
      this.logger.error("Incorrect action for ", directive.name, directive)
      winston.debug("DirWebResponse Incorrect directive: ", directive);
      callback();
      return;
    }
    this.go(action, () => {
      this.logger.native("[Web Response] Executed");
        callback();
    });
  }

  async go(action, callback) {
    winston.debug("DirWebResponse action: ", action);
    
    if (!this.tdcache) {
      winston.error("DirWebResponse Error: tdcache is mandatory");
      callback();
      return;
    }
    
    let requestAttributes = null;
    requestAttributes = 
      await TiledeskChatbot.allParametersStatic(
        this.tdcache, this.requestId
        );
    
    const filler = new Filler();
    const filled_status = filler.fill(action.status, requestAttributes);

    const topic = `/webhooks/${this.requestId}`;

    // Build the response payload. If the configured JSON body is invalid
    // (after variable substitution), getJsonFromAction rejects. Previously
    // that rejection escaped uncaught: the process logged an
    // UnhandledPromiseRejection, `callback()` never fired, and — critically —
    // nothing was ever published to the topic, so the synchronous webhook
    // caller hung with no body. Catch it here and publish a 502 error
    // response instead, so the caller actually sees what went wrong.
    let json;
    try {
      json = await this.getJsonFromAction(action, filler, requestAttributes);
    }
    catch (err) {
      const message = (typeof err === 'string')
        ? err
        : (err && err.message ? err.message : 'Error building web response');

      // Block (intent) display name where the failure happened — the single
      // most useful pointer so the operator doesn't have to scan the flow.
      const blockName = this.context && this.context.reply && this.context.reply.attributes && this.context.reply.attributes.intent_info
        ? this.context.reply.attributes.intent_info.intent_name
        : null;
      const filledBody = (err && err.filledBody != null) ? String(err.filledBody) : undefined;
      const detail = (err && err.parseError) ? err.parseError : undefined;
      const unresolved = this._unresolvedVariables(action && action.payload, filledBody, requestAttributes);

      const payload = {
        success: false,
        error: 'flow_response_error',
        message: message,
        block: blockName,
        directive: 'web_response'
      };
      if (detail) payload.detail = detail;
      if (unresolved.length) payload.unresolvedVariables = unresolved;
      if (filledBody !== undefined) {
        payload.body = filledBody.length > 1000 ? (filledBody.slice(0, 1000) + '…') : filledBody;
      }

      // Human-readable summary reused for the flowError param (route timeout
      // path) and the ops log line.
      const summary = `[block: ${blockName || 'web_response'}] ${message}`
        + (unresolved.length ? ` | unresolved vars: ${unresolved.join(', ')}` : '')
        + (detail ? ` | ${detail}` : '');

      try { await TiledeskChatbot.addParameterStatic(this.tdcache, this.requestId, "flowError", summary); } catch (e) { /* best effort */ }
      const errorResponse = { status: 502, payload: payload };
      try {
        this.tdcache.publish(topic, JSON.stringify(errorResponse));
        winston.error("(DirWebResponse) flow error surfaced to webhook response: " + summary + (filledBody !== undefined ? ` | body: ${payload.body}` : ''));
      }
      catch (e) {
        winston.error("(DirWebResponse) failed publishing error response: ", e);
      }
      callback();
      return;
    }

    let webResponse = {
      status: filled_status,
      payload: json
    }

    this.logger.native("[Web Response] payload: ", webResponse);

    try {
      this.tdcache.publish(topic, JSON.stringify(webResponse));
      winston.verbose("DirWebResponse Published webresponse to topic: " + topic);
    }
    catch(e) {
      winston.error("DirWebResponse Error: ", e)
    }

    callback();

  }

  /**
   * Best-effort detection of variables referenced in the body template that
   * did not resolve. Two signals:
   *   1. Tokens in the raw template (`${name}` legacy, `{{ name }}` Liquid)
   *      whose top-level key is absent from the request attributes.
   *   2. Any `${name}` still present verbatim in the filled output — the
   *      legacy filler leaves these untouched when the key is missing.
   * A missing variable typically renders to empty (Liquid) or stays literal
   * (legacy), which is exactly what breaks the JSON.
   */
  _unresolvedVariables(template, filledBody, params) {
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

  async getJsonFromAction(action, filler, requestAttributes) {
  
      return new Promise( async (resolve, reject) => {
  
        if (action.payload && action.bodyType == "json") {
          let jsonBody = filler.fill(action.payload, requestAttributes);
          try {
            let json = JSON.parse(jsonBody);
            resolve(json);
          }
          catch (err) {
            winston.error("Error parsing webRequest jsonBody: " + JSON.stringify(jsonBody) + "\nError: " + JSON.stringify(err));
            this.logger.error("[Web Response] Error parsing webRequest jsonBody ", jsonBody)
            // Reject with a structured error so the caller can report which
            // body failed and why (the substituted string + the JSON.parse
            // message are the two things that actually pinpoint the problem,
            // e.g. a missing variable that rendered to empty / left a `${x}`).
            const e = new Error("Error parsing jsonBody");
            e.filledBody = jsonBody;
            e.rawTemplate = action.payload;
            e.parseError = (err && err.message) ? err.message : String(err);
            reject(e);
          }
        }
        else {
          resolve(null);
        }
      })
  }

}

module.exports = { DirWebResponse };