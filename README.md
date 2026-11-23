# SillyTavern Native Bridge

给 SillyTavern 1.17.0 的插件，在「聊天补全 → 自定义」加上协议选择。直接使用酒馆现有的渠道 URL、Key 和模型 ID，向上游发送 Claude Messages 或 Gemini generateContent 原生请求。支持普通和流式回复。

## 在酒馆界面安装（无需服务端插件）

1. 打开「扩展 → 安装扩展」，粘贴本仓库的 Git URL，然后刷新网页。
2. 在「API 连接 → 聊天补全 → 自定义」填写渠道 URL 和模型 ID，选择 Gemini 或 Claude 兼容，并选「免服务端安装」。
3. 在新增的「原生模式渠道 Key」栏填 Key，发一条消息测试。Key 只保留在当前页面，刷新后要重新填；模型 ID 仍由酒馆保存，无需拉取列表。

此模式调用酒馆已有接口：Gemini 使用 `v1beta` 和 `key` 查询参数（酒馆如有自定义 Gemini 版本，以该设置为准）；Claude 使用 `v1/messages` 和 `x-api-key`。如果渠道要求 Bearer 或 Gemini 的 `x-goog-api-key`，请使用下方的服务端插件模式。私有仓库需要酒馆所在机器上的 Git 凭据有读取权限。

## 可选：服务端插件模式

同一个 Git 仓库提供两部分：酒馆界面里的协议选择器，以及服务端的协议转换插件。酒馆自带的「安装扩展」只会安装选择器。

1. 在酒馆根目录执行 `node plugins.js install <插件仓库 Git URL>`，或把插件目录放入酒馆的 `plugins/`。
2. 在酒馆 `config.yaml` 中设置 `enableServerPlugins: true`，重启酒馆。无需安装额外依赖。
3. 在酒馆打开「扩展 → 安装扩展」，粘贴同一个 Git URL。刷新网页后，扩展管理器里会显示 **Native Bridge Protocol Selector**。私有仓库需要酒馆所在机器上的 Git 凭据有读取权限。

如果已经用 `node index.cjs --install-ui` 安装了选择器，前端已经可用，不需要再装一份。该命令也可以替代第 3 步。界面的扩展更新只更新选择器；服务端可在酒馆根目录用 `node plugins.js update` 更新，更新后重启酒馆。

## 使用

使用服务端插件模式时，在「API 连接 → 聊天补全 → 自定义（OpenAI 兼容）」填写渠道自己的端点、API Key 和模型 ID。选好「协议格式」和对应的「服务端插件」认证方式，点「连接」，然后发消息验证。切换协议不会改写这些字段。协议和认证选项会记在当前浏览器；切换酒馆连接配置后，确认下拉框仍匹配所用渠道。

| 协议 | 渠道 URL 示例 | 认证选项 |
| --- | --- | --- |
| Claude 兼容 | `https://relay.example/anthropic/v1` 或 `https://relay.example/anthropic/v1/messages` | `x-api-key`（默认）或 `Authorization: Bearer` |
| Gemini 兼容 | `https://relay.example/google/v1beta`，也可填到 `/models` 或完整 `:generateContent` 地址 | `x-goog-api-key`（默认）、`Authorization: Bearer` 或 `key` 查询参数 |
| OpenAI 兼容 | 沿用酒馆自带的自定义连接 | 酒馆默认行为 |

URL 中不要写 Key 或其他查询参数。原生模式下，请在「模型 ID」手动填入渠道提供的 ID，酒馆会保存。点「连接」时，插件直接用这个 ID 填充「可用模型」，无需向渠道拉取列表；实际生成时才会验证上游连接。使用多个模型时可分别保存酒馆连接配置。如果是从旧版升级、填过 `127.0.0.1:8010` 或 `bridgeToken`，把这两项换回真实渠道 URL 和 Key 即可。旧版 `config.local.json` 不再读取。

## 范围与隐私

- 插件通过酒馆现有会话和 HTTP 监听提供服务，密钥从酒馆当前用户的密钥存储读取，不开额外端口。插件不打印密钥、上游错误正文或聊天内容。所选渠道会收到用于生成的消息。
- 支持单候选文本、内嵌图片输入、上游返回的思考文本。不支持工具调用、结构化输出、图片生成或 Vertex AI。
- 本地测试：`npm test`。测试使用模拟上游和占位密钥。
