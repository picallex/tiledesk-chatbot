# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Tiledesk Chatbot Engine — a Node.js/Express server that executes chatbots designed in the Tiledesk Design Studio. The engine consumes bot definitions (intents + actions) from MongoDB and reacts to incoming messages from the Tiledesk platform.

This repo contains TWO npm packages:
- Root (`package.json`, `@tiledesk/tiledesk-chatbot`): the runnable server (Docker entry point).
- `tybotRoute/` (`@tiledesk/tiledesk-tybot-connector`): the engine published to npm and consumed by the root server (and by other Tiledesk hosts). Keep changes to engine logic inside `tybotRoute/`.

## Commands

```bash
# Run the server (reads .env; needs MONGODB_URI, API_ENDPOINT, optional CACHE_REDIS_*)
npm start                                # node index.js, listens on PORT (default 3000)

# Tests live in tybotRoute/test (mocha). Run from tybotRoute/:
cd tybotRoute && npm test                # runs all *.test.js style files via mocha
# Single test file:
cd tybotRoute && npx mocha ./test/<file>.js --timeout 10000 --exit
# Single test by name:
cd tybotRoute && npx mocha ./test/*.js --grep "<pattern>" --timeout 10000 --exit

# Docker
docker build -t tiledesk-chatbot .

# Publish a new tybotRoute version to npm and tag the repo
./deploy.sh                              # requires NPM_PUBLISH_TOKEN in env or interactive npm login
```

Tests files are paired: `conversation-<feature>_bot.js` (the bot definition fixture) + `conversation-<feature>_test.js` (the mocha spec). Files ending in `_DEPRECATED.js_` or `.js_` are disabled — don't add `.js` back without intent.

## Architecture

### Request flow

`index.js` mounts `tybotRoute` at `/` and `templatesRoute` at `/chatbots`, then calls `tybot.startApp(...)` to connect Mongo + Redis before `app.listen`. The two routes that handle inbound chatbot traffic live in `tybotRoute/index.js`:

- `POST /ext/:botid` — Tiledesk forwards a user message here. The handler:
  1. Validates `requestId`/`projectId`, caches `requestId → botId` in Redis for 7 days.
  2. Loads the bot from MongoDB (`MongodbBotsDataSource`) or static memory (`MockBotsDataSource`, used in tests).
  3. Builds intent finders via `IntentsMachineFactory`.
  4. Instantiates `TiledeskChatbot` and calls `chatbot.replyToMessage(message)`.
  5. The reply's `actions[]` are turned into directives (`TiledeskChatbotUtil.actionsToDirectives`) and executed by `DirectivesChatbotPlug.processDirectives()`.
- `POST /exec/:botid` — same as above but starts at a specific block (`chatbot.findBlock`) rather than running intent matching.
- `POST /ext/:projectId/requests/:requestId/messages` — accepts a reply from an external producer and re-runs directives parsing.

### The engine (`tybotRoute/engine/`)

- `TiledeskChatbot.js` — orchestrator. Holds per-request state (locked intent, current step, started flag) in Redis via `TdCache`. Enforces `MAX_STEPS` and `MAX_EXECUTION_TIME` guards. `replyToMessage` resets the step counter on any non-internal message, honors locked intents, and dispatches to the intent finder.
- `MongodbBotsDataSource.js` / `mock/MockBotsDataSource.js` — load bots and intents; both expose `getBotByIdCache` and `getByIntentDisplayNameCache`, which cache through Redis.
- `IntentsMachineFactory.js` / `MongodbIntentsMachine.js` / `TiledeskIntentsMachine.js` — pick the matching intent for an incoming message (NLU/keyword/fallback).
- `IntentForm.js` — drives multi-turn forms (slot filling).
- `TiledeskChatbotConst.js` — shared keys/constants for cache and attributes.

### Directives = the "actions" runtime

Bot replies carry an `actions[]` array (designed in Studio). `TiledeskChatbotUtil.actionsToDirectives` flattens those into a list of directives, then `DirectivesChatbotPlug` (in `tybotRoute/tiledeskChatbotPlugs/`) walks the list and invokes the matching `DirXxx` class in `tiledeskChatbotPlugs/directives/`. Each directive is one file (`DirReply`, `DirIntent`, `DirWebRequestV2`, `DirAskGPTV2`, `DirCode`, `DirJSONCondition`, `DirPicallexSfActivity`, etc.). To add a new action type:

1. Create `DirXxx.js` in `tiledeskChatbotPlugs/directives/`.
2. Import and register it inside `DirectivesChatbotPlug.js` (both the `require` block at top and the dispatch switch).
3. Map the Studio action name → directive in `TiledeskChatbotUtil.actionsToDirectives`.

`DEPRECATED_*` directives are kept for back-compat — prefer extending the V2/V3 variants (`DirReplyV2`, `DirWebRequestV2`, `DirReplaceBotV3`, `DirIfOpenHours` over `..._OLD`, etc.).

### Other plugs

`MessagePipeline.js`, `MarkbotChatbotPlug.js`, `FillParamsChatbotPlug.js`, `SplitsChatbotPlug.js`, `WebhookChatbotPlug.js`, `TiledeskRequestVariables.js`, `TildeskContextForCodeOrchestrator.js`, `TiledeskVarSplitter.js` — text-pipeline stages applied to non-action replies (`reply.attributes.directives|splits|markbot|fillParams = true` in `index.js`). `TiledeskExpression.js` / `TiledeskJSONEval.js` / `TiledeskMath.js` evaluate expressions used in conditions and variable substitutions; `TiledeskExpression` runs sandboxed code via `vm2`.

### Services (`tybotRoute/services/`)

Thin clients for external endpoints: `AIService.js` + `AIController.js` (LLM/RAG calls), `FaqKbService.js`, `FaqService.js`, `IntegrationService.js`, `KbService.js`, `QuotasService.js`, `TilebotService.js`. Most service calls are issued from inside the corresponding directive (e.g. `DirAskGPTV2` → `AIService`).

### Persistence

- MongoDB (Mongoose) — bot definitions and FAQ data. Models: `tybotRoute/models/faq.js`, `faq_kb.js`. Connection is opened in `startApp` with `autoIndex: false`.
- Redis (`TdCache.js`) — per-request state (locked intent, step counter, request→bot mapping) and cache for bot/intent lookups. Connection is optional; many flows degrade gracefully when `tdcache === null`. There are three TdCache variants in-tree (`TdCache.js`, `TdCache copy.js`, `TdCache_v3.js`) — only `TdCache.js` is wired in.

## Configuration

Required env vars (see `.env_example`; note variable name mismatches between root and engine):
- `MONGODB_URI` — Mongo connection string.
- `API_ENDPOINT` — Tiledesk API base, e.g. `https://api.tiledesk.com/v2`.
- `TILEBOT_ENDPOINT` — optional, defaults to `${API_ENDPOINT}/modules/tilebot`.
- `CACHE_REDIS_HOST` / `CACHE_REDIS_PORT` / `CACHE_REDIS_PASSWORD` — Redis cache (root `index.js` reads these and passes them as `REDIS_*` into `startApp`).
- `PORT` — HTTP listen port (default 3000).
- `LOG_LEVEL` — winston log level (`tybotRoute/utils/winston.js`).
- `CHATBOT_MAX_STEPS` (default 1000) and `CHATBOT_MAX_EXECUTION_TIME` (default 30 days in ms) — runaway guards in `TiledeskChatbot`.

## Conventions and gotchas

- Engine code goes in `tybotRoute/`. The root `index.js` is only a thin host. Bumping `tybotRoute/package.json` version → `./deploy.sh` publishes to npm and tags the repo.
- New directives must be registered in `DirectivesChatbotPlug.js` AND mapped from the Studio action name in `TiledeskChatbotUtil.actionsToDirectives` — otherwise actions silently no-op.
- `requestId` is the unit of conversation. State is keyed off it in Redis (`tilebot:botId_requests:<requestId>`, locked-intent keys, step counters). When debugging, search by `requestId` in logs.
- `vm2` is used to sandbox `DirCode` and expression evaluation. It is unmaintained upstream; treat changes here with care.
- Picallex-specific directives (`DirPicallex*`) extend the upstream Tiledesk engine with internal CRM integrations (Salesforce, WhatsApp template send, lead callbacks). Recent work in this fork has focused on those plus stop-policy / max-execution-time tuning — see the recent merges into `main`.
- `chooserChatbotRoute/` is currently disabled in `index.js` (commented-out mount). Don't assume it's reachable.

## OpenAI Response action (`DirGptResponse`)

`DirGptResponse.js` powers the Studio "OpenAI Response" action, which calls OpenAI's Responses API (`POST ${OPENAI_ENDPOINT}/responses`) referencing a stored prompt by id (`prompt: { id: "pmpt_..." }`). Considerations to keep in mind when touching it:

- **JSON input escaping.** When the block runs in `Prompt format → JSON` (`action.promptType === 'json'` with a non-empty `action.promptJson` map), the `input` is built field-by-field: each value is Liquid-filled independently and the object is then `JSON.stringify`-ed (`#buildJsonInput`). This is deliberate — do NOT go back to filling the whole JSON-shaped string and then `JSON.parse`-ing it. String-level interpolation breaks the JSON whenever a variable's runtime value contains double-quotes, newlines or backslashes; `JSON.stringify` escapes them so a valid JSON string is always sent. The `input` is sent as a JSON string (not an object), matching what the stored prompts expect.
  - `promptType === 'text'`: the filled prompt string is sent as-is (unchanged behavior).
  - `promptType === 'json'` without a `promptJson` map (legacy actions): the filled template is re-serialized when it parses, otherwise the raw string is sent as a fallback.
- **Conversation threading.** Multi-turn state is kept server-side via OpenAI conversations. A conversation id is created on the first turn and stored in the per-prompt attribute `conversationId_<pmpt_id>` (namespaced so different OpenAI Response blocks keep separate threads), then reused on later turns — it is NOT recreated each turn. This relies on `requestId` being stable across turns (it is — see the gotcha above) and on the attribute persisting in Redis. Alternatively, a `previous_response_id` (from `previousResponseIdAttribute` or a `resp_...` value) chains responses without a conversation.
- **Stored-prompt config.** Model, temperature, tools, etc. live inside the stored prompt on the OpenAI platform and are applied automatically when referencing it by id — the directive does not (and should not) resend them. Prompt `version` is not sent, so OpenAI resolves the currently-published version.
