// El lead que ejecuta la automatización llega en el contexto como
// `attributes.lead.id`, pero el Filler siempre devuelve texto: mandarlo tal
// cual produce `{"leadId": "130146781"}` y las APIs de automatización del CRM
// lo reciben con tipado estricto (int), así que revientan con TypeError antes
// de ejecutar la acción. Para el flujo eso es un error del request: se va por
// la rama de error y el paso queda salteado sin explicación.
//
// Devuelve el id como número, o null si no se pudo resolver (variable sin
// reemplazar, vacía o no numérica). Quien llama decide cómo cortar.
const LEAD_ID_EXPRESSION = "{{attributes.lead.id}}";

function fillLeadId(filler, requestVariables, expression = LEAD_ID_EXPRESSION) {
  const raw = String(filler.fill(expression, requestVariables) ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const leadId = Number(raw);
  return Number.isSafeInteger(leadId) ? leadId : null;
}

module.exports = { fillLeadId, LEAD_ID_EXPRESSION };
