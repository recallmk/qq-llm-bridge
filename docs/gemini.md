# Gemini / Antigravity QQ 桥接

链路：QQ → NapCat OneBot v11 WebSocket → Node 桥接 → Antigravity CLI。此实现和 DeepSeek 桥接是两个独立实例，不会自动共用登录或记忆。

以下命令与路径均相对于仓库中的 `gemini-QQ` 目录。`bridge/vendor/dsh-fish` 需联接或复制自仓库的 `qq-src/vendor/dsh-fish`。

## 配置和启动

1. 在 Windows 上安装 Node.js 24 或更新版本、QQ、NapCat 和支持 stream-json 协议的 Antigravity CLI，登录各自账号。软件及账号状态不包含在仓库中。
2. 配置 NapCat 的 OneBot v11 正向 WebSocket，例如 `127.0.0.1:3002`，并登录 QQ。不要把服务暴露到公网。
3. 将 `bridge/config.example.json` 复制为 `bridge/config.json`，填入 `expectedBotQq`、`ownerQq`、`allowUsers`，以及 `antigravity.bin` 和 `antigravity.home` 的绝对路径；如需网络代理，在 `antigravity.proxy` 填入本机代理地址。该配置和登录资料不要提交。`allowGroups: []` 在开启群聊时表示不限群，请先配置允许的群。
4. 在本目录创建 `work` 目录，按 CLI 的登录方式准备 `antigravity.home` 中的账号资料；然后运行 `node bridge/bridge.mjs`。如需 MCP 工具，需要自行配置 Antigravity 的 MCP 服务器，入口为 `bridge/mcp-antigravity.mjs`；默认工具关闭。
5. 观测台默认 `http://127.0.0.1:3103/fish`，token 保存在 `bridge/control-token.txt`，请勿分享。服务必须保持本机访问。

示例默认关闭群聊、工具、表情、空间和成长功能。Antigravity CLI 的图片输入在此实现中尚未接通；需自行提供依赖并核对登录及连接状态。仓库没有包含原机器的启动器、代理、表情资源或账号数据。

## Scheduled public reading and publishing

The optional shared social module is loaded from a private bridge/social.config.json. It keeps this bot’s task state, public memory and interests separate, uses an explicitly authorized platform account, and never grants additional QQ/desktop permissions. A subscription-only deployment must explicitly disable extra AI credits and use bounded requests. The current CLI has no verified provider-side output-token limit. See [the social module handoff](social.md). The disabled configuration example contains no account or credentials.


## Gemini 专属表情图库

Gemini 默认使用桥接目录下的 stickers-gemini-purple，形象为紫蓝长发、猫耳猫尾、异色瞳的 Gemini 猫娘。运行配置的 stickers.dir 可指定独立本地目录。图库与 DeepSeek 分离；不要把路径指向 DS 图库，也不要复制 DS 素材作为 Gemini 默认表情。catalog.json 保存检索 ID、台词、画面描述、情绪、适用场景和来源信息。模型只拿到描述和不透明 ID，通过现有检索/发送工具选择；群聊权限、每轮上限和冷却保持原有规则。

图片、实际图库目录、私有运行配置及本机交接不进入 Git。素材出处和授权状态须在本机保留；聊天梗图不自动成为公开平台原创素材。保持原有随机发送概率设置，不为了安装图库发送 QQ 测试消息。


## CLI reply completion and diagnostics

A turn completes on its terminal stream-json result. A successful result is saved and forwarded independently of CLI shutdown; later teardown must not turn a completed reply into a failure. The driver keeps input open until completion, parses a final unterminated JSON line, reads canonical tool_info.name, and bounds cleanup to the CLI tree spawned for that turn. Scene mappings and QQ context tokens remain separate, and uncertain submissions are never replayed automatically.

The loopback status exposes cached conversation count, the last confirmed success/failure and draining processes. A historical conversation mapping does not prove live model readiness after a restart. Private runtime-diagnostics records contain only protocol counts/status, response length, controlled error codes and tool names; they exclude chat text, raw stderr, credentials and tool arguments. Startup authentication warnings cannot override a terminal failure. Model/provider, account, permissions and subscription settings are preserved.


A resumed CLI conversation can return ERROR even when its new reply is complete. The chat adapter verifies that the conversation ID is unchanged, the final streamed reply is DONE and exactly matches result.response, and the read-only conversation database agrees with the latest step. Every current database step must be completed or a narrowly recognized local rejection. Missing evidence, incomplete model steps, unknown failures, uncertain sends, authentication, quota, transport, interruption and safety errors remain failures. JSON/social automation continues to require provider SUCCESS.

Known chat-only warnings cover a sticker ID rejected before sending, sticker cooldown, a missing local sticker file, and unavailable xhs resource discovery (server not allowed or the list_resources tool not registered). These operations remain rejected. The final reply may continue after those warnings; no platform tool is installed and no permission is widened. The adapter retains providerStatus=ERROR, records the exact controlled warning codes and step indexes, and exposes lastWarning. A rejected compatibility check records verificationFailure without chat text or credentials. History is preserved.

Chat prompts distinguish the independently scheduled social worker from tools available in the current QQ turn, and cannot claim that browsing or publishing just happened without supplied execution evidence. Gemini sticker schemas describe its own purple catgirl library and require a fresh lookup in the same turn; a sticker failure does not require abandoning the text reply.

Validation on 2026-11-03 included source syntax, private configuration parsing and two bounded real-model probes. The first action-denied real-model probe failed because unavailable discovery was reported as an unregistered tool. After recognizing that narrowly defined rejection, a second probe resumed the original private conversation, attempted the rejected discovery, and returned the requested marker in about 37.1 seconds. Streamed text arrived in chunks and matched the final response; the current-turn/database checks accepted it with a tool warning while preserving provider ERROR. All MCP actions, commands, file/URL operations and additional AI credits were denied. No QQ test message, browsing/publishing probe, regression suite or historical offline self-check was run. QQ text delivery and broader behavior still require natural operation.

## Startup network recovery

QQ chat uses promptWithStartupRetry for one reconnect after a two-second delay, within the original reply timeout. This is allowed only for an explicit CLI eligibility-check transport failure, a single ERROR result with no init/input/steps/tools/reply, and an unchanged existing conversation database head. Queuing text to CLI stdin does not establish model submission. Missing database evidence, any initialized conversation, changed steps, authentication/quota/access failures and uncertain delivery prevent retry. Historical failed QQ turns are never replayed. JSON/social tasks keep their existing request and success rules.

Private diagnostics distinguish queued input from observed model input and record only controlled failure phase/cause/retry-safety fields. EOF, connection reset/refusal, DNS, timeout, TLS and service failures no longer collapse into an opaque model error. Local executor/model-metadata failures have their own non-retryable code. Loopback status adds lastStartupRetry with its delay and optional recoveredAt; it does not declare a recovered reply before one is verified.

Validation: a real CLI transport-fault probe reached executor setup after input was recorded, and correctly did not retry. An ordinary call using the original proxy then returned the exact marker in about 18.5 seconds through the production wrapper, with one observed input and no tool calls. The positive pre-init EOF reconnect path was not reproduced; its recovery effect still requires natural observation. Both verification processes kept all tools and extra credits disabled and sent no QQ message. No persistent proxy/model/account settings were changed and no regression or historical offline self-check was run.
