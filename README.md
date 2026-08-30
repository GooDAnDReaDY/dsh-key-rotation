# 📦 @goodandready/dsh-key-rotation

<div align="center">

[![npm version](https://img.shields.io/npm/v/@goodandready/dsh-key-rotation.svg?style=flat-square)](https://www.npmjs.com/package/@goodandready/dsh-key-rotation)
[![license](https://img.shields.io/github/license/GooDAnDReaDY/dsh-key-rotation.svg?style=flat-square)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-6366f1.svg?style=flat-square)](https://github.com/topics/dsh-plugin)

**[ 🇬🇧 English ](#-english) • [ 🇷🇺 Русский ](#-русский) • [ 🇨🇳 中文 ](#-中文)**

</div>

---

<a name="-english"></a>
## 🇬🇧 English

# dsh-key-rotation

**Per-provider API key rotation** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Instead of failing on a quota/rate-limit error, the plugin transparently retries the request on the **next healthy key** in a per-provider pool.

> Hermes-style rotation: every configured provider has a key pool; when a key's limit is exhausted, the request is retried on the next key. Exhausted keys stay in cooldown and return to rotation after `cooldownMs`.

## What it does

- **Key pools per provider** — list the API keys (as credential/env names) that a provider may rotate through.
- **The provider you picked stays the provider** — rotation swaps the key, never the route, so a multi-call turn does not break. Legacy clone routes remain registered but are hidden from the model dropdown.
- **Transparent on-failure rotation** — on a switchable error (`QUOTA`, `RATE_LIMIT`, `AUTH`/`INVALID`…) the request is retried on the next key.
- **Cooldown** — an exhausted key is skipped for `cooldownMs`, then returns.
- **Dead/revoked key handling** — an auth/invalid key rotates to the next pool key instead of erroring out.
- **Settings GUI** — a **Settings → Key Rotation** section to manage everything without touching config files:
  - **add a key in one place** — press *Add key*, paste the value, done. The credential name is generated for you (`<PROVIDER>_API_KEY`, then `_2`, `_3`, …) and shown only on hover; the card lists keys as *Key 1*, *Key 2*.
  - **live key status** — per key: in use / ready / cooling down with a countdown / **no such credential**, which is what catches a mistyped name that would otherwise fail silently.
  - **rotation counter** — how many times a provider switched key, on which failure, and how long ago.
  - **key order** — ↑/↓ buttons; the order of keys is the order they are tried.
  - **switch codes as checkboxes** instead of a comma-separated string.
  - **Exponential backoff** — repeated failures on the same key double its cooldown (base → ×2 → ×4 → cap ×8), so a dead key is not retried every window.
  - **Reset cooldown** — a *Reset cooldown* button in the card clears a provider's cooldown immediately (also via `POST /dsh-key-rotation/reset`).
  - **Env bootstrap** — if a pool ref (e.g. `MYPROVIDER_API_KEY`) is already set in `process.env`, it is treated as a transient credential without needing a DSH credential first.
  - **Per-provider cooldown** — override `cooldownMs` (and `maxCooldownMs`) per provider, fallback to the global values.
  - **Exhaustion warning** — when every key is cooling, a red warning appears in the card and `lastExhaustionAt`/`exhaustionCount` are exposed via `GET /dsh-key-rotation/status`.
  - **Failure log** — last 20 failures per provider (`at`, `ref`, `reason`, `cooldownMs`) via `/status` and a collapsible *Recent failures* list.
  - **Non-stream safety net** — an `agent/request-error` hook retries sync calls (embeddings, batch) with the next key when the error is switchable.
  - **Search/filter providers** — a search box above the list filters providers by id.
  - **Bulk edit cooldown** — checkboxes per provider + a cooldown input + *Apply to selected*.
  - **Undo delete** — after removing a key or provider, an *Undo* bar appears for 5 seconds.
  - **Per-key last used** — `lastUsedAt` shown as "ago" next to each key.
  - **Total requests badge** — sum of usage across a provider's keys, shown in its header.
  - **Export single provider** — ⬇ button exports just that provider's entry.
  - **Import from .env** — pick a `.env` file; `KEY=val` names are added to the first pool.
  - **Copy key name** — click a *Key N* label to copy its ref name.
  - **Sort by usage** — ⇅ sorts a provider's keys by usage (desc).
  - **Probe history** — health-probe events appear greyed in *Recent failures*.

## Install

```bash
# From npm after publishing:
dsh plugin --profile web add @goodandready/dsh-key-rotation

# From GitHub:
dsh plugin --profile web add github:GooDAnDReaDY/dsh-key-rotation

# Locally from a checkout:
dsh plugin --profile web add /path/to/dsh-key-rotation
```

Restart the Web UI afterwards.

## Configure

### Web GUI (recommended)

Open **Settings → Key Rotation** and, for each provider, list the credential names of its keys. The plugin stores this in the `dsh-key-rotation` settings namespace (same place as `settings.yaml`).

### `settings.yaml`

```yaml
dsh-key-rotation:
  switchCodes: [QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, UNKNOWN_MODEL]
  cooldownMs: 60000
  providers:
    # `provider` is the id of a provider registered with dsh, as it appears
    # in Settings -> Models. `keys` are CREDENTIAL NAMES, never key values.
    - provider: my-provider
      keys: [MY_PROVIDER_API_KEY, MY_PROVIDER_API_KEY_2, MY_PROVIDER_API_KEY_3]
    - provider: another-provider
      keys: [ANOTHER_PROVIDER_API_KEY, ANOTHER_PROVIDER_API_KEY_2]
```

| Field | Default | Description |
|---|---|---|
| `switchCodes` | `[QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, UNKNOWN_MODEL]` | Error codes that trigger a key switch. |
| `cooldownMs` | `60000` | How long an exhausted key stays out of rotation. |
| `providers` | — | `[{ provider, keys: [envName, ...] }]`. `keys` are credential/env **names**, not the key values themselves. |

### How keys are stored

The plugin config only ever references keys by **name** (e.g. `MY_PROVIDER_API_KEY`). The values live in the dsh **Credentials** service or `$DSH_HOME/.credentials.yaml` — never in the plugin config.

A key typed into the Key Rotation card is written to that same credentials store: the value travels to the host once and is never sent back to the browser. Only its **last 5 characters** are, so two keys can be told apart in the UI. A key supplied by the launching environment is shown as read-only, because overwriting it here would be shadowed anyway.

## How it works

```
request ──► {provider: rotation} clone route ──► pick next healthy key in pool
        ┌────────┐   on switchable failure retry with next key, stay in cooldown
        └─────────┘
```

- The plugin patches `ctx.credentials.resolve` so a pool reference resolves to the current healthy key (round-robin, skipping keys in cooldown).
- It intercepts `llm/stream` to retry the request on the next key after a switchable failure, instead of surfacing the error to the caller. The hook is deliberately **not** `async`: the loop iterates its result directly, and returning a promise breaks every turn.
- The provider identity never changes — only the resolved key does — which keeps the adapter's replay state consistent across a multi-call turn.

Two local-only routes back the card: `GET /dsh-key-rotation/status` (key state, rotation counters, last 5 characters of each key) and `PUT|DELETE /dsh-key-rotation/key` (store or drop one key value). Both refuse anything that is not a same-origin request from loopback.

## Structure

```
dsh-key-rotation/
├── package.json            # dsh bundle/plugin metadata + peerDependencies
├── cordis.patch.yml        # bundle layer: registers the virtual route "rotation"
├── lib/index.js            # host: pools, credentials.resolve patch, stream retry
├── lib/client.js           # browser: Settings → Key Rotation panel
└── README.md
```

## Security notes

- Key **values** never leave your Credentials store; the plugin config only holds env/credential **names**.
- `switchCodes` are error classification strings, not expressions — no secrets involved.

## License

MIT

---

<a name="-русский"></a>
<details open>
<summary><h2>🇷🇺 Русский (Полное руководство)</h2></summary>

**Автоматическая ротация API-ключей по провайдерам** для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Вместо падения сессии при исчерпании квоты или ошибке rate-limit (HTTP 429), плагин прозрачно повторяет запрос на **следующем работоспособном ключе** из пула провайдера.

> Ротация в стиле Hermes: у каждого настроенного провайдера есть пул ключей; когда лимит ключа исчерпан, запрос мгновенно отправляется со следующим ключом. Исчерпанные ключи отправляются на остывание и возвращаются в ротацию через `cooldownMs`.

## Что умеет плагин

- **Пулы ключей для каждого провайдера** — перечисляйте имена секретов/переменных окружения, между которыми переключается провайдер.
- **Идентичность провайдера не меняется** — ротация подменяет только ключ, но не сам маршрут, поэтому сложные многошаговые вызовы и replay-состояние агента не ломаются. Старые clone-маршруты остаются зарегистрированными, но скрыты из выпадающего списка моделей.
- **Прозрачное переключение при ошибках** — при возникновении переключаемой ошибки (`QUOTA`, `RATE_LIMIT`, `AUTH`/`INVALID`…) запрос мгновенно повторяется со следующим ключом.
- **Кулдаун (остывание)** — исчерпанный ключ пропускается в течение `cooldownMs`, после чего снова пробуется в работе.
- **Обработка отозванных/невалидных ключей** — невалидный ключ сразу уходит в отказ и переключается на следующий ключ пула вместо завершения сессии ошибкой.
- **Интерфейс настроек (Web GUI)** — раздел **Настройки → Ротация ключей** для полного управления без ручной правки конфигов:
  - **Добавление ключа в один клик** — нажмите *Добавить ключ*, вставьте значение, готово. Имя секрета генерируется автоматически (`<PROVIDER>_API_KEY`, далее `_2`, `_3`, …) и отображается только при наведении; в карточке ключи подписаны как *Key 1*, *Key 2*.
  - **Живой статус ключей** — статус каждого ключа: используется / готов / остывает (с таймером обратного отсчёта) / **секрет не найден** (помогает сразу обнаружить опечатку в имени).
  - **Счётчик ротаций** — сколько раз провайдер переключал ключ, на какой именно ошибке и как давно.
  - **Порядок ключей** — кнопки ↑/↓; ключи опрашиваются строго в заданном порядке.
  - **Коды переключения в виде чекбоксов** вместо неудобной строки через запятую.
  - **Экспоненциальный бэкофф** — повторные сбои одного ключа удваивают время его кулдауна (базовый → ×2 → ×4 → макс ×8), благодаря чему мёртвый ключ не долбит API в каждом окне.
  - **Сброс кулдауна** — кнопка *Сбросить кулдаун* мгновенно возвращает все ключи провайдера в строй (также доступно через `POST /dsh-key-rotation/reset`).
  - **Инициализация из окружения** — если ключ уже задан в `process.env`, он подхватывается автоматически.
  - **Индивидуальный кулдаун для провайдера** — переопределение `cooldownMs` (и `maxCooldownMs`) для конкретного сервиса с фолбеком к глобальным настройкам.
  - **Предупреждение об исчерпании всех ключей** — когда все ключи провайдера ушли в кулдаун, карточка подсвечивается красным, а метрики `lastExhaustionAt`/`exhaustionCount` отдаются через `GET /dsh-key-rotation/status`.
  - **Журнал сбоев** — последние 20 сбоев по каждому провайдеру (`время`, `ключ`, `причина`, `кулдаун`) через `/status` и раскрывающийся список *Последние ошибки*.
  - **Страховка для не-стриминговых вызовов** — хук `agent/request-error` повторяет синхронные вызовы (эмбеддинги, батчи) со следующим ключом при возникновении переключаемой ошибки.
  - **Поиск и фильтрация провайдеров** — строка поиска для быстрой фильтрации по ID.
  - **Массовое изменение кулдауна** — чекбоксы выбора провайдеров + ввод времени + *Применить к выбранным*.
  - **Отмена удаления** — при удалении ключа или провайдера на 5 секунд появляется плашка *Отменить*.
  - **Время последнего использования** — отметка «N минут назад» рядом с каждым ключом.
  - **Бейдж общего числа запросов** — суммарное количество обращений по всем ключам провайдера в заголовке.
  - **Экспорт одного провайдера** — кнопка ⬇ сохраняет настройки конкретного провайдера.
  - **Импорт из .env** — выбор файла `.env` с автоматическим добавлением переменных в первый пул.
  - **Копирование имени ключа** — клик по метке *Key N* копирует имя секрета в буфер обмена.
  - **Сортировка по использованию** — кнопка ⇅ сортирует ключи по частоте использования (по убыванию).
  - **История проверок здоровья** — события фонового зондирования отображаются серым цветом в списке сбоев.

## Установка

```bash
# Из npm:
dsh plugin --profile web add @goodandready/dsh-key-rotation

# С GitHub:
dsh plugin --profile web add github:GooDAnDReaDY/dsh-key-rotation

# Локально из репозитория:
dsh plugin --profile web add /path/to/dsh-key-rotation
```

После установки перезапустите Web UI (`systemctl --user restart dsh-web`).

## Настройка

### Web GUI (рекомендуется)

Откройте **Настройки → Ротация ключей** и для каждого провайдера добавьте имена секретов его ключей. Плагин сохраняет эти данные в пространстве настроек `dsh-key-rotation` (вместе с `settings.yaml`).

### `settings.yaml`

```yaml
dsh-key-rotation:
  switchCodes: [QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, UNKNOWN_MODEL]
  cooldownMs: 60000
  providers:
    # provider — идентификатор провайдера, зарегистрированного в dsh (как в Настройки -> Модели)
    # keys — ИМЕНА СЕКРЕТОВ, ни в коем случае не сами значения ключей!
    - provider: my-provider
      keys: [MY_PROVIDER_API_KEY, MY_PROVIDER_API_KEY_2, MY_PROVIDER_API_KEY_3]
    - provider: another-provider
      keys: [ANOTHER_PROVIDER_API_KEY, ANOTHER_PROVIDER_API_KEY_2]
```

| Поле | По умолчанию | Описание |
|---|---|---|
| `switchCodes` | `[QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, UNKNOWN_MODEL]` | Коды ошибок, вызывающие переключение ключа. |
| `cooldownMs` | `60000` | Время нахождения исчерпанного ключа вне ротации (в мс). |
| `providers` | — | `[{ provider, keys: [envName, ...] }]`. Массив провайдеров и имён их секретов. |

### Как хранятся ключи

Конфигурация плагина содержит только **имена** секретов (например, `MY_PROVIDER_API_KEY`). Сами секретные значения хранятся в защищённом сервисе **Credentials** DSH или `$DSH_HOME/.credentials.yaml` — они никогда не попадают в открытый конфиг плагина.

Значение ключа, введённое в карточке интерфейса, передаётся на хост один раз и никогда не возвращается обратно в браузер. Браузер получает только **последние 5 символов**, достаточные для того, чтобы визуально отличить один ключ от другого.

## Архитектура работы

```
запрос ──► {provider: rotation} clone route ──► выбор следующего живого ключа в пуле
        ┌────────┐   при ошибке переключения — повтор со следующим ключом, кулдаун
        └─────────┘
```

- Плагин патчит `ctx.credentials.resolve`, благодаря чему обращение к пулу прозрачно отдаёт текущий здоровый ключ (round-robin с пропуском остывающих).
- Плагин перехватывает `llm/stream` для повторной отправки запроса с новым ключом до начала отдачи чанков клиенту.
- Идентичность провайдера остаётся строго неизменной, что гарантирует целостность сессии и истории вызовов инструментов агента.

Интерфейс опирается на два локальных защищённых маршрута: `GET /dsh-key-rotation/status` (состояние ключей, счётчики, последние 5 символов) и `PUT|DELETE /dsh-key-rotation/key` (сохранение или удаление ключа). Оба маршрута отклоняют любые запросы, кроме локальных loopback same-origin.

## Безопасность

- Сами **значения** ключей никогда не покидают хранилище Credentials; конфиг плагина оперирует исключительно именами переменных.
- `switchCodes` — это строгие классификаторы ошибок, а не исполняемые выражения.

## Лицензия

MIT

</details>

---

<a name="-中文"></a>
<details>
<summary><h2>🇨🇳 中文 (完整技术文档)</h2></summary>

DeepSeek Harness (dsh) 专属的**多服务商 API 密钥智能轮询与故障转移插件**。当遇到配额耗尽或并发限流错误 (HTTP 429) 时，插件将无缝自动切换至服务商密钥池中的**下一个可用健康 Key** 重试请求，彻底告别对话中断。

> Hermes 风格轮询架构：为每个配置的服务商维护一个独立的 Key 密钥池；当当前 Key 额度用尽时，立即切换下一个 Key 重试。耗尽的 Key 进入冷却期，在 `cooldownMs` 结束后自动重返轮询池。

## 核心功能特性

- **多服务商专属密钥池** — 支持为不同模型服务商配置多个 API Key 环境变量或凭据名称。
- **服务商身份完全一致** — 轮询仅在底层替换 Key，绝不改变模型路由标识，确保智能体多轮复杂工具调用与 Replay 状态完美一致。
- **遇到特定错误即时透明重试** — 命中可切换错误码（`QUOTA`、`RATE_LIMIT`、`AUTH`/`INVALID` 等）时，在首个数据块输出前毫秒级自动重试。
- **智能冷却机制** — 额度耗尽的 Key 自动暂停调用 `cooldownMs` 毫秒，冷却结束后自动恢复。
- **失效 Key 自动剔除** — 遇到鉴权失败或已撤销的 Key，自动无缝切至下一个 Key，不再向用户报错。
- **全功能可视化设置面板 (Web GUI)** — 在系统设置中直接提供 **设置 → 密钥轮换 (Key Rotation)** 专属页面：
  - **一站式添加 Key** — 点击 *Add key*，粘贴密钥内容即可。系统自动生成规范的凭据变量名（`<PROVIDER>_API_KEY`、`_2`、`_3` 等），卡片内简洁展示为 *Key 1*、*Key 2*。
  - **Key 实时运行状态** — 明确标记每个 Key 的状态：使用中 (in use) / 就绪 (ready) / 冷却倒计时 (cooling down) / **凭证不存在 (no such credential)**（防止手误输错变量名）。
  - **轮询切换计数器** — 直观记录服务商发生 Key 切换的次数、触发原因及距今时间。
  - **Key 优先级调整** — 提供 ↑/↓ 按钮自由拖拽排序，轮询严格按照列表顺序执行。
  - **可视化切换条件勾选** — 替代生硬的逗号分隔字符串，采用清晰的复选框勾选触发切换的错误码。
  - **指数退避重试 (Exponential backoff)** — 单个 Key 连续失败时冷却时间自动翻倍（基础 → ×2 → ×4 → 上限 ×8），防止彻底失效的 Key 频繁重试。
  - **一键重置冷却状态** — 提供 *Reset cooldown* 按钮可瞬间清空服务商的冷却计时（亦支持 `POST /dsh-key-rotation/reset` 接口）。
  - **环境变量无缝引导** — 若环境变量 `process.env` 中已存在对应 Key，插件将自动直接接管。
  - **服务商独立冷却阈值** — 支持为特定服务商单独重写 `cooldownMs` 与 `maxCooldownMs` 参数。
  - **全池耗尽告警** — 当某服务商所有 Key 均进入冷却状态时，面板呈现醒目红色预警，并输出 `lastExhaustionAt`/`exhaustionCount` 统计。
  - **详细错误日志追溯** — 保留每个服务商最近 20 次切换失败详情（时间、Key、原因、冷却时长），支持在 *Recent failures* 中展开查看。
  - **非流式调用安全托底** — 通过 `agent/request-error` 钩子为 Embedding 和 Batch 等同步调用提供同样的换 Key 重试保护。
  - **服务商快速搜索过滤** — 列表顶部提供 Search 搜索框，毫秒级检索服务商。
  - **批量修改冷却时长** — 支持勾选多个服务商并统一应用新的冷却时间。
  - **误删 5 秒撤销** — 移除 Key 或服务商后弹出 5 秒 *Undo* 撤销操作条。
  - **Key 最近使用时间** — 每个 Key 旁实时显示「N 分钟前使用」。
  - **总请求数徽标** — 在服务商卡片标题处聚合展示所有 Key 的累计请求量。
  - **单个服务商配置导出** — 点击 ⬇ 按钮即可单独导出该服务商的配置项。
  - **从 .env 批量导入** — 支持导入 `.env` 文件，自动提取 `KEY=val` 补充进密钥池。
  - **一键复制 Key 变量名** — 点击 *Key N* 标签即可将凭证变量名复制到剪贴板。
  - **按调用量排序** — 点击 ⇅ 按钮可按使用频度（降序）重新排列 Key。

## 安装指南

```bash
# 从 npm 安装:
dsh plugin --profile web add @goodandready/dsh-key-rotation

# 从 GitHub 安装:
dsh plugin --profile web add github:GooDAnDReaDY/dsh-key-rotation

# 从本地源码安装:
dsh plugin --profile web add /path/to/dsh-key-rotation
```

安装完成后请重启 Web UI 服务 (`systemctl --user restart dsh-web`)。

## 配置说明

### Web GUI 可视化配置（推荐）

进入 **设置 → 密钥轮换 (Key Rotation)**，为对应服务商添加各个 Key 的凭证变量名即可。插件会自动将配置同步持久化至 `settings.yaml`。

### `settings.yaml` 静态配置

```yaml
dsh-key-rotation:
  switchCodes: [QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, UNKNOWN_MODEL]
  cooldownMs: 60000
  providers:
    # provider 为 dsh 中注册的服务商 ID (如在 设置 -> 模型 中所见)
    # keys 必须是凭据变量名 (CREDENTIAL NAMES)，切勿直接填写明文 Key！
    - provider: my-provider
      keys: [MY_PROVIDER_API_KEY, MY_PROVIDER_API_KEY_2, MY_PROVIDER_API_KEY_3]
    - provider: another-provider
      keys: [ANOTHER_PROVIDER_API_KEY, ANOTHER_PROVIDER_API_KEY_2]
```

| 配置字段 | 默认值 | 详细作用说明 |
|---|---|---|
| `switchCodes` | `[QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, UNKNOWN_MODEL]` | 触发换 Key 轮询的错误码列表。 |
| `cooldownMs` | `60000` | Key 额度耗尽后暂停调用的冷却时间 (毫秒)。 |
| `providers` | — | `[{ provider, keys: [envName, ...] }]` 服务商与凭据变量名对照列表。 |

### 密钥存储与安全保障

插件配置中仅保存 Key 的**变量名称**（如 `MY_PROVIDER_API_KEY`）。真正的密钥明文安全存储在 DSH **Credentials** 凭据中心或 `$DSH_HOME/.credentials.yaml` 中，绝不泄露至开放配置文件。

在设置面板中填写的 Key 仅在提交时向后端传输一次，前端仅回显**末尾 5 位字符**用于视觉辨别。

## 运行工作原理

```
请求发起 ──► {provider: rotation} 虚拟路由 ──► 从池中选取当前可用健康 Key
          ┌────────┐   遇到可切换错误时立即选用下一个 Key 重试，原 Key 进入冷却
          └─────────┘
```

- 插件底层挂载 `ctx.credentials.resolve` 钩子，解析请求时自动按轮询策略分发可用 Key。
- 拦截 `llm/stream` 输出流，遇到错误在向前端发送数据块前静默重试。
- 全程保持模型服务商唯一标识不变，确保会话上下文与多步骤工具链调用的稳定性。

配套提供两组本地专属管理接口：`GET /dsh-key-rotation/status`（状态读取）与 `PUT|DELETE /dsh-key-rotation/key`（密钥存取），仅限本机 Loopback Same-Origin 调用。

## 安全规范

- 密钥**明文**绝不离开 Credentials 凭证服务。
- `switchCodes` 为严格受控的错误枚举，不涉及任何可执行代码注入风险。

## 开源协议

MIT

</details>
