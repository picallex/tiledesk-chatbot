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
node run.js --list                       # lista escenarios y sale
node run.js --scenario reclamo           # solo los que matcheen "reclamo"
node run.js --runs 10 --threshold 0.7    # 10 corridas c/u, umbral 70%
node run.js --draft                      # probar el flujo DRAFT (lo que editás en CDS)
node run.js --debug                      # log detallado turno a turno
```

Exit code `0` si todos los escenarios alcanzan el umbral, `1` si alguno falla
(útil para CI).

## Cómo funciona

1. `POST /api/auth/signinAnonymously` → token de visitante anónimo.
2. `request_id = support-group-<project>-<uuid>`.
3. Por turno: `POST /api/<project>/requests/<req>/messages` con
   `participants:["bot_<botId>"]` y luego **polling** de
   `GET /api/<project>/requests/<req>/messages` hasta la respuesta del bot.
4. El **cliente LLM** (`simulated-user.js`) lee lo que dijo el bot y responde según
   la persona del escenario, hasta que el flujo termina.
5. La **arista** se detecta de forma determinista desde
   `attributes.flowAttributes.respuestaAIExito` (el JSON `{finalizar, motivo, respuesta}`
   del Chat Prompt) y el mensaje centinela `--FINISH--` que emite el flujo al cerrar.

## Archivos

| Archivo | Rol |
|---|---|
| `config.js` | Configuración (todo overridable por env). |
| `scenarios.js` | Los casos de test (persona + motivo esperado). **Editá acá para agregar casos.** |
| `driver.js` | Driver HTTP (signin, enviar, pollear) + detección de arista. |
| `simulated-user.js` | Cliente LLM que interpreta la persona. |
| `run.js` | Orquestador: corre escenarios × N, agrega y reporta. |

## Variables de entorno

| Var | Default | Descripción |
|---|---|---|
| `OPENAI_API_KEY` | — | **Requerida.** Key para el cliente simulado. |
| `E2E_BASE_URL` | `http://localhost:8090/api` | Base del server. |
| `E2E_PROJECT_ID` | `6a16f36e359f3a001200357b` | Proyecto. |
| `E2E_BOT_ID` | `6a16f3b0359f3a00120035c6` | Bot. |
| `E2E_DRAFT` | `false` | `true` = flujo draft. |
| `E2E_RUNS` | `5` | Corridas por escenario. |
| `E2E_THRESHOLD` | `0.8` | Tasa mínima de éxito. |
| `E2E_MAX_TURNS` | `10` | Tope de turnos por conversación. |
| `E2E_CONCURRENCY` | `2` | Conversaciones en paralelo. |
| `E2E_SIM_MODEL` | `gpt-4.1-mini` | Modelo del cliente simulado. |
| `E2E_CONVERSATION_NAME` | `Jorge 😊` | Valor de `{{payload.message.conversationName}}`. |
| `E2E_PRELEAD_ID` | `` (vacío) | Valor de `{{payload.message.preLeadId}}`. Ver nota Salesforce. |

## Variables del flujo `{{payload.message.*}}`

`conversationName` y `preLeadId` **no** son campos de plataforma: son variables custom
del flujo. El engine las lee de `message.attributes.payload.message.*`. La suite las
inyecta automáticamente (`config.messagePayload`), y cada escenario puede sobrescribirlas
con su campo `payload`, por ejemplo para variar el nickname que ve el extractor de nombre:

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

## Agregar un escenario

Editá `scenarios.js`:

```js
{
  id: 'mi-caso',
  persona: 'Describí al cliente y su objetivo (en qué termina).',
  expected: ['LLAMAR MAS TARDE'],   // motivo(s) válido(s) para dar éxito
}
```

## Nota

Cada conversación real consume tokens de OpenAI (los del bot vía la integración del
proyecto, y los del cliente simulado vía `OPENAI_API_KEY`). La suite completa
(8 escenarios × 5) son 40 conversaciones — tenelo en cuenta.
