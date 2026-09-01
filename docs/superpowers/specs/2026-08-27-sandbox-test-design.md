# Sandbox-тест ключа — Design

Date: 2026-08-27
Plugin: `@goodandready/dsh-key-rotation`
Refs: issue #TBD (создам при коммите)

## Что

Расширить существующий `POST /dsh-key-rotation/test` опциональным probe
`/v1/models` для провайдера ключа. Результат — в in-memory кеше
на сервере + UI badge возле кнопки Test.

## Почему

Сейчас `/test` проверяет только credential resolution (есть ключ в env /
cred store) — не делает реального HTTP-вызова. Ключ может быть expired,
quota-revoked, или просто невалидный, а узнаём об этом только в проде
когда `llm/stream` падает. Sandbox-тест ловит это при добавлении.

## Архитектура

```
host/lib/sandbox.js       ← SandboxRunner (fetch /models, timeout, retry)
                          ← LastTestCache (Map<ref, result>, size guard 200)
host/lib/index.js         ← расширить /test, добавить GET /sandbox-cache,
                          ← расширить POST /config → auto-probe on save
client/lib/client.js      ← <LastTestBadge ref={...} /> + polling
test/sandbox.test.mjs     ← unit tests
```

## API

### POST /dsh-key-rotation/test

Request:
```json
{ "ref": "OPENROUTER_API_KEY", "value": "sk-...", "probe": "models" }
```
- `probe` опционально. Без него — legacy path (как сейчас, только credential check).
- `value` — для pre-save (уже есть).

Response (probe='models'):
```json
{
  "ok": true,
  "ref": "OPENROUTER_API_KEY",
  "tail": "...abc",
  "source": "credentials",
  "probe": "models",
  "latencyMs": 234,
  "modelsCount": 142
}
```

Ошибки (probe='models'):
```json
{ "ok": false, "ref": "...", "probe": "models", "code": "auth" | "not-found" | "rate-limit" | "server" | "timeout" | "network" | "no-baseurl", "latencyMs": 5012 }
```

### GET /dsh-key-rotation/sandbox-cache

```json
{
  "OPENROUTER_API_KEY": { "ok": true, "code": "ok", "latencyMs": 234, "modelsCount": 142, "at": 1737370000000 },
  "DEEPSEEK_API_KEY":   { "ok": false, "code": "auth", "latencyMs": 80, "at": 1737370000000 }
}
```

### POST /dsh-key-rotation/config (save)

Поведение: после apply нового config запускает `probe('models')` для
каждого ref, у которого изменились `keys` или `expiresAt`. Пробинг
async, не блокирует response (best-effort).

### POST /dsh-key-rotation/test probe='chat' (хук, не реализуем сейчас)

Хук есть в коде, но возвращает `{ ok: false, code: "not-implemented" }`.
Полная реализация `/v1/chat/completions` с opt-in — отдельная задача.

## SandboxRunner

```js
class SandboxRunner {
  resolveBaseUrl(provider) // через ctx.get('llm-pi-ai').providers
  probeModels(ref, key)    // fetch /v1/models с timeout 5s, retry 1x на 5xx
  probeChat(ref, key)      // throws 'not-implemented' сейчас
}
```

Таблица статусов:

| HTTP | Result code |
|------|-------------|
| 200 | `ok` |
| 401 / 403 | `auth` |
| 404 | `not-found` (провайдер не имеет /models, это нормально) |
| 429 | `rate-limit` |
| 5xx | retry 1x через 1s, потом `server` |
| timeout 5s | `timeout` (AbortController) |
| network | `network` |

## LastTestCache

```js
class LastTestCache {
  #data = new Map()  // ref -> LastTestResult
  #max = 200

  set(ref, result) // result: { ok, code, latencyMs, at, modelsCount? }
  get(ref)         // undefined если нет
  snapshot()       // { [ref]: result }
  clear()          // для тестов и ручного reset
}
```

In-memory, не в Config. При рестарте dsh-web — пустой.

## UI (client.js)

Новый компонент `LastTestBadge`:

```
props: { ref: string }
states:
  loading:    '…'
  ok:         '✓ 234ms'   # green
  auth:       '✗ auth'    # red
  not-found:  '?'         # gray (провайдер не поддерживает /models)
  rate-limit: '⚠ ratelimit' # yellow
  timeout:    '⏱ timeout' # yellow
  network:    '✗ network' # red
  no-baseurl: '?'         # gray
```

Polling: на mount → GET /sandbox-cache. Каждые 5s → refetch (только если
mount, без фокуса страницы — опционально, можно отключить когда вкладка скрыта).

Кнопка Test остаётся, расширяется: click → POST /test с probe='models' →
manual refetch /sandbox-cache.

## Tests

`test/sandbox.test.mjs`:
- `LastTestCache`: set/get/snapshot, clear, size guard на 200
- `SandboxRunner.probeModels`: мок fetch → 200 → ok с latencyMs; 401 → auth; 404 →
  not-found; 5xx → retry 1x → server; AbortController timeout
- `/test` endpoint с probe через integration harness

## Скоуп и YAGNI

- ❌ `/v1/chat/completions` real probe (хук + `not-implemented` ok)
- ❌ Persistence `lastTest` в Config (in-memory достаточно)
- ❌ Auto re-test по cron
- ❌ UI: tooltip / история тестов (badge достаточно)
- ❌ Webhook на exhaustion

## Скилл-комплаенс

- ✅ no-force: `git push --force` запрещён, merge только через Gitea API
- ✅ conventional commits
- ✅ tests: unit + integration покрытие
- ✅ production-deploy через `pnpm install` уже опубликованной версии (не `cp`, не `file:`)
- ✅ явное «Публикуем релиз?» перед `npm publish` и «Ставим в production?» перед update

## Release plan

Часть пула будущего релиза (≥5 фич). Один minor-bump релиза сделаем
когда #1 + #2 + #5 будут готовы.
