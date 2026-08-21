const crypto = require('crypto');
const { FlowRun, FlowRunStep } = require('../models/flow_run');
const winston = require('../utils/winston');

const AUTOMATION_PREFIX = 'automation-request-';
const DEFAULT_TTL_DAYS = 30;
const DEFAULT_MAX_STEP_BYTES = 256 * 1024;
// Cuánto se guarda de un campo que se pasó del tope, para que el paso siga
// siendo legible en el monitor.
const TRUNCATED_PREVIEW_CHARS = 2000;

/**
 * FlowTraceStore — escritura de la traza de ejecución (flow_runs /
 * flow_run_steps). Ver external-weflow/docs/monitor-ejecucion.md.
 *
 * Todo es best-effort: un fallo acá se loguea y NUNCA corta el flujo. El motor
 * no lee nada de estas colecciones.
 *
 * Env:
 *   FLOW_TRACE_ENABLED          'false' para apagar la traza (default ON)
 *   FLOW_TRACE_SAMPLING         0..1, default 1. Determinista por request_id:
 *                               una corrida se traza entera o no se traza.
 *   FLOW_TRACE_TTL_DAYS         retención, default 30
 *   FLOW_TRACE_MAX_STEP_BYTES   tope por campo del paso, default 262144
 *   FLOW_TRACE_REDACT_KEYS      claves EXTRA a reemplazar por "[redacted]" (csv)
 *                               además de las que ya se sacan por default.
 *   FLOW_TRACE_KEEP_SYSTEM      'true' guarda también la plomería del motor
 *                               (tokens incluidos). Sólo para depurar el motor.
 */
class FlowTraceStore {

  static isEnabled() {
    return process.env.FLOW_TRACE_ENABLED !== 'false';
  }

  static kindOf(requestId) {
    return requestId && requestId.startsWith(AUTOMATION_PREFIX) ? 'automation' : 'bot';
  }

  /**
   * ¿Trazo esta corrida? El sampling se resuelve por hash del request_id, no
   * al azar: si no, una misma corrida quedaría con la mitad de los pasos.
   */
  static shouldTrace(requestId) {
    if (!this.isEnabled() || !requestId) return false;
    const raw = parseFloat(process.env.FLOW_TRACE_SAMPLING);
    const sampling = Number.isFinite(raw) ? raw : 1;
    if (sampling >= 1) return true;
    if (sampling <= 0) return false;
    const hash = crypto.createHash('md5').update(String(requestId)).digest();
    return (hash.readUInt32BE(0) / 0xffffffff) < sampling;
  }

  static ttlDate() {
    const days = parseInt(process.env.FLOW_TRACE_TTL_DAYS, 10) || DEFAULT_TTL_DAYS;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  static maxStepBytes() {
    return parseInt(process.env.FLOW_TRACE_MAX_STEP_BYTES, 10) || DEFAULT_MAX_STEP_BYTES;
  }

  /**
   * Plomería del motor: no la inyecta pcx ni la define el flujo, así que no
   * aporta nada al que lee la traza y encima confunde (y varias son
   * credenciales). Se SACAN, no se enmascaran: si no aportan, tampoco tienen
   * que estar en la base.
   *
   * Lo que SÍ queda: `payload` (lo que pcx manda al disparar un bot),
   * `attributes` (lo mismo en automatizaciones), las variables que define el
   * flujo, y los bodies/respuestas de los web request.
   */
  static systemKeys() {
    return [
      'tbottoken', 'chatbot_jwt_token', 'token', 'api_base_url', 'chatbot_id',
      'project_id', 'conversation_id', 'last_message_id', 'lastusermessagetype',
      'user_agent', 'user_source_page', 'user_language', 'chatchannel',
      'support_group_id', 'request_id', 'preloaded_request_id', 'departmentid',
      '_debug_delay_ms'
    ];
  }

  /**
   * Claves cuyo VALOR es un secreto en cualquier nivel (headers de un web
   * request, credenciales de una integración). Se matchea por substring: no hay
   * forma de enumerar los nombres que use cada flujo.
   */
  static secretKeyPattern() {
    return /token|jwt|secret|apikey|api_key|authorization|password|credential/i;
  }

  static redactKeys() {
    return (process.env.FLOW_TRACE_REDACT_KEYS || '')
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Deja el valor listo para guardar: saca la plomería del motor y los
   * secretos, aplica las claves extra de FLOW_TRACE_REDACT_KEYS y, si se pasa
   * del tope, lo reemplaza por un resumen con preview. Devuelve
   * `[valor, seTrunco]`.
   */
  static prepare(value) {
    if (value === undefined || value === null) return [value, false];
    let prepared = value;
    if (typeof value === 'object') {
      prepared = this._clean(value, this.redactKeys(), this.keepSystem());
    }
    let serialized;
    try {
      serialized = JSON.stringify(prepared);
    } catch (err) {
      return [{ _unserializable: String(err && err.message) }, true];
    }
    if (serialized && Buffer.byteLength(serialized, 'utf8') > this.maxStepBytes()) {
      return [{
        _truncated: true,
        _bytes: Buffer.byteLength(serialized, 'utf8'),
        preview: serialized.substring(0, TRUNCATED_PREVIEW_CHARS)
      }, true];
    }
    return [prepared, false];
  }

  /** Escape hatch para depurar el motor: FLOW_TRACE_KEEP_SYSTEM=true guarda todo. */
  static keepSystem() {
    return process.env.FLOW_TRACE_KEEP_SYSTEM === 'true';
  }

  static _clean(value, extraRedact, keepSystem, depth = 0) {
    if (depth > 12 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map(v => this._clean(v, extraRedact, keepSystem, depth + 1));
    }
    const system = this.systemKeys();
    const secret = this.secretKeyPattern();
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase();
      if (!keepSystem && (system.includes(lower) || secret.test(k))) {
        continue; // fuera de la traza: plomería o credencial
      }
      if (extraRedact.includes(lower)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = this._clean(v, extraRedact, keepSystem, depth + 1);
    }
    return out;
  }

  /**
   * Abre el paso: upsertea la cabecera de la corrida, toma el `seq` del
   * contador atómico e inserta el paso en estado 'running'. Devuelve el seq, o
   * null si no se pudo escribir (el llamador simplemente no cierra el paso).
   */
  static async beginStep(run, step) {
    try {
      const now = new Date();
      const expires = this.ttlDate();
      const header = await FlowRun.findOneAndUpdate(
        { request_id: run.requestId },
        {
          $inc: { steps_count: 1 },
          $set: {
            updated_at: now,
            last_status: 'running',
            last_directive_name: step.directiveName,
            expires_at: expires
          },
          $setOnInsert: {
            kind: this.kindOf(run.requestId),
            project_id: run.projectId,
            bot_id: run.botId,
            execution_id: run.executionId,
            started_at: now
          }
        },
        // Sin setDefaultsOnInsert: los defaults del schema chocarían con el
        // $inc/$set del mismo path en el insert.
        { new: true, upsert: true }
      ).lean();

      const seq = header ? header.steps_count : null;
      if (seq === null) return null;

      const [params, paramsTruncated] = this.prepare(step.params);
      const [directive, directiveTruncated] = this.prepare(step.directive);
      const truncated = [];
      if (paramsTruncated) truncated.push('params');
      if (directiveTruncated) truncated.push('directive');

      await FlowRunStep.create({
        request_id: run.requestId,
        seq: seq,
        kind: this.kindOf(run.requestId),
        project_id: run.projectId,
        bot_id: run.botId,
        execution_id: run.executionId,
        ts: now,
        directive_name: step.directiveName,
        directive_index: step.directiveIndex,
        action_id: step.actionId,
        intent_id: step.intentId,
        intent_name: step.intentName,
        node_id: step.nodeId,
        directive: directive,
        params: params,
        status: 'running',
        truncated: truncated.length > 0 ? truncated : undefined,
        expires_at: expires
      });
      return seq;
    } catch (err) {
      winston.error("(FlowTraceStore) beginStep failed:", err);
      return null;
    }
  }

  /** Cierra el paso abierto por beginStep. */
  static async endStep(requestId, seq, outcome) {
    if (seq === null || seq === undefined) return;
    try {
      const [result, resultTruncated] = this.prepare(outcome.result);
      const [paramsAfter, paramsAfterTruncated] = this.prepare(outcome.paramsAfter);
      const update = {
        $set: {
          status: outcome.status || 'ok',
          duration_ms: outcome.durationMs,
          result: result,
          params_after: paramsAfter
        }
      };
      if (outcome.error) {
        update.$set.error = String(outcome.error);
      }
      const extraTruncated = [];
      if (resultTruncated) extraTruncated.push('result');
      if (paramsAfterTruncated) extraTruncated.push('params_after');
      if (extraTruncated.length > 0) {
        update.$push = { truncated: { $each: extraTruncated } };
      }
      await FlowRunStep.updateOne({ request_id: requestId, seq: seq }, update);

      const headerSet = { updated_at: new Date() };
      if (outcome.status === 'error') {
        headerSet.last_status = 'error';
        headerSet.last_error = String(outcome.error || '');
      }
      await FlowRun.updateOne({ request_id: requestId }, { $set: headerSet });
    } catch (err) {
      winston.error("(FlowTraceStore) endStep failed:", err);
    }
  }

  /**
   * Fin de cadena. Para un bot conversacional NO es el fin de la conversación:
   * el próximo mensaje del cliente abre otra cadena sobre el mismo request_id
   * y la corrida vuelve a 'running'.
   */
  static async endRun(requestId, status, error) {
    try {
      const set = { ended_at: new Date(), updated_at: new Date() };
      if (status) set.last_status = status;
      if (error) set.last_error = String(error);
      await FlowRun.updateOne({ request_id: requestId }, { $set: set });
    } catch (err) {
      winston.error("(FlowTraceStore) endRun failed:", err);
    }
  }

  /**
   * Crea los índices a mano: la conexión abre con autoIndex:false, así que sin
   * esto no existe ni el TTL (y la traza crecería sin techo).
   */
  static async ensureIndexes() {
    if (!this.isEnabled()) return;
    try {
      await FlowRun.createIndexes();
      await FlowRunStep.createIndexes();
      winston.info("(FlowTraceStore) indexes ensured on flow_runs / flow_run_steps");
    } catch (err) {
      winston.error("(FlowTraceStore) ensureIndexes failed:", err);
    }
  }
}

module.exports = { FlowTraceStore };
