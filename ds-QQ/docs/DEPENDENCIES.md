# 本机依赖

桥接主体使用 Node 内置模块，不需要安装 npm 业务依赖。请使用 Node 24 或更新版本（需要原生 WebSocket 与现代 fetch）。根目录 `package-lock.json` 只锁定项目元信息，不代表 DSH SDK 或 QQ 已安装。

DSH 的 Electron 主程序、`resources/app.asar` 与 CLI 必须来自同一安装版本。桥接扩展使用官方 `schemastery`、`dsh-sdk-protocol`、`dsh-sdk-jsonrpc-server`、`dsh-brand`，由 DSH profile 提供，不要随意更新其中一个包。

当前机器的依赖版本与文件位置记录在被 Git 忽略的 `dependencies.local.json`。完整依赖、原始包元数据与锁文件保存在 `runtime/profile`、`.dsh/profiles` 和 DSH 安装目录。QQ、NapCat、Node、DSH 二进制与登录数据已经随本机项目迁移，但不进入 GitHub。

原安装用目录联接让 `.dsh/profiles/node_modules` 指向 `runtime/profile/node_modules`。迁移时这些联接已改为新项目内目标。以后把含运行数据的整个目录移到另一个路径时，需要执行 `scripts/repair-links.ps1` 重建这些本地依赖联接；该脚本使用本机 `dependency-links.local.json`，不会写 C 盘。

第三方二进制请从官方分发渠道取得，遵守各自许可证。表情库图片的来源信息随本机 `qq-bridge/stickers` 保存，不默认公开分发。
