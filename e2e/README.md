# Suite E2E de casos de bot (Chat Prompts + Response API)

Maneja un **flujo de bot real** end-to-end por HTTP (igual que el widget), con un
**cliente simulado por LLM** y valida que la conversación **termine por la arista
esperada** (`CONTACTAR YA` / `LLAMAR MAS TARDE` / `NO MOLESTAR` / `RECLAMO`).

Como las respuestas de OpenAI son **no deterministas**, cada escenario se corre N
veces y se exige una **tasa de éxito ≥ umbral** (no un pass/fail binario).

## Requisitos

- Docker + el stack de dev de Tiledesk (`tiledesk-main/build/dev`).
- Node 18+ en tu máquina (la suite corre en el **host**; usa `fetch` nativo, **sin deps npm**).
- API key de OpenAI (para el cliente simulado).

## Puesta en marcha (paso a paso)

Se hace una vez. El **bot corre en el contenedor** `chatbot`; la **suite corre en el host**.

### 1. Código del bot con el fix + la suite

El repo `tiledesk-chatbot` debe estar en un commit que incluya:
- el fix de `input` JSON en `DirGptResponse` (PR #40, ya en `main`), y
- la carpeta `e2e/` (PR #41).

Con `main` actualizado (`git pull`) alcanza.

### 2. Levantar el stack de dev

```bash
cd tiledesk/tiledesk-main/build/dev
docker compose up -d --build
```
La app queda en `http://localhost:8090` (dashboard en `/dashboard`, CDS en `/cds/`).

### 3. Activar el mock del POST a `preleads/label` (para NO tocar el CRM)

Cada arista terminal del flujo hace `POST https://api.picallex.com/whatsapp/preleads/label`.
La suite trae un preload (`mock-outbound.js`) que lo intercepta. Recomiendo activarlo con un
**`docker-compose.override.yml` local** en `build/dev/` (así el `docker-compose.yml` versionado queda limpio):

```yaml
services:
  chatbot:
    # monta la suite en el contenedor (permite editar escenarios sin rebuild)
    volumes:
      - ../../../tiledesk-chatbot/e2e:/usr/src/app/e2e:ro
    environment:
      - LOG_LEVEL=debug                                            # opcional: logs del bot
      - NODE_OPTIONS=--require /usr/src/app/e2e/mock-outbound.js   # activa el mock
      - MOCK_PRELEADS_LABEL=1
```

Recreá el contenedor y verificá:
```bash
docker compose up -d --no-deps chatbot
docker exec chatbot printenv MOCK_PRELEADS_LABEL          # -> 1
docker compose logs --tail=40 chatbot | grep mock-outbound  # -> "[mock-outbound] active ..."
```

> ⚠️ `NODE_OPTIONS=--require .../mock-outbound.js` exige que el archivo exista en el contenedor;
> el volumen de arriba lo garantiza. Para **desactivar** el mock, quitá el override (o sus env).
> Alternativa: poner esas 3 env directo en el servicio `chatbot` del `docker-compose.yml`.

### 4. Obtener la API key de OpenAI

Panel → **Configuración del proyecto → Integraciones → OpenAI → API Key**. Exportala en la
terminal donde vas a correr la suite:
```bash
export OPENAI_API_KEY=sk-...
```

### 5. Correr la suite

```bash
cd tiledesk/tiledesk-chatbot/e2e
node run.js
```
Salida: tabla en la terminal + carpeta `results/<timestamp>/` (`summary.txt`, `report.json`,
un transcript por conversación). Exit code `0`/`1` según el umbral (sirve para CI).

## Uso

```bash
cd tiledesk-chatbot/e2e

node run.js                              # todos los escenarios (flujo PUBLICADO)
node run.js --flows                      # lista los tipos de flujo disponibles
node run.js --list                       # lista escenarios del flujo seleccionado
node run.js --flow schedule-appointment         # elegir tipo de flujo (default: schedule-appointment)
node run.js --project <projId> --bot <botId>   # correr contra OTRO bot del mismo tipo
node run.js --scenario reclamo           # solo los que matcheen "reclamo"
node run.js --runs 10 --threshold 0.7    # 10 corridas c/u, umbral 70%
node run.js --draft                      # probar el flujo DRAFT (lo que editás en CDS)
node run.js --debug                      # log detallado turno a turno
```

El **driver es genérico**: para testear otro bot **del mismo tipo de flujo**, pasá
`--project`/`--bot` (o `E2E_PROJECT_ID`/`E2E_BOT_ID`). Para un **tipo de bot distinto**,
se crea un flujo nuevo (ver "Agregar un tipo de flujo").

Exit code `0` si todos los escenarios alcanzan el umbral, `1` si alguno falla
(útil para CI).

## Comandos

Se corre desde `tiledesk-chatbot/e2e/` con `node run.js` + flags. Requiere
`OPENAI_API_KEY` exportada (salvo `--list` / `--flows`, que solo leen archivos).

| Comando | Qué hace |
|---|---|
| `node run.js` | Flujo por defecto, **todos** sus escenarios, 5 corridas c/u, flujo publicado, concurrencia 2. |
| `node run.js --flows` | Lista los **tipos de flujo** disponibles (carpetas en `flows/`). No corre nada. |
| `node run.js --list` | Lista los **escenarios** del flujo seleccionado. No corre nada. |
| `node run.js --flow <tipo>` | Elige el **tipo de flujo** (default `schedule-appointment`). |
| `node run.js --project <id> --bot <id>` | Corre contra **otro bot del mismo tipo** (sobrescribe los defaults del flow). |
| `node run.js --scenario <texto>` | Filtra escenarios cuyo id **contenga** `<texto>` (ej. `reclamo`). |
| `node run.js --runs <N>` | **Corridas por escenario** (default 5). Más runs = más señal estadística. |
| `node run.js --threshold <0-1>` | **Tasa mínima de éxito** por escenario para PASS (default `0.8`). |
| `node run.js --concurrency <N>` | Conversaciones en **paralelo** (default 2). |
| `node run.js --draft` | Prueba el flujo **DRAFT** (lo que editás en CDS) en vez del publicado. |
| `node run.js --debug` | Log **detallado turno a turno**. |

Los flags se combinan. Ejemplos:

```bash
node run.js --scenario reclamo --runs 3 --debug        # 1 escenario, 3 corridas, con detalle
node run.js --runs 2 --concurrency 4                   # pasada rápida (menos runs, más paralelo)
node run.js --flow schedule-appointment --draft        # el flujo en edición (draft)
node run.js --project <projId> --bot <botId> --runs 3  # otro bot del mismo tipo
node run.js --threshold 1                              # exigir 100% (más estricto)
```

Todo también por variable de entorno (útil para CI): `E2E_FLOW`, `E2E_PROJECT_ID`,
`E2E_BOT_ID`, `E2E_RUNS`, `E2E_THRESHOLD`, `E2E_CONCURRENCY`, `E2E_DRAFT`,
`E2E_SIM_MODEL` (ver tabla en "Variables de entorno").

## Cómo funciona

1. `POST /api/auth/signinAnonymously` → token de visitante anónimo.
2. `request_id = support-group-<project>-<uuid>`.
3. Por turno: `POST /api/<project>/requests/<req>/messages` con
   `participants:["bot_<botId>"]` y luego **polling** de
   `GET /api/<project>/requests/<req>/messages` hasta la respuesta del bot.
4. El **cliente LLM** (`simulated-user.js`) lee lo que dijo el bot y responde según
   la persona del escenario, hasta que el flujo termina.
5. La **arista** se detecta según la config del flujo (`flow.detection`): el atributo
   de `flowAttributes` con el JSON `{finalizar, motivo, respuesta}`, el centinela de
   cierre, y un mapeo bloque/intent → motivo.

## Estructura

El **core es genérico** (no depende del bot); lo específico de cada tipo de bot vive
en `flows/<tipo>/`.

| Archivo | Rol |
|---|---|
| `run.js` | Runner genérico: elige flujo, corre escenarios × N, agrega y reporta. |
| `driver.js` | Driver HTTP genérico (signin, enviar, pollear) + detección **parametrizable**. |
| `simulated-user.js` | Cliente LLM que interpreta la persona. |
| `reporter.js` | Terminal + `report.json` + `summary.txt` + un transcript por conversación. |
| `config.js` | Config genérica (todo por env). |
| `mock-outbound.js` | Preload que mockea salientes (ver abajo). |
| `flows/<tipo>/flow.js` | **Adapter del tipo de bot**: defaults de proyecto/bot, detección, `messagePayload`, mock y escenarios. |
| `flows/<tipo>/scenarios.js` | Escenarios de ese tipo de flujo. **Editá acá para agregar casos.** |

Flujo incluido: **`schedule-appointment`** — calificación de lead + disposición de llamada
(`CONTACTAR YA` / `LLAMAR MAS TARDE` / `NO MOLESTAR` / `RECLAMO`).

## Variables de entorno

| Var | Default | Descripción |
|---|---|---|
| `OPENAI_API_KEY` | — | **Requerida.** Key para el cliente simulado. |
| `E2E_BASE_URL` | `http://localhost:8090/api` | Base del server. |
| `E2E_FLOW` | `schedule-appointment` | Tipo de flujo (carpeta en `flows/`). También `--flow`. |
| `E2E_PROJECT_ID` | *(default del flow)* | Proyecto. También `--project`. |
| `E2E_BOT_ID` | *(default del flow)* | Bot. También `--bot`. |
| `E2E_DRAFT` | `false` | `true` = flujo draft. |
| `E2E_RUNS` | `5` | Corridas por escenario. |
| `E2E_THRESHOLD` | `0.8` | Tasa mínima de éxito. |
| `E2E_MAX_TURNS` | `10` | Tope de turnos por conversación. |
| `E2E_CONCURRENCY` | `2` | Conversaciones en paralelo. |
| `E2E_SIM_MODEL` | `gpt-4.1-mini` | Modelo del cliente simulado. |
| `E2E_CONVERSATION_NAME` | `Jorge 👨🏾‍🦲` | (flujo `schedule-appointment`) `{{payload.message.conversationName}}`. |
| `E2E_PRELEAD_ID` | `` (vacío) | (flujo `schedule-appointment`) `{{payload.message.preLeadId}}`. Ver nota Salesforce. |

## Variables del flujo `{{payload.message.*}}`

En el flujo `schedule-appointment`, `conversationName` y `preLeadId` **no** son campos de
plataforma: son variables custom que el engine lee de `message.attributes.payload.message.*`.
La suite las inyecta desde `flow.messagePayload` (en `flows/schedule-appointment/flow.js`), y cada
escenario puede sobrescribirlas con su campo `payload`, por ejemplo para variar el nickname
que ve el extractor de nombre:

```js
{ id: 'x', persona: '...', expected: ['CONTACTAR YA'],
  payload: { conversationName: '⚡Carla⚡ hola', preLeadId: 'lead-123' } }
```

> ⚠️ **Salesforce:** `preLeadId` alimenta los bloques `DirPicallexSf*`. Con un valor
> real, las corridas pueden **crear/actualizar registros reales en el CRM** en las
> aristas terminales. Por eso el default es vacío. Usá `E2E_PRELEAD_ID` con un id de
> sandbox/prueba solo si querés ejercitar ese camino.

## Mock del POST saliente a Picallex (`preleads/label`)

Cada arista terminal del flujo (Contactar ya, Llamar mas tarde, No molestar, Reclamo,
etc.) hace un `POST https://api.picallex.com/whatsapp/preleads/label` (un bloque Web
Request del flujo). Para que las corridas E2E **no peguen a producción**, hay un módulo
de *preload* que intercepta esas llamadas y responde un 200 mockeado (sin red):

- `mock-outbound.js` — interceptor de axios, gateado por env. Inerte salvo que se active.

Se activa en el contenedor `chatbot` (test-only, vía docker-compose de dev):
```yaml
- NODE_OPTIONS=--require /usr/src/app/e2e/mock-outbound.js
- MOCK_PRELEADS_LABEL=1
- MOCK_OUTBOUND_MATCH=/whatsapp/preleads/label   # opcional (default)
```
Requiere rebuild del contenedor para hornear el módulo. Cuando está activo, en los logs
del chatbot vas a ver por cada cierre:
```
[mock-outbound] intercepted (NO real POST): https://api.picallex.com/whatsapp/preleads/label
```
Para desactivarlo, sacá esas env vars (el módulo queda inerte aunque siga presente).

## Agregar un escenario (a un flujo existente)

Editá `flows/<tipo>/scenarios.js`:

```js
{
  id: 'mi-caso',
  persona: 'Describí al cliente y su objetivo (en qué termina).',
  expected: ['LLAMAR MAS TARDE'],   // motivo(s) válido(s) para dar éxito
  // payload: { conversationName: '...', preLeadId: '...' }   // opcional
}
```

## Agregar un tipo de flujo nuevo (otro bot distinto)

El driver/cliente/reporte no se tocan. Creás una carpeta nueva en `flows/`:

1. `flows/<nuevo-tipo>/scenarios.js` — las personas + `expected` de ese bot.
2. `flows/<nuevo-tipo>/flow.js` — el adapter:
   - `defaults.projectId` / `defaults.botId` del bot de referencia,
   - `opener` (primer mensaje),
   - `messagePayload` (las `{{payload.message.*}}` que consuma, si aplica),
   - `detection`: `{ resultAttribute, finishSentinel, intentToMotivo }` — **cómo cierra
     ese flujo** (qué atributo trae el resultado, qué mensaje marca el fin, y el mapeo
     bloque/intent → arista),
   - `mockMatch` (saliente a mockear, si aplica),
   - `scenarios`.
3. Corrés: `node run.js --flow <nuevo-tipo>`.

> Lo único realmente específico es `detection`: define cómo ese bot señala su cierre.
> Si el bot nuevo usa las mismas convenciones que `schedule-appointment`, copiá su `detection`.

## Nota

Cada conversación real consume tokens de OpenAI (los del bot vía la integración del
proyecto, y los del cliente simulado vía `OPENAI_API_KEY`). La suite completa
(8 escenarios × 5) son 40 conversaciones — tenelo en cuenta.
