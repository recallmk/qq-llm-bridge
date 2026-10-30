# QQ LLM Bridge

两个独立 QQ 桥接实例：

- [DeepSeek Harness 桥接](ds-QQ/README.md)
- [Gemini / Antigravity 桥接](docs/gemini.md)

仓库不包含 QQ 登录资料、密钥、聊天记录或本机依赖。两个实例使用独立的配置和数据；运行前请分别安装依赖并配置账号。

Gemini 的 `bridge/vendor/dsh-fish` 是本机联接，指向 `qq-src/vendor/dsh-fish`。克隆后请自行建立该目录联接或复制依赖到对应位置。第三方来源见 [THIRD_PARTY_NOTICES.md](ds-QQ/THIRD_PARTY_NOTICES.md)。
