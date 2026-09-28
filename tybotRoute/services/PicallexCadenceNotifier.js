// Avisa a PicallEx que una cadencia termino de correr.
//
// `pcx.automations_executions` guarda una fila por paso, no por corrida, y solo
// las acciones con stop policy devuelven `mustStop`. Una cadencia que termina
// agotando sus directivas no deja ninguna marca de final, asi que del lado del
// CRM es indistinguible de una que sigue esperando entre pasos. Sin ese dato no
// se puede saber si un pre-lead tiene una cadencia viva antes de arrancarle otra.
//
// Este aviso cierra ese hueco: `markCompleted` es el unico punto donde un flow
// termina normalmente, y desde ahi se escribe la fila terminal en el CRM.
//
// Es fire-and-forget por diseno: un fallo del CRM no puede impedir que el flow
// quede marcado como completado en Mongo.
const https = require("https");
const { guardedAxios } = require("../utils/guardedAxios");
const integrationService = require("./IntegrationService");
const winston = require("../utils/winston");
require("dotenv").config();

const PICALLEX_ENDPOINT = process.env.PICALLEX_ENDPOINT || "https://crm.picallex.com";
const NOTIFY_PATH = "/v1/api/automations/cadence-completed";
const TIMEOUT_MS = 5000;

// El endpoint del CRM llega en un PR posterior. Hasta entonces el aviso queda
// apagado para no ensuciar los logs con un 404 por cada cadencia que termina.
function isEnabled() {
  return process.env.PICALLEX_NOTIFY_CADENCE_COMPLETED === "true";
}

// Solo las automatizaciones fire-and-forget nos interesan. Los bots
// conversacionales no tienen cadencia que cerrar.
function isAutomation(execution) {
  return typeof execution?.request_id === "string"
    && execution.request_id.startsWith("automation-request-");
}

function resolveLeadId(execution) {
  const raw = String(execution?.snapshot?.parameters?.attributes?.lead?.id ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const leadId = Number(raw);
  return Number.isSafeInteger(leadId) ? leadId : null;
}

async function notifyCompleted(execution) {
  if (!isEnabled() || !isAutomation(execution)) {
    return;
  }

  const leadId = resolveLeadId(execution);
  if (leadId === null) {
    winston.warn("(PicallexCadenceNotifier) lead id not found in snapshot for " + execution.execution_id);
    return;
  }

  const apiKey = await integrationService.getKeyFromIntegrations(
    execution.project_id,
    "picallex",
    execution.token
  );
  if (!apiKey) {
    winston.warn("(PicallexCadenceNotifier) PicallEx API key not configured for project " + execution.project_id);
    return;
  }

  const url = PICALLEX_ENDPOINT + NOTIFY_PATH;
  const options = {
    url: url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      // El bot_id del doc puede ser el del snapshot publicado y no el que el CRM
      // conoce: del otro lado `ResolveAutomation` ya resuelve por lead si el
      // header no matchea ninguna automatizacion.
      "X-Bot-Id": String(execution.bot_id)
    },
    data: {
      leadId: leadId,
      executionId: execution.execution_id,
      completedAt: new Date().toISOString()
    },
    timeout: TIMEOUT_MS
  };

  if (url.startsWith("https:")) {
    options.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  await guardedAxios(options, "PicallexCadenceNotifier");
  winston.debug("(PicallexCadenceNotifier) notified completion of " + execution.execution_id);
}

module.exports = { notifyCompleted };
