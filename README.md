# dsh-llm-omni

把 **OmniAPI 的转发能力内嵌进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）** 的插件。

**装完即用**：安装后在 DSH 设置页填入上游 DeepSeek 账号或 Token，
模型选择器里就能选到 `omni` 开始对话。不需要另外启动 OmniAPI，
不需要填服务地址，不需要编辑配置文件。

## 它是什么

OmniAPI 把一个 DeepSeek Web 账号池包装成 OpenAI 兼容 API。本插件把它的
转发内核（凭据池、PoW 求解、上游流解析）**整份随插件分发**，在 DSH 进程内
直接运行——因此没有"先起服务再连过去"这一步。

```
DSH 进程
└── dsh-llm-omni 插件
    ├── lib/adapter.js       DSH 的 LlmAdapter 契约实现
    ├── lib/runtime.js       内核引导 + 配置隔离
    ├── lib/credentials.js   设置页的凭据读写
    ├── lib/routes.js        设置页的本机状态端点
    └── kernel/              ← 从主项目 src/ 同步的转发内核
```

## 安装

```sh
dsh plugin --profile <profile> add <本目录路径>
```

装好后打开 DSH 设置页，找到 **OmniAPI** 一节：

1. 选择「添加 Token」粘贴 DeepSeek Web Token，或「添加账号」填邮箱密码
2. 保存后点「测试全部凭据」确认可用
3. 在模型选择器里选 `omni` 开始对话

## 与"用 pi-ai 网关连 OmniAPI"的区别

DSH 内置的 `dsh-llm-pi-ai` 支持 `api: openai-completions` 指向任意
OpenAI 兼容网关，纯配置就能连上 OmniAPI。本插件的增量在于：

| | pi-ai 网关配置 | 本插件 |
|---|---|---|
| 需要 OmniAPI 独立运行 | 是 | **否** |
| 需要手填地址与 Key | 是 | **否** |
| 读取模型能力元数据 | 忽略扩展字段 | 直接采用 |
| 分离 `reasoning_content` | 需试探 `compat` | 显式映射 |
| 在 DSH 里看凭据死活 | ❌ | ✅ 设置页 |

## 配置

一般不需要改。需要覆盖时在 profile 的 `cordis.patch.yml`：

```yaml
- id: omni
  config:
    dataDir: C:/Users/<you>/.dsh/plugin-data/dsh-llm-omni
    providerId: omni
    providerName: OmniAPI
    contextWindow: 1048576
    maxOutputTokens: 65536
    kernelTimeoutMs: 60000
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `dataDir` | `<DSH_HOME>/plugin-data/dsh-llm-omni` | 凭据与配置的落盘位置 |
| `providerId` | `omni` | 路由名 |
| `providerName` | `OmniAPI` | 选择器展示名 |
| `contextWindow` | `1048576` | 上报给 DSH 的上下文长度 |
| `maxOutputTokens` | `65536` | 上报给 DSH 的输出上限 |
| `kernelTimeoutMs` | `60000` | 首次对话等待凭据池就绪的上限 |

## 数据与安全

- 凭据只存在 `dataDir/config.json`，**不写入 DSH 的 profile 配置**
- 插件会强制把内核的配置路径指向自己的 `dataDir`，不会读到主项目
  OmniAPI 的 `.env` / `config.json`（避免两套系统共用账号）
- 设置页与 HTTP 响应只返回掩码（`abcdef...7890`），不提供"查看明文"入口
- 状态端点仅接受本机请求，并校验 Host / Origin 防 DNS rebinding

## 关于 `kernel/`

`kernel/` 是从主项目 `src/` 生成的副本，**不要手改**。主项目修复后同步：

```sh
npm run sync:kernel     # 从 ../src 重新生成
npm run check:kernel    # 检查是否漂移（CI 用）
```

## 测试

```sh
npm test          # 45 项（DSH 未安装时 3 项契约测试自动跳过）
npm run test:e2e  # 真实上游对话，需 OmniAPI_TOKEN
```

`contract.test.js` 用**真实的** `@deepseek-ai/dsh-llm` 的 `LlmRuntime`
装载本适配器，校验 DSH 未文档化的运行时约束（`provider` 必须等于注册路由、
`context` 必须是 `{ contextWindow }`、`defaultMaxTokens` 等）。

端到端：

```sh
OMNI_TOKEN=<DeepSeek Web Token> npm run test:e2e
```

## 限制

- 只在 `dsh 0.2.1-rc.2` 上做过契约级验证；`rc.3` 需实机确认。
- 图片仅支持 URL 或 base64 data；本地附件引用需要宿主附件服务内联。
