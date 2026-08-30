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

Per-provider API key rotation for DeepSeek Harness: key pools, automatic failover on rate limits (HTTP 429), cooldown probing, and a dedicated Settings UI.

### Features

- **Transparent Rotation**: Requests always retain their selected provider identity while rotating underlying API keys round-robin.
- **Automatic 429 Failover**: Intercepts `llm/stream` and retries switchable errors (rate limits, quota exhaustion) on the next available key before streaming chunks.
- **Cooldown & Recovery Probing**: Exhausted keys enter cooldown (`cooldownMs`) and are probed in the background for quota recovery.
- **Settings GUI**: Intuitive card in Settings to manage key pools, cooldown intervals, and error codes.

### Install

```bash
dsh plugin --profile web add @goodandready/dsh-key-rotation
```

### Configuration (Web GUI)

Settings → **Plugins → Plugin settings → Key Rotation**:
- Pick a provider registered with DSH.
- Add/remove API key environment variable references (e.g. `OPENAI_API_KEY`, `OPENAI_API_KEY_2`).

---

<a name="-русский"></a>
<details open>
<summary><h2>🇷🇺 Русский (Полное руководство)</h2></summary>

Автоматическая ротация пулов API-ключей для DeepSeek Harness: пулы ключей, авто-переключение при ошибках 429 и превышении квот, проверка восстановления и панель настроек.

### Возможности

- **Прозрачная ротация**: идентификатор провайдера остаётся неизменным для сессии, меняется только подставляемый ключ из пула.
- **Отработка 429 на лету**: перехватывает ошибки лимитов и квот в `llm/stream` и автоматически повторяет запрос со следующим ключом.
- **Остывание и проверка квот**: исчерпанный ключ отправляется в кулдаун (`cooldownMs`) и периодически опрашивается на предмет восстановления.
- **Интерфейс настроек**: удобный список пулов ключей по провайдерам прямо в панели настроек.

### Установка

```bash
dsh plugin --profile web add @goodandready/dsh-key-rotation
```

</details>

---

<a name="-中文"></a>
<details>
<summary><h2>🇨🇳 中文 (完整技术文档)</h2></summary>

DeepSeek Harness API 密钥池自动轮询与限流故障转移插件：支持多 Key 轮换、429 限流瞬间重试、冷却探测及专属设置面板。

### 核心亮点

- **透明轮换机制**：保持模型服务商身份一致，仅在底层轮询切换有效的 API Key。
- **429 限流瞬时切换**：拦截 `llm/stream` 错误，遇配额耗尽或并发限制时自动切换至下一个可用密钥重试。
- **冷却与恢复探测**：超额密钥进入冷却期 (`cooldownMs`)，后台定时探测配额重置情况。
- **可视化管理面板**：在系统设置中轻松管理各服务商的 Key 列表与切换策略。

### 安装方法

```bash
dsh plugin --profile web add @goodandready/dsh-key-rotation
```

</details>
