var mongoose = require('mongoose');
var Schema = mongoose.Schema;

/**
 * Traza de ejecución (observabilidad) — ver
 * external-weflow/docs/monitor-ejecucion.md.
 *
 * Dos colecciones, escritas por DirectivesChatbotPlug para TODA corrida (bot
 * conversacional y automatización), leídas por tiledesk-server para el monitor
 * de weflow:
 *
 *   flow_runs       cabecera, un doc por request_id
 *   flow_run_steps  un doc por directiva ejecutada, con el snapshot completo
 *                   de parámetros
 *
 * Es un store SEPARADO de `flow_executions` a propósito: ese es el checkpoint
 * de recuperación del supervisor (lease, deadline, idempotencia de
 * side-effects) y meterle corridas conversacionales lo haría auto-reanudar
 * flujos que esperan al cliente. Acá no hay lease ni estado que el motor lea:
 * es append-only y se puede borrar sin afectar la ejecución.
 *
 * Un paso se escribe DOS veces: al entrar a la directiva (status 'running') y
 * al salir (duración, resultado, params posteriores). Así una directiva que
 * cuelga o explota igual deja rastro del paso donde se quedó.
 *
 * Retención por TTL sobre `expires_at` (FLOW_TRACE_TTL_DAYS). Los params se
 * guardan completos, así que sin TTL la colección crece sin techo.
 */

var FlowRunSchema = new Schema({
  request_id: { type: String, required: true, unique: true, index: true },
  // 'automation' = request_id con prefijo "automation-request-" (fire&forget
  // con checkpoint); 'bot' = conversación.
  kind: { type: String, enum: ['bot', 'automation'], required: true },
  project_id: { type: String, required: true, index: true },
  bot_id: { type: String, index: true },
  // Sólo automatizaciones: join con flow_executions.
  execution_id: { type: String, index: true },

  started_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now },
  ended_at: { type: Date },
  // Contador atómico: además de dato, da el `seq` de cada paso.
  steps_count: { type: Number, default: 0 },
  last_directive_name: { type: String },
  // 'running' mientras hay una cadena en curso. Para un bot conversacional
  // vuelve a 'running' con cada mensaje entrante: la corrida es la
  // conversación, no la cadena.
  last_status: { type: String, enum: ['running', 'completed', 'error', 'cancelled'], default: 'running' },
  last_error: { type: String },

  expires_at: { type: Date }
}, {
  collection: 'flow_runs',
  strict: false
});

FlowRunSchema.index({ project_id: 1, bot_id: 1, started_at: -1 });
FlowRunSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

var FlowRunStepSchema = new Schema({
  request_id: { type: String, required: true, index: true },
  seq: { type: Number, required: true },

  kind: { type: String, enum: ['bot', 'automation'] },
  project_id: { type: String, index: true },
  bot_id: { type: String },
  execution_id: { type: String },

  ts: { type: Date, default: Date.now },
  duration_ms: { type: Number },

  directive_name: { type: String },
  // Índice en snapshot.directives de la cadena en curso.
  directive_index: { type: Number },
  action_id: { type: String },
  intent_id: { type: String },
  intent_name: { type: String },
  // Nodo del grafo weflow. Null hasta que el export emita el id (fase 4 del
  // spec); sin esto el monitor no puede pintar el camino en el canvas.
  node_id: { type: String, index: true },

  directive: { type: Schema.Types.Mixed },
  params: { type: Schema.Types.Mixed },
  params_after: { type: Schema.Types.Mixed },
  result: { type: Schema.Types.Mixed },

  // 'running' = se entró a la directiva y todavía no volvió (si queda así,
  // ahí colgó o explotó). 'waiting' = wait persistido, sigue el supervisor.
  // 'skipped' = side-effect ya ejecutado en un intento anterior.
  status: {
    type: String,
    enum: ['running', 'ok', 'error', 'skipped', 'waiting'],
    default: 'running'
  },
  error: { type: String },
  // Campos que no entraron completos (FLOW_TRACE_MAX_STEP_BYTES).
  truncated: { type: [String], default: undefined },

  expires_at: { type: Date }
}, {
  collection: 'flow_run_steps',
  strict: false
});

FlowRunStepSchema.index({ request_id: 1, seq: 1 }, { unique: true });
FlowRunStepSchema.index({ project_id: 1, bot_id: 1, ts: -1 });
FlowRunStepSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

var FlowRun = mongoose.model('flow_run', FlowRunSchema);
var FlowRunStep = mongoose.model('flow_run_step', FlowRunStepSchema);

module.exports = { FlowRun, FlowRunStep };
