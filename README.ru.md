# 📦 @goodandready/dsh-key-rotation

<div align="center">

<h3>Прозрачная ротация API-ключей и мгновенное переключение при лимитах 429 для DeepSeek Harness</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@goodandready/dsh-key-rotation"><img src="https://img.shields.io/npm/v/@goodandready/dsh-key-rotation.svg?style=for-the-badge&color=6366f1&labelColor=1e1b4b" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/GooDAnDReaDY/dsh-key-rotation.svg?style=for-the-badge&color=10b981&labelColor=064e3b" alt="license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-8b5cf6.svg?style=for-the-badge&labelColor=2e1065" alt="DSH Plugin"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-20%2B-f59e0b.svg?style=for-the-badge&labelColor=451a03" alt="Node version"></a>
</p>

<p align="center">
  <a href="README.md"><b>🇬🇧 English</b></a> •
  <a href="README.ru.md"><b>🇷🇺 Русский</b></a> •
  <a href="README.zh.md"><b>🇨🇳 中文说明</b></a>
</p>

</div>

---

## ⚡ Обзор

**`dsh-key-rotation`** обеспечивает прозрачную ротацию пулов API-ключей для каждого провайдера в **DeepSeek Harness**. При исчерпании лимитов или ошибках rate-limit (HTTP 429) запрос мгновенно и незаметно для пользователя повторяется со **следующим работоспособным ключом**.

```mermaid
graph LR
    subgraph Incoming [Запрос к LLM]
        Req[Сообщение пользователя / агента] --> Adapter[Адаптер модели pi-ai]
    end

    subgraph Rotation [Слой ротации ключей]
        Adapter --> Interceptor[Хук llm/stream]
        Interceptor --> Resolve{ctx.credentials.resolve}
        Resolve -->|Выбор активного| K1[Ключ 1: Активен]
        Resolve -.->|При ошибке 429 / Квота| K2[Ключ 2: Резерв]
        Resolve -.->|Экспоненциальный бэкофф| Cooldown[Пул остывания]
    end

    subgraph Providers [Внешний API сервис]
        K1 --> API[OpenAI / Claude / DeepSeek]
        K2 --> API
    end

    style Incoming fill:#1e1e2e,stroke:#89b4fa,stroke-width:2px,color:#cdd6f4
    style Rotation fill:#181825,stroke:#cba6f7,stroke-width:2px,color:#cdd6f4
    style Providers fill:#11111b,stroke:#a6e3a1,stroke-width:2px,color:#cdd6f4
```

---

## ✨ Ключевые возможности

* 🔄 **Прозрачная ротация**: сохраняет идентичность провайдера и состояние сессии при смене ключей.
* ⚡ **Мгновенная отработка 429**: перехватывает ошибки `QUOTA`, `RATE_LIMIT`, `AUTH` до отправки первого чанка клиенту.
* 📈 **Экспоненциальный бэкофф**: повторные сбои удваивают время кулдауна ключа (базовый → ×2 → ×4 → макс ×8).
* 🖥️ **Панель управления (Web GUI)**: раздел **Настройки → Ротация ключей** с живым статусом, таймерами остывания и сортировкой ↑/↓.
* 🛡️ **Безопасность секретов**: значения ключей не покидают хранилище Credentials (браузер видит только последние 5 символов).
* 📥 **Импорт из `.env`**: быстрое добавление ключей списком из файлов окружения.

---

## 📦 Быстрая установка

```bash
dsh plugin --profile web add @goodandready/dsh-key-rotation
```

---

## 📄 Лицензия

MIT © [GooDAnDReaDY](https://github.com/GooDAnDReaDY)
