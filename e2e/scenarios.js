// Varied E2E scenarios. Each scenario defines a customer persona/goal and the
// terminal reason(s) the flow is expected to end with. Responses are
// non-deterministic, so each scenario is run N times and judged by success rate.
//
// expected: array of acceptable `motivo` values (the conversation must finalize
//           with one of them). Use [] for "should NOT terminate" style checks.
// payload:  optional per-scenario override of the {{payload.message.*}} flow vars
//           (merged over config.messagePayload). Use it to vary conversationName /
//           preLeadId, e.g. to test name extraction with different nicknames.

const scenarios = [
  {
    id: 'acepta-llamada-ahora',
    persona: 'Estás interesado en el producto para las arrugas. Cuando te ofrezcan una llamada con un especialista, aceptá que te llamen YA, ahora mismo.',
    expected: ['CONTACTAR YA'],
  },
  {
    id: 'pide-llamada-mas-tarde',
    persona: 'Te interesa el producto, pero ahora estás ocupado. Pedí explícitamente que te llamen más tarde hoy o mañana (dá un horario, ej. "a las 6 de la tarde").',
    expected: ['LLAMAR MAS TARDE'],
  },
  {
    id: 'no-quiere-contacto',
    persona: 'No te interesa y no querés que te contacten. Decí claramente que no te llamen ni te escriban más.',
    expected: ['NO MOLESTAR'],
  },
  {
    id: 'reclamo-enojado',
    persona: 'Estás enojado porque compraste el producto y llegó defectuoso/no funciona. Reclamás con firmeza y querés una solución.',
    expected: ['RECLAMO'],
  },
  {
    id: 'pregunta-precio-luego-acepta',
    persona: 'Primero insistís en saber el precio (preguntá el costo 2 veces). Después de que te expliquen, aceptá que te llamen ahora.',
    expected: ['CONTACTAR YA'],
  },
  {
    id: 'da-edad-y-acepta',
    persona: 'Cliente cordial. Contestá lo que te pregunten (elegí "cuidado diario", dá una edad como 47) y cuando te propongan la llamada, aceptá que te llamen en el momento.',
    expected: ['CONTACTAR YA'],
    // Ejemplo: variar el nickname que ve el extractor de nombre.
    payload: { conversationName: '⚡Carla⚡ hola' },
  },
  {
    id: 'indeciso-y-agenda',
    persona: 'Estás dudoso, al principio decís "más tarde veo", pero cuando insistan una vez, terminá agendando que te llamen hoy a la tardecita.',
    expected: ['LLAMAR MAS TARDE', 'CONTACTAR YA'],
  },
  {
    id: 'fuera-de-tema-y-cierra',
    persona: 'Preguntás cosas ajenas al producto (el clima, futbol). Tras un par de intentos, decí que no te interesa y que no te contacten más.',
    expected: ['NO MOLESTAR'],
  },
];

module.exports = { scenarios };
