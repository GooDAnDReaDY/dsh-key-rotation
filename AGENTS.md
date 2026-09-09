# AGENTS.md — @goodandready/dsh-key-rotation

Project-specific rules only. Root `/mnt/external/Project/DEV/AGENTS.md` still applies.

## Identity
- Package scope: `@goodandready/dsh-key-rotation` (must match `package.json`, `cordis.patch.yml` `name:`, client `load({ id })`)
- Gitea: `goodandready/dsh-key-rotation`
- Agent git wrapper: `git-<agent>` on MiniAI; never bare `git` for commit/push

## Layout
- Root checkout is read-only. All writes in `.worktrees/<branch>`
- Single DEV folder + single OPT/test profile; no project copies
- Client `lib/client.js` must stay self-contained (DSH ModuleLoader serves one browser entry)

## Commands
```bash
node --test --test-timeout=10000 test/*.test.js test/*.test.mjs
```
- Tests must run without DSH harness and without network
- Peer `@deepseek-ai/schemastery` may be absent; several tests skip locally by design

## Release gate
- Only fully working features enter a release
- MiniPC test server install via temporary `.tgz` before any npm publish
- Production gets only the exact published immutable version
- Ask «Публикуем релиз?» and wait for explicit OK before tag/npm/GitHub Release
- Never use `--force`, `npm publish --force`, or `file:` paths into `.worktrees/`

## Security
- No hardcoded secrets, IPs of machines, or absolute paths in code/docs
- Route keys through DSH credentials; settings hold env names only
- Masked tails only (`keyTail`, last 5 chars)
- Local admin bridges: `isTrustedBridgeRequest`

## Constraints (MUST NOT)
- Do not change package identity (`@goodandready/...`) without a dedicated migration issue
- Do not add features that burn tokens in the background without tests and owner approval
- Do not edit other DSH plugins' profiles when testing this one
- Do not invent provider defaults that bind the plugin to a specific installation

## Docs gate
- Update README.en + ru + zh together when user-facing behavior changes
- Keep `docs/design/DESIGN.md` aligned with real Config keys and slots
- Keep this `index.md` map current after structure changes

## 0.8.0 stability modules

- `lib/clock.js` — monotonic process clock (`nowMono`) for durations
- `lib/circuit-breaker.js` — per-provider breaker
- `lib/error-taxonomy.js` — `classifyFailure` / `shouldSwitch`
- `lib/notify-queue.js` — non-blocking webhook queue
- `lib/atomic-io.js` — atomic write + safe JSON load
- `lib/bounded-map.js` — max+TTL+LRU map

Status extras: `providers[].circuit`, `meta.expectedClones`, `meta.notifyQueue`.
