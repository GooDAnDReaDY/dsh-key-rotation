# task_plan.md — Задача #245: Устранение зависания CI в runner

## Цель
Устранить зависание test-runner'а (`node --test`) в общем Gitea-runner (`maxParallel=1`), блокирующее очередь выполнения CI. Добавить явные таймауты, устранить утечки открытых ресурсов (таймеры, сокеты, неразрешенные промисы) и обеспечить чистое завершение процесса тестов.

## Текущий статус
- **Статус**: in_progress (готово к коммиту и PR)
- **Ветка**: `fix/ci-runner-hang-245`
- **Worktree**: `.worktrees/fix-ci-runner-hang`

## Фазы выполнения
- [x] Фаза 1: Анализ проблемы и выявление причин зависания (активный 30s `setInterval` в `lib/index.js:563` без `unref()`, отсутствие `sctx.effect` в mock context в `test/stability-hardening.test.mjs`, таймер debounce в `lib/webhook.js`)
- [x] Фаза 2: Добавление глобальных и локальных таймаутов, unref таймеров (`id.unref()` в sweep interval, `entry.timer.unref()` в `AlertDebouncer`, `--test-timeout=10000` в `package.json`, mock `sctx.effect` в `test/stability-hardening.test.mjs`)
- [x] Фаза 3: Локальная верификация с эмуляцией runner-окружения (прогон 266 тестов с peer dependencies, проверка естественного освобождения event loop без `process.exit()`)
- [ ] Фаза 4: Коммит, пуш, создание PR и проверка в Gitea Actions
- [ ] Фаза 5: Merge в main, закрытие issue #245 и очистка worktree

## Следующий шаг
Коммит изменений с conventional commit сообщением, пуш в Gitea, создание PR и запуск Gitea Actions.
