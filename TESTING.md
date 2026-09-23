# Settings compatibility and regression tests

## Scope and evidence

The September 23, 2026 audit starts from PR #19 head
`8f844bc1ba66e49966567ff5ae943e86b7fd4a91`. The earlier source-regex tests did
not execute the settings page and did not establish that a save persisted.
They are replaced by executable tests of the shipped ModuleLoader factory,
React 18 page, HTTP route handlers, and isolated real Host settings services.

`npm test` runs 54 behavioral/protocol cases. It does not count production files
whose names happen to end in `-test.js` as tests. `npm run test:core` runs four
integration cases per installed core, separately and without silently skipping
the real-core suite. `npm run check` syntax-checks every JavaScript file under
`lib`, `test`, and `tools`.

The core matrix uses published `dsh-settings` and `dsh-client-ui-settings`
versions 0.1.5-rc.2, 0.1.6-alpha.2, and 0.1.7-alpha.1. The tests exercise the real
SettingsProvider/SettingsForms validation and revision queues and real Cordis
activation/disposal. The modern-core fixture boots the real Loader and
ConfigEditor over a temporary profile, writes its patch, and restarts it. The
old-core fixtures use the real SettingsProvider with an in-memory persistence
adapter, then reconstruct the provider from the persisted document. External
LLM, credential, and web-server boundaries are stubs. Every token is fake.

This is **not** a full Electron/Desktop boot, an actual browser layout test, or
a live third-party provider test. The browser behavior suite uses real React
and a small Host/transport fixture; it does not pretend that fixture is the
complete desktop application. No real credentials or user profiles are used.

## Run locally

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run check
npm test
```

`--legacy-peer-deps` installs the pinned test libraries without assembling an
unrelated current DSH peer tree. A deployed plugin still uses its Host peers.
The test runner works without the newer `--test-timeout` flag and has its own
overall timeout, so the Node 18 syntax/runtime floor is testable.

To run a real-core case with Node 22, install the core into a separate directory:

```sh
mkdir -p /tmp/rotation-test-core
printf '{"private":true,"type":"module"}\n' > /tmp/rotation-test-core/package.json
npm install --prefix /tmp/rotation-test-core --ignore-scripts \
  @deepseek-ai/dsh-settings@0.1.7-alpha.1 \
  @deepseek-ai/dsh-client-ui-settings@0.1.7-alpha.1 \
  @deepseek-ai/cordis@4.0.4 @deepseek-ai/schemastery@3.18.4
DSH_TEST_CORE_DIR=/tmp/rotation-test-core \
DSH_TEST_CORE_VERSION=0.1.7-alpha.1 npm run test:core
```

On PowerShell, set `$env:DSH_TEST_CORE_DIR` to the absolute installed directory
and `$env:DSH_TEST_CORE_VERSION` to its version before `npm run test:core`.
The CI matrix additionally runs Node 18/20/22/24 on Linux and Node 22 on Windows;
real-core jobs use Node 22, including the modern core on Windows.

## Regressions covered

| Area | Executed checks |
| --- | --- |
| Activation | modern-only, legacy-only, absent/late services, real Cordis optional injection, provider disposal/replacement, one legacy binding across page remounts |
| Saves | actual stored value, hidden token retained, only changed fields submitted, old revision rejected, refusal/undefined not accepted, no second-transport replay, duplicate click guarded |
| Recovery | Discard leaves a ready form, failure keeps editable draft, read-only transition, stale GET ignored, timeout/late settlement keeps draft, new edit after reverting obtains a fresh fence |
| Imports | snapshot stages until Save, dirty draft retained, malformed JSON/pool shapes rejected, protocol import preserves secrets, stale import rejected, external provider import touches providers only |
| Key editing | filtered provider identity, batch removal, final-key visibility, key move/Undo preserves weights and expiry, typed credential stays with its key and is not cleared by an earlier save |
| Protocol | required safe revision, root/unsafe paths rejected, ambiguous payload rejected, malformed/oversized/aborted body, atomic-API absence fails closed, explicit DELETE reset preserved, IPv6 loopback |
| Host | real mutation changes the running consumer, persists, survives restart, rejects invalid fields atomically, modern volatile Config is exposed, provider descriptor invalidation, live auto-unbreak scheduling |

## Intentional semantics

Normal PUT saves and both import paths are field mutations, never whole-section
replacement of a redacted descriptor. `{ops, expectedRevision}` is preferred;
legacy `{section, expectedRevision}` is treated as a patch of supplied fields.
PUT requires the revision returned by a read. Explicit DELETE remains a full
reset. Empty exported `webhookActionToken` on import means “not included”, not
“erase”. A native modern refusal is reported rather than replayed over HTTP.

Conflicting drafts keep their original fence. Discard deliberately drops them
and adopts the latest available Host snapshot; the client never silently
rebases an old draft onto a newer revision. Persistence enable/path options are
restart-bound on the modern core; live preferences use volatile Config. These
changes do not bump the version or publish a release.
