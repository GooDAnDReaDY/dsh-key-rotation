# Публичная npm-публикация через GitHub Actions

## Назначение

`.github/workflows/ci.yml` проверяет публичное зеркало. Он не имеет write или
deploy permissions и не публикует пакеты.

`.github/workflows/publish-npm.yml` запускается вручную только после полного
качества по основному workflow: Gitea merge, DSH test server, production
проверка и явное подтверждение владельца на публикацию.

## Порядок выпуска

1. Агент завершает задачу в Gitea, merge в `main`, deploy и production-проверку.
2. Владелец подтверждает публикацию.
3. Из проверенного commit создаётся и зеркалируется GitHub tag `vX.Y.Z`.
4. GitHub CI должен быть зелёным для этого commit.
5. В GitHub Actions вручную запускается `Publish public npm package`, с точным
   `release_tag`.
6. Workflow повторно выполняет install, доступные static checks, tests, audit
   и `npm pack --dry-run`, затем публикует `npm publish --provenance`.
7. Агент устанавливает exact опубликованную версию в production и повторяет
   штатные production checks.

## Настройка npm Trusted Publisher

В npm package settings указать GitHub Actions publisher:

- organization: `GooDAnDReaDY`;
- repository: `dsh-key-rotation`;
- workflow filename: `publish-npm.yml`;
- environment: `npm-production`.

Trusted publishing использует OIDC; NPM token в GitHub Secrets не требуется.
Пакет остаётся публичным, а GitHub repository должен быть public.
