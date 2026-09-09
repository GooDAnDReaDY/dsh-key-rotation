# task_plan.md — Задача #249: Оптимизация hotpath, исправление lastUsedAt и релиз v0.7.39

## Цель
Устранить дефект в `lib/heal.js` (чтение `lastUsedAt`), связать сохранение меток времени в `credentials.resolve`, устранить избыточные вызовы `buildRuntime()`, обновить документацию и выпустить проверенный релиз v0.7.39.

## Текущий статус
- **Статус**: done (обновлено quality-audit #251–#255)
- **Ветка**: merged via PR #250 → `main` @ `0d49e3f`
- **Версия**: 0.7.39 в `package.json`

## Фазы выполнения
- [x] Фаза 1: Создание issue #249 и изолированного worktree
- [x] Фаза 2: Исправление `lib/heal.js`, `lib/index.js`, устранение повторных вызовов `buildRuntime()`, обновление `package.json` до 0.7.39
- [x] Фаза 3: Юнит-тесты для `lastUsedAt` и регрессий
- [x] Фаза 4: Обновление документации
- [x] Фаза 5: Локальное тестирование и push в Gitea, PR #250, CI
- [x] Фаза 6: Merge в `main` (`0d49e3f`)
- [ ] Фаза 7–8: MiniPC test server и production / запрос на публикацию npm — вне scope этой планки; контроллируются release workflow

## Связанные quality-issues
Блок #251–#255 (docs drift, index/AGENTS, module split, hot-path logging, hygiene) ведётся отдельно в ветке `chore/dsh-key-rotation-quality-audit-251`.
