# DS QQ Bridge · 大肥鱼

把 QQ 的私聊和群聊接入 DeepSeek Harness。链路为 QQ → NapCat（OneBot v11 WebSocket）→ 常驻桥接 → DSH SDK → 模型。

## 已实现

- 私聊连续消息合并；群聊按内容决定是否接话、是否引用，支持安静跳过。
- 原生识图、表情库、Markdown 转纯文本、按句读分段、消息去重与限速。
- 按场景记忆、共同人格成长、日记和留下的话、后台自主唤醒、公开内容只读浏览。
- 主人私聊可使用电脑工具；群聊与其他私聊限制工具权限。
- 自主空间说说，受每日次数和冷却限制；观测台、额度和连接健康状态。
- 群聊上下文限额、会话轮换及并发控制，给私聊保留处理能力。

## 目录

```text
qq-bridge/             桥接源码、简短初始人设、配置样例、上游 dsh-fish
scripts/               项目配置、启动和状态查询
runtime/node/          本机 Node 运行时（不提交）
runtime/profile/       本机 DSH 插件依赖（不提交）
DeepSeek-Harness/      本机 DSH 安装（不提交）
napcat/shell/          本机 NapCat 安装及配置（不提交）
QQ/                   本机 QQ 程序与数据（不提交）
.dsh/                 DSH 登录、配置、会话与依赖联接（不提交）
data/                 QQ 本机用户数据（不提交）
work/ .tmp/            工作目录与临时文件（不提交）
```

`qq-bridge` 内的配置、token、聊天记录、记忆、日志、截图、表情图片和历史备份均不提交。`.gitignore` 对源码采用明确允许清单，新增源码文件时需要加入清单。

## 本机使用

Windows 上双击根目录 `start.bat`。它会更新本机路径、按需启动 NapCat，并启动带崩溃重启的桥接。已经运行时重复启动会退出。查看状态：

```powershell
.\runtime\node\node.exe scripts\status.mjs
```

观测台地址为 `http://127.0.0.1:3102/fish`，按本机配置启用。不要把控制端口暴露到公网；本机 token 保存在 `qq-bridge/control-token.txt`。

## 在另一台电脑部署

1. 克隆仓库到 C 盘以外的位置，安装 Node.js 24 或更新版本。需要双击启动时，把 Node Windows 发行包放到 `runtime/node`（包含 `node.exe`）。
2. 从官方来源安装 QQ、NapCat、DeepSeek Harness，分别放入上面列出的本机目录；不要把这些程序上传到本仓库。具体版本见 `dependencies.local.json`（本机清单，不提交）及 `docs/DEPENDENCIES.md`。
3. 用 DSH 完成自己的模型账号登录，设置 `DSH_HOME` 为项目下 `.dsh`，准备官方 `sdk` profile。需要能运行 `DeepSeek-Harness/resources/runtime/cli/bin/dsh.cmd --profile sdk`，并在 `.dsh/profiles/node_modules` 中提供 SDK 插件。桥接没有 npm 业务依赖，`npm install` 不会替代 DSH 的安装与登录。
4. 配置 NapCat 的 OneBot v11 正向 WebSocket，默认 `127.0.0.1:3001`。创建 `napcat/shell/launcher-user.bat`，可参考 `scripts/launcher-user.example.bat`。登录自己的 QQ。
5. 运行 `node scripts/configure.mjs` 生成 `qq-bridge/config.json`，填写 `botQq`、`ownerQq`、`allowUsers`，并检查模型、端口与预算。样例默认关闭群聊、工具、空间和后台成长；请按需要启用。`allowGroups: []` 在开启群聊后表示不限群，请慎重设置。
6. 运行 `start.bat`，查看 `qq-bridge/bridge.log`，确认 DSH ready 和 OneBot 心跳正常。迁移或维护时不自动发送测试消息。

项目源码按当前位置计算路径，配置脚本只更新本机路径并保留已有账号与记忆设置。移动整个项目后重新启动即可更新配置；若携带 `.dsh` 的目录联接，需要按新位置重建联接，见依赖文档。

## GitHub 上传

在项目根目录执行 `git status --short` 查看将提交的文件，使用 Git 提交及推送。不要上传整个目录的 ZIP，也不要强制添加被忽略的本机文件。仓库不包含现有 QQ 登录、模型账号、聊天记录和第三方二进制程序；克隆后需自行安装依赖并登录。

第三方代码与分发范围见 `THIRD_PARTY_NOTICES.md`。未替原桥接作者指定新的开源许可证；公开发布前请确认原仓库许可证及你的修改的许可方式。
