# 📦 @goodandready/dsh-key-rotation

<div align="center">

<h3>DeepSeek Harness Hermes 架构透明 API 密钥池轮换与 429 限流容灾插件</h3>

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

## ⚡ 插件概览

**`dsh-key-rotation`** 为 **DeepSeek Harness** 提供透明的多服务商 API Key 密钥池智能轮询服务。当遇到 HTTP 429 限流或额度耗尽时，系统自动无缝切换至池中**下一个健康可用 Key** 重试请求。

```mermaid
graph LR
    subgraph Incoming [LLM 请求流]
        Req[用户 / 智能体对话] --> Adapter[pi-ai 模型适配层]
    end

    subgraph Rotation [密钥轮询调度层]
        Adapter --> Interceptor[llm/stream 拦截器]
        Interceptor --> Resolve{ctx.credentials.resolve}
        Resolve -->|选取健康 Key| K1[Key 1: 活跃中]
        Resolve -.->|命中 429 限流 / 超额| K2[Key 2: 热备用]
        Resolve -.->|指数退避冷却| Cooldown[冷却降级池]
    end

    subgraph Providers [上游大模型服务]
        K1 --> API[OpenAI / Claude / DeepSeek]
        K2 --> API
    end

    style Incoming fill:#1e1e2e,stroke:#89b4fa,stroke-width:2px,color:#cdd6f4
    style Rotation fill:#181825,stroke:#cba6f7,stroke-width:2px,color:#cdd6f4
    style Providers fill:#11111b,stroke:#a6e3a1,stroke-width:2px,color:#cdd6f4
```

---

## ✨ 核心亮点

* 🔄 **透明轮换架构**：全程保持模型路由与会话上下文状态不变，仅在底层切换鉴权 Key。
* ⚡ **429 限流毫秒级切换**：拦截可切换异常并在首个输出 Token 产生前完成静默重试。
* 📈 **指数退避重试机制**：单个 Key 连续失败冷却时间自动翻倍（基础 → ×2 → ×4 → 上限 ×8）。
* 🖥️ **全功能设置面板 (GUI)**：在 **设置 → 密钥轮换** 中直观查看状态、倒计时与优先级调整。
* 🛡️ **密钥安全零泄露**：明文安全保存在服务端凭据库中，前端仅脱敏回显末尾 5 位字符。

---

## 📦 安装指南

```bash
dsh plugin --profile web add @goodandready/dsh-key-rotation
```

---

## 📄 开源协议

MIT © [GooDAnDReaDY](https://github.com/GooDAnDReaDY)
