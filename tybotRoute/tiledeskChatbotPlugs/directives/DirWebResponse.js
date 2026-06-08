const { Filler } = require('../Filler');
const { TiledeskChatbot } = require('../../engine/TiledeskChatbot');
const { TiledeskChatbotUtil } = require('../../utils/TiledeskChatbotUtil');
const winston = require('../../utils/winston');
let axios = require('axios');
const { Logger } = require('../../Logger');
const { publishFlowError } = require('../FlowError');

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
      await publishFlowError({
        tdcache: this.tdcache,
        requestId: this.requestId,
        context: this.context,
        directive: 'web_response',
        message: message,
        template: action && action.payload,
        params: requestAttributes,
        filledBody: err && err.filledBody,
        parseError: err && err.parseError
      });
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