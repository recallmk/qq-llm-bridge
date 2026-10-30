# 改这个仓库的硬约束

给要动这份代码的人（或 AI）看。**这个文件只讲「不能做什么」**，不是安装手册，也不是产品介绍——装法看 `README.md`，改了哪些东西看 `CHANGELOG.md`。

违背下面任何一条，即使测试全绿也算改坏了：这几条守的不是代码正确性，是**这个插件还叫不叫大肥鱼**。

---

## 1. 零依赖是铁律

`package.json` 里 `dependencies` / `peerDependencies` / `devDependencies` **三个必须永远是 `{}`**。

- 原因不只是「省事」：DSH 插件多挂一个包，就可能把宿主正在用的旧核心包拖进依赖树，装完重启后宿主直接崩（本机踩过，见 `README.md` 里 tool.js 那段 `unsupported JSON schema` 的记录）。
- 需要 HTTP → 用内置 `fetch`。需要签名 → 用内置 `crypto`。需要解压 → 用内置 `zlib`。需要子进程 → 用内置 `child_process`。**这些全都有，没有必须装包才能干的事。**
- 测试只用 `node:test` + `node:assert`，不引测试框架。

## 2. 不许加人格设置界面

**没有**性格滑条、好感度数字、亲密度进度条、人设输入框、情绪标签。

- 设置页只放**环境参数**：几点醒、醒几次、一天几条事件、刷不刷 B 站、每天刷几次。这些是「生长环境」，不是她本人。
- 人格只能**通过事件长出来**。任何让用户直接写「你是一个温柔的…」的入口，等于把产品变回角色扮演，直接违反本项目的立项前提。
- 判断标准很简单：如果加了之后用户能**直接指定**她是什么样的人，就是错的。

**唯一例外：导入别人养过的那一位（0.5.3）**。用户 m03170 明确要「尊重别人的想法」——对方已经在别处养出了样子，接过来是**继承一份既成事实**，不是由用户在这里凭空指定性格。这条通道的三条边界，越界就等于变回角色扮演：

1. **只写 `seed`，不写配置**。人设正文进事件流（她以后能自己 revise），不进 `config.json`；`persona` 这组键也**不进 `/config` 白名单**，外部改不了。
2. **只在还没有 `seed` 的一局生效**。有起点就 409 拒绝，让他先重置——覆盖一个正在长的她要由人手动做，不由接口做。
3. **不带成长结果**。天数固定回第 1 天，判断、疤、拒绝记录、日记一律不迁。导入的是「她本来是谁」，不是「她已经活到哪」。

## 3. 四条黑名单是代码级硬禁，不是提示词

真相在 `lib/rules.js`（四层结构）与 `lib/persona.js`（`PRESCRIPTION_BANS`、`HARD_BANS`），不在文档里。

| 条款 | 真相在哪 | 守它的测试 |
| --- | --- | --- |
| 不撒娇卖萌（写成「还不会」，不是「不许」） | `lib/rules.js` 的 `learn-affection` | `test/rules.test.mjs`（断言含「还不会」且不含「不可以」） |
| 没有好感度/亲密度数字 | `lib/rules.js` 的 `no-relational-score` | `test/rules.test.mjs`（提示词里 `cannot` 只剩这一条） |
| 不能读自己的数值与设定（能看自己说过什么） | `lib/rules.js` 的 `no-read-self`（物理层，`section: null`，**不进提示词**）；工具侧由 `lib/restrict.js` 的 `HER_TOOLS` 收窄 | `test/rules.test.mjs` + `test/restrict.test.mjs` |
| 不能调工具改自己 | `lib/rules.js` 的 `no-self-modify`（物理层，同样不进提示词）；写入侧唯一入口是 `lib/capture.js` 的 `growth_commit` | `test/rules.test.mjs` + `test/capture.test.mjs` |

两条实现原则，改代码时别破坏：

- **物理层与契约层不进提示词。** 写「你不可以读设定」等于告诉她「旁边有份设定，很关键」——那是诱因，不是防线。靠代码不给路径、不给工具来保证。
- **不要绕过 `lib/guard.js`。** 她是"根本没看见"重塑人格那句话，不是"看见了但被劝住"。任何新的输入口（新工具、新接口、新外部文本源）都必须过 `guard.js`；秘密外发（cookie / token / `sk-` / Bearer / 长 base64）在这里一律拦下。

## 4. 文案有守门词，改之前先看测试

面向用户的字符串（`lib/client.js` 里的界面文案）有三条硬规矩，全部有测试盯着：

- **不出现男字旁的「他」**，统一写「你」。`test/p5.test.mjs:187` 逐字扫。例外只有 `其他/其它` 这类词素。她自己的话、引用别人的话不受此限。
- **统一「四个阶段」与「三道瓶颈」**，**禁**「四道门 / 三道门」。`test/principle-zoom.test.mjs` 明确断言 `三道门`/`四道门` 不出现。
- **立场不是第五关。** 措辞只能是「四个阶段完成之后才会开始有立场」。图上不许再退回「底部一行小字」的表达——立场是独立区块，由 `test/principle.test.mjs`（viewBox 1160 + 含「立场清单」）与 `test/stance.test.mjs`（旧的「纵向长「立场清单」」写法必须不存在）共同守着。

改文案时**先跑这三条**再改别的，否则会来回返工。

## 5. `events.jsonl` 只能追加

`~/.dsh-fish/events.jsonl` 不能删除记录，是唯一可信源，一行一条。**任何改写/删除/重排都是篡改她的记忆。**

- 状态（`state.json`）是派生品，随时可由 `rebuild()` 重算；改它没意义，会被覆盖。
- 「让她忘」不是删行，是**降低召回**（`lib/persona.js` 的 `foldOlderBeliefs`：更早的判断折成一行「记不清原话了」，疤那类永不折叠），事件原文始终还在 `events.jsonl` 里，她也能用 `her_recall` 翻回去。
- 重置与恢复都不删数据：`reset.js` 改名前缀封存，`backup.js` 恢复前把旧档搬去 `dsh-fish-backups/pre-restore-*`。
- 新增事件类型 = 改 `lib/schema.js` 的 `EVENT_SCHEMA_VERSION` 并在 `lib/events.js` 登记；旧版本读到更新的 schema 必须**拒**（否则静默丢字段）。

## 6. 改完必须跑全套测试

```bash
node --test
```

当前基线 **647 个**：`--test-isolation=none` 下 645 过、2 条已知跨文件假红；用独立进程跑 `node --test` 应全绿。任何一条红都不许提交——包括看起来"不是我弄的"那条。

按环境挑跑法：

- **正常环境**：上面这条命令（不带参数，Node 自己递归找 `test/*.test.mjs`），约 17–18 秒。
- **别写成 `node --test "test/*.test.mjs"`**：Node 20 不展开 glob，会直接报 `Could not find '.../test/*.test.mjs'`；引号里的通配符只有 Node 22+ 认。CI 就是被这条拖红的。
- **也别写成 `node --test test/`**（目录形式）：Node 26 + Windows 下报 `MODULE_NOT_FOUND`，沙箱里还会 `spawn EPERM`。
- **沙箱 / 受限环境**：用 `node --test --test-isolation=none`，或逐文件跑。
- **`--test-isolation=none` 有跨文件假红**：ULID 与 cover 两条会因共享进程互相干扰而报错，单跑对应文件是绿的。判断是不是假红：逐文件独立进程跑一遍，全绿即假红。
- **`test/media.test.mjs` 的 `detectFfmpeg` 依赖 spawn**，在禁 spawn 的环境里会红（`spawnSync ... EPERM`）。这是环境限制，不是代码问题——但**不许**为了让它变绿而删掉那条断言。

CI 也跑同一套（`.github/workflows/test.yml`，Node 20 / 22 / 24 各跑一遍）。

## 7. QQ 桥接不内置，靠白名单放行

社区想把大肥鱼接到 QQ 上（0.6.1 起写进设置页说明）。**不要把 QQ 协议、登录、收发塞进这个插件**——已经有现成的桥（如 `Derpyu520/qq-bridge`，独立进程 + 自己按 QQ 会话建 DSH 会话），两个一起装即可。本插件只负责一件事：在 `config.tools.allow`（设置页「插件能力白名单」）里放行桥暴露的工具名。

qq-bridge 默认要放行的是：

```
qq_send_message, qq_get_unread_messages, qq_reply
```

三条约束：

- **工具名必须对得上真实 registry**。桥升级改名、用户填错，她就会答「我没法在 QQ 上说话」——这不是插件坏了，是名字没对上。
- **放行之后要念给她听**。身份文档「我手上有什么」由 `lib/persona.js` 的 `toolBrief(extra)` 生成、`lib/selfdoc.js` 把 `config.tools.allow` 作为 `extraTools` 传进去。看不见一只手，她就不会用。
- **白名单只做加法**。`config.tools.allow` 与 `HER_TOOLS` 取并集，不要用它去减工具；收窄只走 `lib/restrict.js` 那一套。

`test/beliefs.test.mjs` 有一条「白名单里额外放行的工具要念给她听」盯着这段，改之前先跑它。

**其余平台同理**：Chatbox、Monica、AstrBot 这些客户端/框架也走「社区桥 + 白名单」这条路——不要把它们的协议塞进本插件，先找能桥过去的项目，再把工具名填进 `config.tools.allow`。不知道用什么项目、工具叫什么，就让她自己去查（前提是宿主放行了她能用的搜索/阅读工具）。

---

## 提 PR / 提交前自检

- [ ] 三个依赖字段还是 `{}`
- [ ] 没有新增人格设置入口
- [ ] 新输入口都过了 `guard.js`
- [ ] `node --test` 647 全绿
- [ ] 界面文案没有「他」「四道门」「三道门」
- [ ] 改了 `EVENT_SCHEMA_VERSION` 的话，`CHANGELOG.md` 里写了迁移说明
