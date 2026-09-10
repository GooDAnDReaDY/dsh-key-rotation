# findings.md — Находки и аудит кода (#281)

## 1. Стилистика интерфейса (Baseline dsh-clinebot)
- В `dsh-clinebot` используется продуманная сетка токенов:
  - Карточки: `border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); border-radius: 12px; padding: 18px 20px;`
  - Кнопки: `.cb-btn`, `.cb-btn-primary` (фон `--dsw-alias-label-primary`, текст `--dsw-alias-bg-layer-3`), `.cb-btn-danger` (текст `--dsw-alias-state-error-primary`), плавные ховеры.
  - Инпуты: высота 36px, `border: 1px solid var(--dsw-alias-border-l2)`, фон `var(--dsw-alias-bg-layer-2)`, фокус `border-color: var(--dsw-alias-state-brand-primary)`.
  - Бейджи: `border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); padding: 3px 10px; font-size: 12px;` с мягкими тонированными фонами (`rgba(16,185,129,0.08)` и т.д.).
  - Стат-боксы: компактные плитки метрик `.cb-stat-box` с крупным значением 18-20px/700 и подписью 12px.
- В `dsh-key-rotation`:
  - Успешно внедрены аналогичные классы (`.krot-section-card`, `.krot-stat-box`, `.krot-badge-ok/warn/bad`, `.krot-btn-primary/danger`).
  - Устранен хардкод цветов `#121318`, `#e5484d`, `#f5a623`, `#30a46c`, `#007aff`, `#ef4444`, `#f59e0b`.
  - Добавлен атрибут `data-dsh-plugin="dsh-key-rotation"` для тега стилей во избежание сброса стилей при HMR.

## 2. Анализ стабильности и покрытия модулей lib/
- `lib/quota-window.js`: экспортировал `poolResetAt` и `QUOTA_WINDOW_TYPES`, которые не были напрямую покрыты юнит-тестами. Добавлены тесты в `test/stability-coverage-281.test.mjs`.
- `lib/clock.js`: экспортировал `defaultClock`, покрыт тестами на монотонность и наличие функций `nowWall` / `nowMono`.
- `lib/http-bridge.js`: добавлены изолированные тесты для `scanForLiveSecrets`, `guardLocal`, `json`, `readJson`, `descriptorOf`, `viewOf`, `providerCatalog`.
- `lib/sandbox.js`: проверены константы `LAST_TEST_MAX` и граничные условия `LastTestCache`.
- `lib/pool.js`: проверены функции классификации `isSoftFailure`, `isLoopbackAddress`, `isTrustedBridgeRequest`, `keyTail`.
