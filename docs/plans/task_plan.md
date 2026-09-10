# task_plan.md — Задача #281: Унификация визуального стиля (baseline dsh-clinebot) и аудит стабильности

## Цель
1. Привести визуальный стиль карточки настроек `dsh-key-rotation` (`lib/client.js`) к единому эталонному стилю `dsh-clinebot` (премиальный нативный вид DSH, токены `--dsw-alias-*`, единые бейджи, кнопки, карточки секций, статистика, корректная изоляция стилей `data-dsh-plugin`).
2. Провести аудит стабильности кода: найти неиспользуемый или мертвый код, непокрытые тестами функции/утилиты, проверить граничные условия и обработку ошибок.
3. Покрыть тестами выявленные непокрытые участки, убедиться в стабильности всех тестов (307 тестов).

## Текущий статус
- **Статус**: completed_ready_for_review
- **Ветка**: `feat/stability-and-clinebot-ui-style` (worktree `.worktrees/feat/stability-and-clinebot-ui-style`)
- **Связанная задача**: Gitea #281

## Фазы выполнения
- [x] **Фаза 1: Аудит кода и выявление стабильности/тестов**
  - Проверены модули `lib/` на необработанные ошибки, нетестированные функции (`poolResetAt`, `QUOTA_WINDOW_TYPES`, `defaultClock`, `scanForLiveSecrets`, `guardLocal`, `LAST_TEST_MAX` и др.).
  - Создан тестовый файл `test/stability-coverage-281.test.mjs`, содержащий 18 новых подробных тестов для граничных условий и утилит. Все 307 тестов успешно проходят.
- [x] **Фаза 2: Унификация визуального оформления под dsh-clinebot**
  - Обновлен `CARD_CSS` и разметка карточки в `lib/client.js`.
  - Внедрены эталонные семантические классы и токены из `dsh-clinebot`:
    - карточки секций `.krot-section-card`, `.krot-section-title`, `.krot-section-desc`
    - бейджи статусов `.krot-badge`, `.krot-badge-ok`, `.krot-badge-warn`, `.krot-badge-bad`
    - кнопки `.krot-btn`, `.krot-btn-primary`, `.krot-btn-danger`, `.krot-btn-disabled`
    - инпуты `.krot-in` с высотой 36px, радиусом 8px и фокусом на `--dsw-alias-state-brand-primary`
    - информационные блоки и алерты `.krot-alert-ok`, `.krot-alert-bad`, `.krot-banner-warning`, `.krot-banner-exhausted`
    - блок сводной телеметрии пулов `.krot-stat-box`, `.krot-stat-val`, `.krot-stat-lbl`
  - Устранены хардкод-цвета, обеспечена 100% совместимость со светлой и тёмной темой DSH.
  - Установлен правильный атрибут изоляции `data-dsh-plugin="dsh-key-rotation"` и `id="dsh-key-rotation-full-css"` для тега `<style>`.
- [x] **Фаза 3: Тестирование и верификация**
  - Запущен полный сьют unit и component тестов (`npm test`): 307 passed, 0 failed, 1 skipped.
  - Проверено отсутствие регрессий, сохранение стабильности снимков React 18 (`scopeCacheRef`) и отсутствие ошибок unmount.
- [x] **Фаза 4: Актуализация документации и дизайн-контракта**
  - Обновлен `docs/design/DESIGN.md` (зафиксировано Locked Design Decision об унификации с `dsh-clinebot`).
- [ ] **Фаза 5: Pull Request и Review**
  - Оформить коммит через `git-antigravity`.
  - Открыть Pull Request в Gitea для задачи #281.
