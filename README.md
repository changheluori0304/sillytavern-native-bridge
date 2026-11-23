# SillyTavern Native Bridge

给 SillyTavern 1.17.0 的插件，在「聊天补全 → 自定义」加上协议选择。直接使用酒馆现有的渠道 URL、Key 和模型 ID，向上游发送 Claude Messages 或 Gemini generateContent 原生请求。支持普通和流式回复。

## 安装

1. 在酒馆根目录执行 `node plugins.js install <插件仓库 Git URL>`，或把插件目录放入酒馆的 `plugins/`。
2. 进入装好的插件目录，执行 `node index.cjs --install-ui`。更新插件后也执行一次此命令。
3. 在酒馆 `config.yaml` 中设置 `enableServerPlugins: true`，重启酒馆并刷新网页。无需安装额外依赖。

## 使用

打开「API 连接 → 聊天补全 → 自定义（OpenAI 兼容）」，填写渠道自己的端点、API Key 和模型 ID。选好「协议格式」，点「连接」，然后发消息验证。切换协议不会改写这些字段。协议和认证选项会记在当前浏览器；切换酒馆连接配置后，确认下拉框仍匹配所用渠道。

| 协议 | 渠道 URL 示例 | 认证选项 |
| --- | --- | --- |
| Claude 兼容 | `https://relay.example/anthropic/v1` 或 `https://relay.example/anthropic/v1/messages` | `x-api-key`（默认）或 `Authorization: Bearer` |
| Gemini 兼容 | `https://relay.example/google/v1beta`，也可填到 `/models` 或完整 `:generateContent` 地址 | `x-goog-api-key`（默认）、`Authorization: Bearer` 或 `key` 查询参数 |
| OpenAI 兼容 | 沿用酒馆自带的自定义连接 | 酒馆默认行为 |

URL 中不要写 Key 或其他查询参数。原生模式下，「连接」跳过 OpenAI 的模型列表检查；请手动填模型 ID，实际生成时才会验证上游连接。如果是从旧版升级、填过 `127.0.0.1:8010` 或 `bridgeToken`，把这两项换回真实渠道 URL 和 Key 即可。旧版 `config.local.json` 不再读取。

## 范围与隐私

- 插件通过酒馆现有会话和 HTTP 监听提供服务，密钥从酒馆当前用户的密钥存储读取，不开额外端口。插件不打印密钥、上游错误正文或聊天内容。所选渠道会收到用于生成的消息。
- 支持单候选文本、内嵌图片输入、上游返回的思考文本。不支持工具调用、结构化输出、图片生成或 Vertex AI。
- 本地测试：`npm test`。测试使用模拟上游和占位密钥。
