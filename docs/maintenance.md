# 项目维护与本机数据

在仓库根目录维护 `ds-QQ` 和 `gemini-QQ`，运行配置按各自文档设置。`qq-src/vendor/dsh-fish` 保存 Gemini 使用的共享源码；`gemini-QQ/bridge/vendor/dsh-fish` 是本机联接，部署时需按 Gemini 文档建立。

运行配置、API 密钥、QQ 登录资料、会话与聊天记录、运行日志、缓存、二进制依赖和迁移保留数据均不提交到 Git。迁移保留目录只用于本机核对和恢复；不能用它覆盖正在运行的账号数据。提交前用 `git status` 检查变更，确保不包含私有数据。
