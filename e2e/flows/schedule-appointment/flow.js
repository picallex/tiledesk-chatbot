// Flow type: "schedule-appointment"
// Bot conversacional que califica un lead y lo lleva a una disposición de llamada.
// Aristas terminales: CONTACTAR YA / LLAMAR MAS TARDE / NO MOLESTAR / RECLAMO
// (+ CLIENTE ESCRIBE / ERROR EN RESPUESTA que el flujo también puede cerrar).
//
// Un "flow" agrupa TODO lo específico de un tipo de bot: sus escenarios, cómo se
// detecta el cierre, qué variables {{payload.message.*}} consume y qué salientes
// mockear. El driver, el cliente simulado y el reporte son genéricos y no cambian.
//
// Para un tipo de bot nuevo: copiá esta carpeta a flows/<otro-tipo>/, ajustá estos
// campos y sus scenarios.js, y corré con `--flow <otro-tipo>`.

const { scenarios } = require('./scenarios');

module.exports = {
  id: 'schedule-appointment',
  label: 'Calificación de lead + disposición de llamada',

  // Bot de referencia de este tipo de flujo. Se puede sobrescribir por CLI
  // (--project / --bot) o env (E2E_PROJECT_ID / E2E_BOT_ID).
  defaults: {
    projectId: '6a16f36e359f3a001200357b',
    botId: '6a16f3b0359f3a00120035c6',
  },

  // Primer mensaje que dispara el saludo/bienvenida.
  opener: '/start',

  // Motivos de negocio (documental).
  knownMotivos: ['CONTACTAR YA', 'LLAMAR MAS TARDE', 'NO MOLESTAR', 'RECLAMO'],

  // Variables {{payload.message.*}} que el flujo lee (en prod las llena el canal).
  // Cada key puede sobrescribirse por env; y por escenario vía su campo `payload`.
  messagePayload: {
    conversationName: process.env.E2E_CONVERSATION_NAME || 'Jorge 👨🏾‍🦲',
    preLeadId: process.env.E2E_PRELEAD_ID || '',
  },

  // Cómo detecta el harness el cierre de este flujo:
  detection: {
    // Atributo de flowAttributes con el JSON {finalizar, motivo, respuesta} del prompt.
    resultAttribute: 'respuestaAIExito',
    // Mensaje centinela que el flujo emite al cerrar.
    finishSentinel: '--FINISH--',
    // Nombre de bloque/intent terminal -> motivo (para inferir la arista cuando el
    // turno terminal no trae el JSON parseado).
    intentToMotivo: {
      'contactar ya': 'CONTACTAR YA',
      'llamar mas tarde': 'LLAMAR MAS TARDE',
      'no molestar': 'NO MOLESTAR',
      'reclamo': 'RECLAMO',
      'cliente escribe': 'CLIENTE ESCRIBE',
      'error en respuesta': 'ERROR EN RESPUESTA',
    },
  },

  // Salientes de este flujo a mockear en las corridas E2E (referencia; el mock se
  // activa en el contenedor vía MOCK_OUTBOUND_MATCH / MOCK_PRELEADS_LABEL).
  mockMatch: '/whatsapp/preleads/label',

  scenarios,
};
