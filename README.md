# dsh-llm-omni

把本地 [OmniAPI](../README.md) 注册为 **DeepSeek Harness（DSH）** 的 LLM provider。

装载后，DSH 的模型选择器里会多出一个 `omni` 来源，模型列表直接取自
OmniAPI 的 `GET /v1/models`（含上下文长度、输出上限与能力声明）。

## 为什么需要它

DSH 已内置 `@deepseek-ai/dsh-llm-pi-ai`，支持用 `api: openai-completions`
把任意 OpenAI 兼容网关接进来，**纯配置就能连上 OmniAPI**。本插件存在的理由
是下面两点配置做不到的事：

| 能力 | pi-ai 网关配置 | 本插件 |
|------|---------------|--------|
| 读取 OmniAPI 的上下文/输出上限元数据 | 忽略扩展字段 | 直接采用 |
| 把 `reasoning_content` 映射为 DSH 的 reasoning 块 | 需试探 `compat`，常丢失或混入正文 | 显式分离 |
| 免手填 baseURL 与模型 | 需手写 | 默认指向本地 |

> 如果你只想要"能连上"，用 pi-ai 配置即可，不必装本插件。

## 安装

```sh
dsh plugin --profile <profile> add <本目录路径>
```

或从本地路径安装：

```sh
dsh plugin --profile web add file:/path/to/Any2api/dsh-llm-omni
```

安装后重启 DSH，模型选择器中会出现 `omni`。

## 配置

在 `cordis.patch.yml` 中覆盖（profile 根目录）：

```yaml
- id: omni
  config:
    baseURL: http://127.0.0.1:8080
    apiKeyEnv: OMNI_API_KEY      # 读取该环境变量作为 OmniAPI 的 API Key
    providerName: OmniAPI
    timeoutMs: 300000
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `baseURL` | `http://127.0.0.1:8080` | OmniAPI 服务地址 |
| `apiKeyEnv` | `OMNI_API_KEY` | 存放 OmniAPI API Key 的环境变量名 |
| `apiKey` | — | 直接给明文 Key（不推荐，会进配置文件） |
| `providerId` | `omni` | 路由名，即 DSH 里选择时看到的 provider id |
| `providerName` | `OmniAPI` | 选择器中的展示名 |
| `timeoutMs` | `300000` | 单次请求超时 |

## 凭据边界

本插件**不接触任何上游凭据**：

- 上游的 DeepSeek token / 账号只存在于 OmniAPI 的凭据池中；
- 插件只用 OmniAPI 自己的 API Key 与本地服务通信；
- 日志不打印 `Authorization` 头。

因此即使 DSH 的配置文件泄露，也不会泄露上游账号。

## 流式映射

| OmniAPI (OpenAI Chat Completions) | DSH chunk |
|---|---|
| `delta.reasoning_content` | `reasoning` 块 + `reasoning-delta` |
| `delta.content` | `text` 块 + `text-delta` |
| `delta.tool_calls[].index` | `tool-call-delta`（以 index 为稳定主键） |
| `usage` | `usage { inputTokens, outputTokens }` |
| `finish_reason` | `finish { kind }` |
| `data: {"error":{...}}` | 抛 `LlmError`，**不**当作文本 |

最后一行是刻意为之：OmniAPI 在流内失败时下发错误对象，若把它当正文，
用户会把报错读成模型回答。

## 测试

```sh
npm test                    # 单元 + DSH 契约测试（29 项）
npm run test:e2e            # 真实 OmniAPI 端到端（需服务已启动）
```

`contract.test.js` 用**真实的** `@deepseek-ai/dsh-llm` 的 `LlmRuntime`
装载本适配器，校验 DSH 的运行时约束（`provider` 必须等于注册路由、
`context` 必须是 `{ contextWindow }` 等）。这些约束只存在于 DSH 实现里，
不测就只能等真实启动时才发现。DSH 未安装时该组自动跳过。

端到端：

```sh
OMNI_API_KEY=<OmniAPI 的 API Key> npm run test:e2e
```
