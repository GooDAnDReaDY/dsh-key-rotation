# task_plan.md — Задача #249: Оптимизация hotpath, исправление lastUsedAt и релиз v0.7.39

## Цель
Устранить дефект в `lib/heal.js` (чтение `lastUsedAt`), связать сохранение меток времени в `credentials.resolve`, устранить избыточные вызовы `buildRuntime()`, обновить документацию и выпустить проверенный релиз v0.7.39 через MiniPC test server и MiniAI production.

## Текущий статус
- **Статус**: in_progress
- **Ветка**: `fix/heal-perf-optimization-249`
- **Worktree**: `.worktrees/fix-heal-perf-optimization`

## Фазы выполнения
- [x] Фаза 1: Создание issue #249 и изолированного worktree
- [ ] Фаза 2: Исправление `lib/heal.js`, `lib/index.js`, устранение повторных вызовов `buildRuntime()`, обновление `package.json` до 0.7.39
- [ ] Фаза 3: Добавление юнит-тестов для `lastUsedAt` и регрессий
- [ ] Фаза 4: Обновление документации (README.md, README.ru.md, README.zh.md)
- [ ] Фаза 5: Локальное тестирование и push в Gitea, создание PR #250 и прохождение CI
- [ ] Фаза 6: Merge в main, упаковка `.tgz` и приёмка на изолированном MiniPC test server (`192.168.1.123`)
- [ ] Фаза 7: Приёмка на MiniAI production (`dsh-web.service`)
- [ ] Фаза 8: Запрос разрешения владельца на публикацию в npm/GitHub
