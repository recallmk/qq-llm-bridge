# Gemini / Antigravity QQ 桥接

链路：QQ → NapCat OneBot v11 WebSocket → Node 桥接 → Antigravity CLI。此实现和 DeepSeek 桥接是两个独立实例，不会自动共用登录或记忆。

## 配置和启动

1. 在 Windows 上安装 Node.js 24 或更新版本、QQ、NapCat 和支持 stream-json 协议的 Antigravity CLI，登录各自账号。软件及账号状态不包含在仓库中。
2. 配置 NapCat 的 OneBot v11 正向 WebSocket，例如 `127.0.0.1:3002`，并登录 QQ。不要把服务暴露到公网。
3. 将 `bridge/config.example.json` 复制为 `bridge/config.json`，填入 `expectedBotQq`、`ownerQq`、`allowUsers`，以及 `antigravity.bin` 和 `antigravity.home` 的绝对路径；如需网络代理，在 `antigravity.proxy` 填入本机代理地址。该配置和登录资料不要提交。`allowGroups: []` 在开启群聊时表示不限群，请先配置允许的群。
4. 在本目录创建 `work` 目录，按 CLI 的登录方式准备 `antigravity.home` 中的账号资料；然后运行 `node bridge/bridge.mjs`。如需 MCP 工具，需要自行配置 Antigravity 的 MCP 服务器，入口为 `bridge/mcp-antigravity.mjs`；默认工具关闭。
5. 观测台默认 `http://127.0.0.1:3103/fish`，token 保存在 `bridge/control-token.txt`，请勿分享。服务必须保持本机访问。

示例默认关闭群聊、工具、表情、空间和成长功能。Antigravity CLI 的图片输入在此实现中尚未接通；需自行提供依赖并核对登录及连接状态。仓库没有包含原机器的启动器、代理、表情资源或账号数据。
