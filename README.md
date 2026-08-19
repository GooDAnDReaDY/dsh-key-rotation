# dsh-key-rotation

**Per-provider API key rotation** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Instead of failing on a quota/rate-limit error, the plugin transparently retries the request on the **next healthy key** in a per-provider pool.

> Hermes-style rotation: every configured provider has a key pool; when a key's limit is exhausted, the request is retried on the next key. Exhausted keys stay in cooldown and return to rotation after `cooldownMs`.

## What it does

- **Key pools per provider** — list the API keys (as credential/env names) that a provider may rotate through.
- **The provider you picked stays the provider** — rotation swaps the key, never the route, so a multi-call turn does not break. Legacy clone routes remain registered but are hidden from the model dropdown.
- **Transparent on-failure rotation** — on a switchable error (`QUOTA`, `RATE_LIMIT`, `AUTH`/`INVALID`…) the request is retried on the next key.
- **Cooldown** — an exhausted key is skipped for `cooldownMs`, then returns.
- **Dead/revoked key handling** — an auth/invalid key rotates to the next pool key instead of erroring out.
- **Settings GUI** — a **Settings → Key Rotation** section to manage everything without touching config files:
  - **add a key in one place** — press *Add key*, paste the value, done. The credential name is generated for you (`OPENCODE_GO_API_KEY`, `_2`, `_3`, …) and shown only on hover; the card lists keys as *Key 1*, *Key 2*.
  - **live key status** — per key: in use / ready / cooling down with a countdown / **no such credential**, which is what catches a mistyped name that would otherwise fail silently.
  - **rotation counter** — how many times a provider switched key, on which failure, and how long ago.
  - **key order** — ↑/↓ buttons; the order of keys is the order they are tried.
  - **switch codes as checkboxes** instead of a comma-separated string.

## Install

```bash
# From npm after publishing:
dsh plugin --profile web add @goodandready/dsh-key-rotation

# From GitHub:
dsh plugin --profile web add github:GooDAnDReaDY/dsh-key-rotation

# Locally from a checkout:
dsh plugin --profile web add /path/to/dsh-key-rotation
```

Restart the Web UI afterwards.

## Configure

### Web GUI (recommended)

Open **Settings → Key Rotation** and, for each provider, list the credential names of its keys. The plugin stores this in the `dsh-key-rotation` settings namespace (same place as `settings.yaml`).

### `settings.yaml`

```yaml
dsh-key-rotation:
  switchCodes: [QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, UNKNOWN_MODEL]
  cooldownMs: 60000
  providers:
    - provider: opencode-go
      keys: [OPENCODE_GO_API_KEY, OPENCODE_GO_API_KEY_2, OPENCODE_GO_API_KEY_3]
    - provider: ollama
      keys: [OLLAMA_API_KEY, OLLAMA_API_KEY_2, OLLAMA_API_KEY_3]
```

| Field | Default | Description |
|---|---|---|
| `switchCodes` | `[QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, UNKNOWN_MODEL]` | Error codes that trigger a key switch. |
| `cooldownMs` | `60000` | How long an exhausted key stays out of rotation. |
| `providers` | — | `[{ provider, keys: [envName, ...] }]`. `keys` are credential/env **names**, not the key values themselves. |

### How keys are stored

The plugin config only ever references keys by **name** (e.g. `OPENCODE_GO_API_KEY`). The values live in the dsh **Credentials** service or `$DSH_HOME/.credentials.yaml` — never in the plugin config.

A key typed into the Key Rotation card is written to that same credentials store: the value travels to the host once and is never sent back to the browser. Only its **last 5 characters** are, so two keys can be told apart in the UI. A key supplied by the launching environment is shown as read-only, because overwriting it here would be shadowed anyway.

## How it works

```
request ──► {provider: rotation} clone route ──► pick next healthy key in pool
        ┌────────┐   on switchable failure retry with next key, stay in cooldown
        └─────────┘
```

- The plugin patches `ctx.credentials.resolve` so a pool reference resolves to the current healthy key (round-robin, skipping keys in cooldown).
- It intercepts `llm/stream` to retry the request on the next key after a switchable failure, instead of surfacing the error to the caller. The hook is deliberately **not** `async`: the loop iterates its result directly, and returning a promise breaks every turn.
- The provider identity never changes — only the resolved key does — which keeps the adapter's replay state consistent across a multi-call turn.

Two local-only routes back the card: `GET /dsh-key-rotation/status` (key state, rotation counters, last 5 characters of each key) and `PUT|DELETE /dsh-key-rotation/key` (store or drop one key value). Both refuse anything that is not a same-origin request from loopback.

## Structure

```
dsh-key-rotation/
├── package.json            # dsh bundle/plugin metadata + peerDependencies
├── cordis.patch.yml        # bundle layer: registers the virtual route "rotation"
├── lib/index.js            # host: pools, credentials.resolve patch, stream retry
├── lib/client.js           # browser: Settings → Key Rotation panel
└── README.md
```

## Security notes

- Key **values** never leave your Credentials store; the plugin config only holds env/credential **names**.
- `switchCodes` are error classification strings, not expressions — no secrets involved.

## License

MIT
