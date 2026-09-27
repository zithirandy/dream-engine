# dsh-dream-plugin —— AutoDream 的 DSH 宿主适配（P4）

> **状态：四项前置接口已核实；适配层已实现并离线验证（32/32）；未装入 DSH。**
> 本目录**不是**引擎的第二份副本 —— 引擎只有一份（`dream-plugin/`），两个宿主各挂一层薄适配。
> 装入 DSH 需要改 profile 配置，**按用户要求暂不接线**。

---

## 1. V2 §7.3 四项前置接口 —— 实测结论

| # | 接口 | 结论 | 依据 |
|---|---|---|---|
| 1 | Schedule 任务注册 API | ✅ **已确认** | `@deepseek-ai/dsh-schedule` 是 Cordis 函数插件（`name`/`inject`/`apply(ctx)`）。但它是 **agent 作用域的会话内提醒**（durable reminders *over the session event log*），**不是系统级 cron** ⇒ 见 §4 |
| 2 | **DSH 是否落盘转录？路径与格式？** | ✅ **完全摸清** | 见 §2 |
| 3 | memory MCP overlay 的记忆目录约定 | ✅ **已查清 —— 前提不成立** | DSH **没有**记忆系统。`dsh-mcp-client` 是通用 MCP 桥（"bridges tools only"、"no server is enabled by default"），所谓 memory overlay 指自配第三方记忆 MCP 服务器。⇒ 不存在需要遵守的"DSH 记忆目录约定"；AutoDream 写引擎自己的存储（`.dream/global/` + `~/.claude/projects/<slug>/memory/`），与 DSH 无关 |
| 4 | Cordis 能否收到 stop 阶段事件 | ✅ **可以（走桥）** | `@deepseek-ai/dsh-hooks-claude-code` 桥支持 `Stop`；见 §3 |

---

## 2. ★ DSH 会话存储（实测）

### 2.1 路径与形态

```
~/.dsh/sessions/<slug>/<sessionId>/session.v3.jsonl.zstd
```

- 本机实测：**114 个 `.zstd` 文件 / 约 55 MB**
- 内容是 **JSONL**，但被 zstd 压缩；项目 slug 与 Claude Code **规则不同**
  （DSH `--F-DemoApi--` ↔ CC `F--DemoApi`；非 ASCII 用 `~HEX~`：`F:\Demo` → `--F-~539FE~76D8--`）

### 2.2 🔴 必须逐帧解压

zstd 文件是**多帧拼接**（每次 flush 追加一帧）。实测某 5.9 MB 会话：

| 读法 | 结果 |
|---|---|
| `zlib.zstdDecompressSync(buf)` 一次调用 | **191 B —— 只有会话头** |
| **逐帧解压** | **19.2 MB / 4529 条记录 / 2490 个事件** |

流式 API（`createZstdDecompress`）**同样只解第一帧**（已实测）。这是最坏的一类缺陷：
不报错、不崩溃，只是**安静地只拿到会话头**。`src/dsh-session.cjs` 的 `decompressFrames()` 即为此。

**增量天然可行**：帧数就是偏移量（与 CC 侧字节偏移同构）。`readSession(file, {fromFrame})`
只解新帧，`nextFrame` 持久化到 `raw/dsh-offsets.json`。

### 2.3 记录类型

| 记录 | 引擎处理 |
|---|---|
| `user/message` | → `{role:'user', kind:'text'}` |
| `assistant/message` | → `{role:'assistant', kind:'text'}`（**只取 `text`，跳过 `reasoning`**） |
| `tool/call` | → `{role:'assistant', kind:'tool_use', toolName}`（⚠️ `arguments` 是**字符串化 JSON**） |
| `tool/result` | → `{role:'user', kind:'tool_result'}` |
| `turn/*` `step/*` `goal/change` `todo/write` `approval/*` `compaction/*` … | **忽略**（流程元数据，不是"值得记住的判断"） |

会话头带 **`cwd` 真实路径** —— 比 slug 字面匹配可靠。
`compaction/prune` 的 `shadowedSeqs` 会被收集（供调用方决定是否跳过已被压缩掉的内容）。

### 2.4 slug 推导**已知不可靠**，故**不猜**

```
F:\DemoApi          → F--DemoApi          ✅ 与 CC 一致
F:\Demo                → F--Demo                ❌ CC 实际用 F--Demo（Demo 被压掉）
```

⇒ `resolveProject()` 的规则：**先推导、再核对 `~/.claude/projects/<slug>/memory` 是否存在**；
对不上就**判未映射并跳过**（带明确理由），或用**显式 `projectMap`** 救回。**绝不猜** ——
猜错就是往别人的记忆目录里写东西。

### 2.5 零依赖

Node 24 自带 `zlib.zstdDecompressSync`，适配器**不需要任何 npm 依赖**。

---

## 3. Hooks：复用 Claude Code 那一套

DSH 自带 `@deepseek-ai/dsh-hooks-claude-code` —— 一个**"原样运行 Claude Code 命令式 hooks"的桥**。
其支持集（README 明确列出）：`SessionStart` / `UserPromptSubmit` / `PreToolUse` /
`PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop`。

⇒ **CC 侧的 `hooks/hook.cjs` 逻辑在 DSH 上原样可用**，只需把桥的 `configPath` 指向本目录的
`hooks/hooks.json`（`${CLAUDE_PLUGIN_ROOT}` 会被桥替换）。

**刻意不含 `SessionEnd`**：桥不支持它，而 DSH 侧本就不需要 —— CC 侧的 `SessionEnd` 用于
"转录尾巴封口"（会话文件可能没有结尾换行）；DSH 是**每帧独立压缩追加写**，
不完整的尾帧自然解不出来并被跳过，不需要封口这一步。

---

## 4. "每日自动梦"在 DSH 侧的两条路

因为 DSH 的 Schedule 是**会话内提醒**而非系统 cron，它**不能自己跑一个后台提炼进程**：

- **(a) 会话内**：用 Schedule 提醒 → 由会话里的 agent 调 `dream_run`。缺点是依赖会话活着。
- **(b) 系统级**：用 Windows 计划任务（`schtasks`）直接跑引擎 CLI，不依赖任何会话。**更可靠。**

本插件**不擅自注册 Schedule 任务** —— 那会改变用户的会话行为，需显式同意。

---

## 5. 目录内容

```
dsh-dream-plugin/
├── README.md
├── package.json              ESM 包；入口 src/index.mjs；零运行时依赖
├── src/
│   ├── dsh-session.cjs       ★ 会话适配器：逐帧 zstd + 记录归一化 + 增量 + slug 推导
│   ├── ingest.cjs            ★ 采集：选会话 / 增量 / 项目归属（不猜）/ 交给引擎
│   ├── index.mjs             ★ Cordis 插件：注册 dream_status / dream_run
│   └── index.cjs             早期 CJS 脚手架（保留作对照，以 index.mjs 为准）
├── hooks/
│   ├── hook.cjs              转发给已安装运行时的 nudge.cjs（与 CC 侧同构）
│   └── hooks.json            只注册 SessionStart / Stop（桥共支持 7 种事件）
    ├── session.cjs           会话适配器验证（11 项，真实会话，只读）
    ├── ingest.cjs            DSH→引擎采集验证（10 项，隔离）+ `--real` 真实 dry run
    └── plugin.cjs            插件入口离线验证（11 项，stub 掉 dsh-tools，不装入 DSH）
```

## 6. 运行验证

```powershell
node test\session.cjs          # 11/11  会话适配器（真实会话）
node test\ingest.cjs           # 10/10  DSH→引擎（隔离）
node test\ingest.cjs --real    # 真实会话 dry run（只统计，不落候选）
node test\plugin.cjs           # 11/11  插件入口（不装入 DSH）
```

**真实 dry run 实测**（本机，`--real`）：

```
DSH 会话      114 个
本次采集      28 个会话 · 2105 事件 · 消费 16539 帧（失败 0）
归属项目      {"F--DemoApi":2105}
跳过          86 个 —— 理由均为「推导出的 slug 无对应记忆目录：F--Demo」
```

> 那 86 个会话（含本会话）的 `cwd` 是 `F:\Demo`，该 workspace **没有 Claude Code 记忆目录**，
> 故无处安放候选。适配器**正确拒绝猜测**；若要纳入，需显式 `projectMap`。

## 7. 设计约束（继承自 V2，不得违反）

- **引擎只有一份**：本适配器通过 `pipeline.run({ events })` 把事件交给引擎，**不复制引擎**；
- **模型可见面很小**：只暴露 `dream_status` / `dream_run`，**不暴露 Jev**；
- **引擎不含 LLM 客户端**；
- **零依赖**。

## 8. 仍未完成

| # | 项 | 说明 |
|---|---|---|
| 1 | **装入 DSH 后未重启** | 已装入 web profile（见 §9），**生效需重启 DSH**；工具在真实会话中出现未验证 |
| 2 | ~~memory overlay 目录约定~~ | ✅ 已查清（§1 第 3 项）：DSH 无记忆系统，前提不成立 |
| 3 | Schedule 注册 | 需用户显式同意（会改变会话行为）；且见 §4 的语义限制 |
| 4 | 事件层未接线 | 引擎 `/event` 是 P0 桩、无消费者 ⇒ 接桥只会产生死事件 |
| 5 | pnpm 拷贝而非链接 | `web/node_modules/dsh-dream-plugin` 是**实体拷贝** ⇒ 改源目录后需重跑 `dsh plugin --profile web install` |

## 9. 装入 DSH

```powershell
# 源路径含 &（如 `A&B`），命令行会截断 ⇒ 先建无 & 的目录联接
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\dsh-dream-plugin" -Target "F:\Demo\dream-src\dsh-dream-plugin"
dsh plugin --profile web add "file:$env:USERPROFILE\.dsh\dsh-dream-plugin"
```

结果：`dependencies` 与 `dsh.profile.bundles` **各 +1 项**；`cordis.patch.yml` **未被改动**；
组合树含 `- id: autodream-dsh / name: dsh-dream-plugin`（第 175/175 条）；
从装载位置真实 `import()` 成功（`name=autodream-dsh` / `inject=["tools"]`）。

### ⚠️ 更新插件必须 `remove` + `add` —— **`install` 是 no-op**

`web/node_modules/dsh-dream-plugin` 是**实体拷贝**（非符号链接）。实测：

| 命令 | 结果 |
|---|---|
| `dsh plugin --profile web install` | ❌ **不同步**（spec 未变 ⇒ `added 0`，旧内容原样保留） |
| `dsh plugin --profile web remove dsh-dream-plugin` 然后 `add` | ✅ **强制重拷**（实测一致 8 / 不一致 0） |

```powershell
dsh plugin --profile web remove dsh-dream-plugin
dsh plugin --profile web add "file:$env:USERPROFILE\.dsh\dsh-dream-plugin"
```

> `remove`+`add` 不会丢 `dsh.profile.bundles` 里的条目（实测仍在）。
> 判据：比对源 `src/` 与装载副本 `src/` 的文件哈希。

配置备份：`~/.dsh/profiles/web/_backup-*/`。回滚见 P4 实施报告 §9.6。

## 10. 项目归属：自动 slug 索引（采集率 24% → 100%）

**问题**：DSH 采集要求会话**归到一个项目**。归属靠 `cwd` → CC slug → 核对 `memory` 目录存在。
`F:\Demo` 的真实 CC slug 是 **`F--Demo`**（非 ASCII 被压缩），字符串推导只能得到 `F--Demo`
—— 对不上，于是 86/114 会话被跳过（采集率 24%）。

**解法**：CC 转录**每条记录都带 `cwd` 真实路径** —— 那是权威依据。
`buildSlugIndex()` 扫描 `~/.claude/projects/*/`，每个项目只读一条转录的**首 64 KB**，
建立 `真实路径 → slug` 映射。`resolveProject()` 三层降级、**任何一层都不猜**：

| 层 | 依据 | via |
|---|---|---|
| 1 | 显式 `projectMap`（人工可覆盖） | `explicit-map` |
| 2 | **自动索引**（转录 `cwd` 字段） | `cwd-index` |
| 3 | 字符串推导（**仅 ASCII 可靠**） | `derived` |

**实测**：索引 14 条；真实 dry run **114/114 会话、0 跳过、12501 事件**。
索引还顺带修好了一批推导会算错的中文路径工作区（`F:\DemoTools\…`、`F:\DemoSite`、`F:\DemoCZY\定时程序` …）
—— 解决的是**整类问题**。

> ⚠️ **设计教训（已修）**：早期实现跳过时会**推进** `nextFrame` 到末尾，
> 导致"以后修好映射也读不出内容了"（`fromFrame` 已在末尾 ⇒ 0 新帧）——
> 一种**静默不可恢复**缺陷。现改为跳过时写 `nextFrame: 0`（未消费），

