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
  - **add a key in one place** — press *Add key*, paste the value, done. The credential name is generated for you (`<PROVIDER>_API_KEY`, then `_2`, `_3`, …) and shown only on hover; the card lists keys as *Key 1*, *Key 2*.
  - **live key status** — per key: in use / ready / cooling down with a countdown / **no such credential**, which is what catches a mistyped name that would otherwise fail silently.
  - **rotation counter** — how many times a provider switched key, on which failure, and how long ago.
  - **key order** — ↑/↓ buttons; the order of keys is the order they are tried.
  - **switch codes as checkboxes** instead of a comma-separated string.
  - **Exponential backoff** — repeated failures on the same key double its cooldown (base → ×2 → ×4 → cap ×8), so a dead key is not retried every window.
  - **Reset cooldown** — a *Reset cooldown* button in the card clears a provider's cooldown immediately (also via `POST /dsh-key-rotation/reset`).
  - **Env bootstrap** — if a pool ref (e.g. `MYPROVIDER_API_KEY`) is already set in `process.env`, it is treated as a transient credential without needing a DSH credential first.
  - **Per-provider cooldown** — override `cooldownMs` (and `maxCooldownMs`) per provider, fallback to the global values.
  - **Exhaustion warning** — when every key is cooling, a red warning appears in the card and `lastExhaustionAt`/`exhaustionCount` are exposed via `GET /dsh-key-rotation/status`.
  - **Failure log** — last 20 failures per provider (`at`, `ref`, `reason`, `cooldownMs`) via `/status` and a collapsible *Recent failures* list.
  - **Non-stream safety net** — an `agent/request-error` hook retries sync calls (embeddings, batch) with the next key when the error is switchable.
  - **Search/filter providers** — a search box above the list filters providers by id.
  - **Bulk edit cooldown** — checkboxes per provider + a cooldown input + *Apply to selected*.
  - **Undo delete** — after removing a key or provider, an *Undo* bar appears for 5 seconds.
  - **Per-key last used** — `lastUsedAt` shown as "ago" next to each key.
  - **Total requests badge** — sum of usage across a provider's keys, shown in its header.
  - **Export single provider** — ⬇ button exports just that provider's entry.
  - **Import from .env** — pick a `.env` file; `KEY=val` names are added to the first pool.
  - **Copy key name** — click a *Key N* label to copy its ref name.
  - **Sort by usage** — ⇅ sorts a provider's keys by usage (desc).
  - **Probe history** — health-probe events appear greyed in *Recent failures*.

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
    # `provider` is the id of a provider registered with dsh, as it appears
    # in Settings -> Models. `keys` are CREDENTIAL NAMES, never key values.
    - provider: my-provider
      keys: [MY_PROVIDER_API_KEY, MY_PROVIDER_API_KEY_2, MY_PROVIDER_API_KEY_3]
    - provider: another-provider
      keys: [ANOTHER_PROVIDER_API_KEY, ANOTHER_PROVIDER_API_KEY_2]
```

| Field | Default | Description |
|---|---|---|
| `switchCodes` | `[QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, UNKNOWN_MODEL]` | Error codes that trigger a key switch. |
| `cooldownMs` | `60000` | How long an exhausted key stays out of rotation. |
| `providers` | — | `[{ provider, keys: [envName, ...] }]`. `keys` are credential/env **names**, not the key values themselves. |

### How keys are stored

The plugin config only ever references keys by **name** (e.g. `MY_PROVIDER_API_KEY`). The values live in the dsh **Credentials** service or `$DSH_HOME/.credentials.yaml` — never in the plugin config.

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
