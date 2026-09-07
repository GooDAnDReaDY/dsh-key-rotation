# Refactoring & De-bloat Plan (v0.7.36)

## Objectives
1. Purge 6 overengineered / dead subsystems:
   - `shadow.js` (traffic duplication / A-B testing)
   - `incident.js` (GitHub Issue incident creator)
   - `agent-budget.js` (agent token budgeting duplicating usage-guard)
   - `region.js` (SaaS geo-region zoning)
   - `canary.js` (30s polling burning real tokens)
   - `maintenance.js` (local filesystem auto-backups)
2. Performance & stability hardening:
   - Memoize `buildRuntime()`: eliminate per-token `structuredClone` and Schemastery parsing.
   - Atomic pointer round-robin in `credentials.resolve`: eliminate race conditions on concurrent tool calls.
   - Enhanced error detection: extract HTTP status codes (429, 5xx, 401) and gRPC status codes (`RESOURCE_EXHAUSTED`).
   - Clear exhaustion ETA message when all keys are in cooldown.
   - Smart visibility polling in client.js.
3. Quality gates:
   - Unit tests pass 100%.
   - MiniPC test server run (`192.168.1.123` -> `DSH_TEST_OK` -> `cleanup`).
   - Gitea PR, merge, bump version to 0.7.36, npm publish, MiniAI deploy.
