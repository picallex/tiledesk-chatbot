const axios = require("axios").default;
const { guardedAxios } = require('../../utils/guardedAxios');
const { TiledeskChatbot } = require("../../engine/TiledeskChatbot");
const { Filler } = require("../Filler");
const { DirIntent } = require("./DirIntent");
let https = require("https");
require('dotenv').config();
const winston = require('../../utils/winston');
const { Logger } = require("../../Logger");

class DirMake {

  constructor(context) {
    if (!context) {
      throw new Error('context object is mandatory');
    }
    this.context = context;
    this.tdcache = this.context.tdcache;
    this.requestId = this.context.requestId;
    
    this.intentDir = new DirIntent(context);
    this.logger = new Logger({ request_id: this.requestId, dev: this.context.supportRequest?.draft, intent_id: this.context.reply?.intent_id || this.context.reply?.attributes?.intent_info?.intent_id });
  }

  execute(directive, callback) {
    winston.verbose("Execute Make directive");
    let action;
    if (directive.action) {
      action = directive.action;
    }
    else {
      this.logger.error("Incorrect action for ", directive.name, directive)
      winston.warn("DirMake Incorrect directive: ", directive);
      callback();
      return;
    }
    this.go(action, (stop) => {
      this.logger.native("[Make] Executed");
      callback(stop);
    })
  }

  async go(action, callback) {
    winston.debug("(DirMake) Action: ", action);
    if (!this.tdcache) {
      winston.error("(DirMake) Error: tdcache is mandatory");
      callback();
      return;
    }

    let trueIntent = action.trueIntent;
    let falseIntent = action.falseIntent;
    let trueIntentAttributes = action.trueIntentAttributes;
    let falseIntentAttributes = action.falseIntentAttributes;

    // default values?
    let status = null;
    let error = null;

    let requestVariables = null;
    requestVariables =
      await TiledeskChatbot.allParametersStatic(
        this.tdcache, this.requestId
      )

    let webhook_url = action.url;
    let bodyParameters = action.bodyParameters;

    winston.debug("(DirMake) webhook_url: " + webhook_url);

    if (!bodyParameters) {
      winston.error("(DirMake) Error: bodyParameters is undefined");
      error = "Missing body parameters";
      await this.#assignAttributes(action, status, error);
      if (falseIntent) {
        await this.#executeCondition(false, trueIntent, trueIntentAttributes, falseIntent, falseIntentAttributes);
        callback(true);
        return;
      }
      callback();
      return;
    }

    if (!webhook_url || webhook_url === '') {
      winston.error("(DirMake) Error: webhook_url is undefined or null or empty string:")
      let status = 422;   
      let error = 'Missing make webhook url';
      await this.#assignAttributes(action, status, error);
      if (falseIntent) {
        await this.#executeCondition(false, trueIntent, trueIntentAttributes, falseIntent, falseIntentAttributes);
        callback(true);
        return;
      }
      callback();
      return;
    }

    /**
     * process.env.MAKE_ENDPOINT is used for testing purposes only.
     * This variable must be not defined in Production Env.
    */
    let make_base_url = process.env.MAKE_ENDPOINT;
    let url;

    if (make_base_url) {
      url = make_base_url + "/make/";
    } else {
      url = action.url;
    }

    const filler = new Filler();
    for (const [key, value] of Object.entries(bodyParameters)) {
      let filled_value = filler.fill(value, requestVariables);
      bodyParameters[key] = filled_value;
    }

    const MAKE_HTTPREQUEST = {
      url: url,
      headers: {
        'Content-Type': 'application/json'
      },
      json: bodyParameters,
      method: "POST"
    }
    winston.debug("(DirMake) Make HttpRequest ", MAKE_HTTPREQUEST);
    this.#myrequest(
      MAKE_HTTPREQUEST, async (err, res) => {
        if (err) {
          if (callback) {
            winston.error("(DirMake) err: ", err);
            // let status = 404;
            // let error = 'Make url not found';
            status = res.status;
            error = res.error;
            await this.#assignAttributes(action, status, error);
            if (falseIntent) {
              await this.#executeCondition(false, trueIntent, trueIntentAttributes, falseIntent, falseIntentAttributes);
              callback(true);
              return;
            }
            callback();
            return;
          }
        } else if (callback) {
          winston.debug("(DirMake)  resbody ", res);

          status = res.status;
          error = null;
          if (res.error) {
            error = res.error
          }
          await this.#assignAttributes(action, status, error);
          if (trueIntent) {
            await this.#executeCondition(true, trueIntent, trueIntentAttributes, falseIntent, falseIntentAttributes);
              callback(true);
              return;
          }
          callback();
          return;
        }
      }
    );

  }

  async #assignAttributes(action, status, error) {
    winston.debug("(DirMake) assignAttributes action: ", action)
    winston.debug("(DirMake) assignAttributes status: " + status)
    winston.debug("(DirMake) assignAttributes error: ", error)

    if (this.context.tdcache) {
      if (action.assignStatusTo) {
        await TiledeskChatbot.addParameterStatic(this.context.tdcache, this.context.requestId, action.assignStatusTo, status);
      }
      if (action.assignErrorTo) {
        await TiledeskChatbot.addParameterStatic(this.context.tdcache, this.context.requestId, action.assignErrorTo, error);
      }
    }
  }

  // Advanced #myrequest function
  #myrequest(options, callback) {
    let axios_options = {
      url: options.url,
      method: options.method,
      params: options.params,
      headers: options.headers,
      timeout: 20000
    }
    if (options.json !== null) {
      axios_options.data = options.json
    }
    if (options.url.startsWith("https:")) {
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });
      axios_options.httpsAgent = httpsAgent;
    }
    guardedAxios(axios_options, "DirMake")
      .then((res) => {
        if (callback) {
          callback(null, res);
        }

      })
      .catch((err) => {
        // Extract only safe scalar fields. Do NOT JSON.stringify(err): an
        // AxiosError's toJSON serializes the whole config/request/response
        // via axios's recursive walker, which stack-overflows on the deep
        // agent/socket/request graph ("Maximum call stack size exceeded").
        if (callback) {
          const status = (err && err.response && typeof err.response.status === 'number') ? err.response.status : 1000;
          const errorMessage = (err && err.message) ? String(err.message) : 'web request failed';
          const data = (err && err.response) ? err.response.data : null;
          callback(null, { status: status, data: data, error: errorMessage });
        }
      });
  }

  async #executeCondition(result, trueIntent, trueIntentAttributes, falseIntent, falseIntentAttributes, callback) {
    let trueIntentDirective = null;
    if (trueIntent) {
      trueIntentDirective = DirIntent.intentDirectiveFor(trueIntent, trueIntentAttributes);
    }
    let falseIntentDirective = null;
    if (falseIntent) {
      falseIntentDirective = DirIntent.intentDirectiveFor(falseIntent, falseIntentAttributes);
    }
    if (result === true) {
      if (trueIntentDirective) {
        this.intentDir.execute(trueIntentDirective, () => {
          if (callback) {
            callback();
          }
        });
      }
      else {
        winston.debug("(DirMake) No trueIntentDirective specified");
        if (callback) {
          callback();
        }
      }
    }
    else {
      if (falseIntentDirective) {
        this.intentDir.execute(falseIntentDirective, () => {
          if (callback) {
            callback();
          }
        });
      }
      else {
        winston.debug("(DirMake) No falseIntentDirective specified");
        if (callback) {
          callback();
        }
      }
    }
  }
}

module.exports = { DirMake }