# План #227 — GitHub Actions CI и npm provenance

## Цель

Сделать публичную публикацию `@goodandready/dsh-key-rotation` воспроизводимой:
GitHub Actions повторно проверяет точный tagged commit и публикует его в npm с
provenance только после отдельного решения владельца.

## Факты на старте

- GitHub repository: `GooDAnDReaDY/dsh-key-rotation`, public, branch `main`.
- Текущая версия: `0.7.33`; GitHub Actions workflow отсутствовали.
- Package manager: pnpm lockfile v9; фактически проверены Node `v22.23.1`,
  pnpm `10.33.2`, `pnpm test`, `pnpm audit --prod --audit-level=high`.
- После `pnpm install --frozen-lockfile`: 302 passed, 0 failed, 0 skipped.

## Реализация

1. `ci.yml`: read-only CI на GitHub push/PR/manual run.
2. `publish-npm.yml`: только ручной запуск по существующему tag; он повторяет
   dependency, test, audit и pack gates, затем вызывает `npm publish --provenance`.
3. npm Trusted Publisher настраивается после merge для exact GitHub repository
   и `publish-npm.yml`; NPM_TOKEN не добавляется в GitHub Secrets.

## Непроходимые условия публикации

- Gitea main и GitHub tag содержат точный проверенный commit;
- ранее пройдены DSH test server и production проверки по общему workflow;
- пользователь явно подтвердил публикацию;
- GitHub workflow повторно проходит все собственные gates;
- версия отсутствует в npm.

## Вне scope

- Npm-публикация, version bump, tag, GitHub Release и изменение production DSH;
- удаление или изменение закрытого worktree #155.
