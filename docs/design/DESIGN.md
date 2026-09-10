# DESIGN.md — @goodandready/dsh-key-rotation

## Product / Purpose
- **Назначение**: Прозрачная балансировка, автоматическая ротация API-ключей, превентивное обнаружение лимитов (429 / Quota) и каскадный failover для провайдеров DeepSeek Harness (DSH).
- **Аудитория**: Разработчики и операторы DeepSeek Harness, использующие пулы ключей (OpenCode, DeepSeek Official, Groq, Ollama и др.) без прерывания пользовательских сессий.
- **Статус**: Production (активный релизный цикл, семантическое версионирование).

## User Surfaces
- **Web/UI**: Карточка настроек плагина в DSH WebUI (`settings.plugin.item`, ключ `dsh-key-rotation`; собственной строки `settings.section` нет — #275), компактный чип статуса пула в шапке (`header.status`).
- **DSH UI / settings / slots**:
  - Слот `settings.plugin.item`: key `dsh-key-rotation`, `locale: 'dsh-key-rotation'`.
  - Слот `header.status`: живой индикатор доступности ключей (зелёный/жёлтый/красный) с тултипом активного пула.
- **API**: HTTP-эндпоинты плагина для DSH WebUI:
  - `GET /dsh-key-rotation/status`: сводка пулов, активных ключей, ошибок и метрик задержки.
  - `GET/PUT /dsh-key-rotation/config`: конфигурационный мост (адаптер для DSH settings).
  - `POST /dsh-key-rotation/test`: изолированная песочница валидации ключа (`models` / `chat`).
  - `POST /dsh-key-rotation/webhook/action`: интерактивные действия (cooldown reset, rotate).
- **CLI**: Стандартный интерфейс управления плагинами DSH (`dsh plugin add/remove`).
- **Документация**: `README.md`, `README.ru.md`, `README.zh.md`, витрина `goodandready.app`.

## Visual Direction
- **Атмосфера**: Строгий, нативный интерфейс DeepSeek Harness, неотличимый от базовых компонентов ядра DSH.
- **Утверждённые референсы**: Карточки настроек ядра DSH («Консоль», «Цикл агента», «Поиск в вебе»).
- **Не копировать**: Сторонние библиотеки UI со своими шрифтами или жёсткими inline-стилями; самодельные иконки-стрелки вместо шевронов DSH.

## Foundations
- **Цвета и роли**: Исключительно семантические CSS-переменные DSH:
  - Фон карточки: `var(--dsw-alias-bg-layer-3)`
  - Границы: `var(--dsw-alias-border-l2)`
  - Основной текст: `var(--dsw-alias-label-primary)`
  - Второстепенный текст: `var(--dsw-alias-label-secondary)`
  - Акценты статусов: `var(--dsw-alias-status-success)`, `var(--dsw-alias-status-warning)`, `var(--dsw-alias-status-danger)`
- **Типографика**: Системный стек шрифтов DSH, заголовки секций 15px/600, подписи 13px regular.
- **Сетка, отступы, responsive**: Скругления 12px, шапка карточки 14px 16px, поля формы с гэпом 6px, мобильная адаптивность при сужении контейнера.
- **Accessibility**: Шапка карточки — интерактивная кнопка (`button`) с корректным `aria-expanded` для управления с клавиатуры; все поля ввода имеют ассоциированные `<label>`.

## Components And States
- **Компоненты**:
  - `KeyRotationCard`: сворачиваемая карточка настроек в реестре плагинов.
  - `PoolRow`: строка конфигурации провайдера со списком ключей, весов и тегов.
  - `HealthChip`: компактный бэйдж здоровья пула с числом живых ключей.
  - `MetricsDrawer`: раскрывающаяся секция гистограмм задержки и кодов ошибок.
- **Loading / empty / error / success**:
  - `loading`: статус снимка настроек `loading` — форма отображает аккуратный скелетон/индикатор загрузки.
  - `unavailable`: предупреждение о недоступности конфигурации на сервере без перезаписи локального драфта.
  - `ready`: активная форма настроек с реактивным обновлением.
  - `error`: inline-алерт с возможностью повтора сохранения.
  - `success`: тост или статусная метка «Сохранено».
- **Формы, валидация и действия**:
  - Кнопка «Сохранить» валидирует числовые диапазоны (пороги задержки).
  - Секретный токен (`webhookActionToken`) маскируется и имеет роль `secret`.

## User Flows
- **Просмотр состояния пула**: Пользователь видит чип в шапке -> клик открывает статус доступности ключей.
- **Добавление нового ключа**: Пользователь открывает Настройки -> Плагины -> Key Rotation -> добавляет имя переменной окружения -> сохраняет.
- **Тестирование ключа**: Нажатие кнопки «Тест» отправляет запрос в песочницу без переключения боевого трафика.

## Config Surface (excerpt)
- `verboseLogging` (boolean, default `false`): opt-in diagnostic log on every rotated `llm/stream` dispatch; event warnings (switch/exhausted/cascade) always log.

## Do / Don't
- **Do**:
  - Использовать префикс `kr-` для всех CSS-классов карточки плагина.
  - Указывать `data-dsh-plugin="dsh-key-rotation"` на динамических `<style>`.
  - Регистрировать таймеры и слушатели событий через `ctx.effect`.
  - Восстанавливать monkey-patched методы при `dispose`.
- **Don't**:
  - Зашивать абсолютные URL или IP-адреса в код клиента или сервера.
  - Использовать хардкод английских строк при наличии словарей `en`, `ru`, `zh`.
  - Использовать plain-text поля в схеме настроек для чувствительных токенов.

## Stability (Changed in v0.8.0)

### Error taxonomy (#267)

| Class | Examples | Action |
|---|---|---|
| Quota / rate limit | HTTP 429, RESOURCE_EXHAUSTED, QUOTA | switch (hard backoff) |
| Transient server | 500/502/503/504, UNAVAILABLE, INTERNAL | switch (soft backoff) |
| Timeout / transport | 408, 425, TIMEOUT, ECONNRESET, ETIMEDOUT | switch (soft) |
| Auth | 401/403, UNAUTHENTICATED | switch + auth-fail counting |
| Client error | 400, 404, 422, INVALID_ARGUMENT | surface to caller |

Classifier: `lib/error-taxonomy.js` → `classifyFailure()` / `shouldSwitch()`.

### Circuit breaker (#260)

Per-provider state machine: `closed → open → half_open → closed`. Stored on module `CircuitBreaker`; exposed in status as `providers[].circuit`.

### Clock (#261)

Durations (cooldown remaining, breaker open window) use `nowMono()` = `performance.timeOrigin + performance.now()`. Wall clock only for calendar buckets (usageDays, budget day).

### Notify queue (#263)

`NotifyQueue` — bounded depth, fire-and-forget, exponential backoff per URL. `rotate()` never awaits webhook HTTP.

### Atomic I/O (#264)

`atomicWriteFile` (temp+fsync+rename) and `safeParseJson`/`safeReadJson` (corrupt → previous fallback, never empty-overwrite).

## Locked Design Decisions
- 2026-09-10 — Настройки только карточкой `settings.plugin.item`; fallback на `settings.section` удалён (#275). Причина: боковой список ядра плоский, 11 плагинов заняли общие строки. Условие пересмотра: явное согласие владельца на отдельную подсистему с несколькими экранами.
- 2026-09-10 — Исходная локаль только `en` (`ctx.locale.register(NS, { en })`); `ru`/`zh` не зашиваются в плагин. Переводы — translation-плагин / core `props.t`. Фолбек активной локали: `ctx.locale.getSnapshot().active` → первый `navigator.languages` → `en` (#277 / GitHub #1).
- 2026-09-10 — Унификация визуального оформления с эталоном `dsh-clinebot` (#281): семантические карточки секций (`.krot-section-card`), статусные бейджи (`.krot-badge-ok/warn/bad`), панель сводной телеметрии (`.krot-stat-box`), эталонные кнопки (`.krot-btn-primary`, `.krot-btn-danger`), инпуты с радиусом 8px и фокусом на `--dsw-alias-state-brand-primary`, удаление всех хардкод hex-цветов, изоляция стилей через `data-dsh-plugin="dsh-key-rotation"` и `id="dsh-key-rotation-full-css"`.
