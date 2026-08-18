# dsh-key-rotation

**Per-provider API key rotation** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Instead of failing on a quota/rate-limit error, the plugin transparently retries the request on the **next healthy key** in a per-provider pool.

> Hermes-style rotation: every configured provider has a key pool; when a key's limit is exhausted, the request is retried on the next key. Exhausted keys stay in cooldown and return to rotation after `cooldownMs`.

## What it does

- **Key pools per provider** — list the API keys (as credential/env names) that a provider may rotate through.
- **Auto-created clone routes** — the plugin registers a virtual provider/route and wires it to the pool; clone routes are hidden from the model dropdown.
- **Transparent on-failure rotation** — on a switchable error (`QUOTA`, `RATE_LIMIT`, `AUTH`/`INVALID`…) the request is retried on the next key.
- **Cooldown** — an exhausted key is skipped for `cooldownMs`, then returns.
- **Dead/revoked key handling** — an auth/invalid key rotates to the next pool key instead of erroring out.
- **Settings GUI** — a **Settings → Key Rotation** section to edit key pools, switch codes and cooldown without touching config files by hand.

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

The plugin only ever references keys by **name** (e.g. `OPENCODE_GO_API_KEY`). The actual values live in the dsh **Credentials** service (Web: **Settings → Credentials**) or `$DSH_HOME/.credentials.yaml` — never in the plugin config.

## How it works

```
request ──► {provider: rotation} clone route ──► pick next healthy key in pool
        ┌────────┐   on switchable failure retry with next key, stay in cooldown
        └─────────┘
```

- The plugin patches `ctx.credentials.resolve` so a pool reference resolves to the current healthy key (round-robin, skipping keys in cooldown).
- It intercepts `llm/stream` to retry the request on the next key after a switchable failure, instead of surfacing the error to the caller.

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
