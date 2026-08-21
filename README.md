# dsh-money

> DeepSeek Harness 费用追踪插件 —— 实时显示账号余额、当前对话费用与每次回复费用，全部金额以金色标签（徽章）风格展示。

![License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)

## 功能

| 显示项 | 说明 |
|---|---|
| **账号剩余金额** | 调用 DeepSeek `GET /user/balance` 接口获取，60 秒缓存自动刷新 |
| **当前对话费用** | 折叠会话日志中每条 `assistant/message` 的 token 用量，按官方价目表实时计价并求和 |
| **每次回复费用** | 逐条回复独立计价，以金色标签显示在回复按钮行右侧 |

### 界面

- **输入框下方统计行**（`conversation.composer.dock`）：`余额 [¥xx.xx] · 本对话 [¥x.xxxx] · 上次回复 [¥x.xxxx]`，全部金额为金色徽章样式，30 秒自动刷新
- **每条回复费用标签**（`conversation.chat.assistant-actions`）：紧跟分支按钮右侧（时间戳保持最右），悬停显示模型与 token 明细（输入未命中 / 缓存命中 / 缓存写入 / 输出）
- **设置页 → General**：可切换显示币种（自动跟随余额 / 人民币 ¥ / 美元 $）

### 计价口径

基于 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（2026-08 版，峰值价 = 空闲价 × 2）：

| 模型 | 币种 | 缓存命中（空闲） | 未命中（空闲） | 输出（空闲） |
|---|---|---|---|---|
| deepseek-v4-flash | ¥ / $ | 0.05 / 0.007 | 1.5 / 0.22 | 4.5 / 0.66 |
| deepseek-v4-pro | ¥ / $ | 0.15 / 0.022 | 4.5 / 0.66 | 13.5 / 1.98 |

> 单位：每百万 token。高峰时段 = 北京时间 9:00-12:00、14:00-18:00（即 UTC 01:00-04:00、06:00-10:00），价格翻倍。
>
> 账单口径：未命中输入（含 cache write）× miss 价 + 缓存命中 × hit 价 + 输出 × out 价。
>
> ⚠️ 费用为基于官方公开价目的估算值，不代表供应商最终账单。

## 安装

### 方式一：dsh 插件（推荐）

```bash
# 进入你的 dsh 配置目录（本机示例）
cd ~/.dsh/profiles/web

# 安装本插件
pnpm add dsh-money
```

安装后在配置中添加插件行（详见 [cordis 文档](https://github.com/deepseek-ai/deepseek-harness)）：

```yaml
plugins:
  - dsh-money
```

### 方式二：动态插件（手动定义）

在 DSH 会话中让 Agent 执行 `cordis_define` 定义插件，代码见 [`src/host.js`](src/host.js)（host 半段）与 [`src/client.js`](src/client.js)（client 半段）。

## 配置

插件自动读取已有 DeepSeek 配置：

- **API Key**：`ctx.credentials` 服务（默认引用 `DEEPSEEK_API_KEY`），也可通过设置 `llm-deepseek.apiKeyEnv` 覆盖
- **Base URL**：默认 `https://api.deepseek.com`，可通过设置 `llm-deepseek.baseURL` 覆盖（兼容网关/代理）

**显示币种**：设置页 → General → “费用显示货币”，可选：

- `自动（跟随余额）`：余额为 USD 则按美元价目显示，否则按人民币
- `人民币 ¥` / `美元 $`：强制按对应价目表计算并显示

> 币种设置保存在插件进程内（动态插件特性），重启后恢复为“自动”。

## 开发

```bash
git clone https://github.com/yanhuifair/dsh-money.git
cd dsh-money
npm install
```

插件源码结构：

```
src/
├── host.js      # Host 半段：余额拉取 + 会话费用折叠 + RPC handler
└── client.js    # Client 半段：金色标签 UI（dock 统计行 / 每条回复费用 / 设置行）
```

## 许可证

[GNU Affero General Public License v3.0](LICENSE) © yanhuifair

AGPL-3.0 是强 copyleft 协议：你可以自由使用、修改与分发，但基于本插件的修改版本必须同样以 AGPL-3.0 开源，并保留版权声明。
