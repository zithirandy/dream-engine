# AutoDream 引擎（`dream-plugin`）

这是**引擎本体**：一个常驻 Node 进程 + 薄 hook，对宿主（Claude Code / DSH）的会话转录做
「采集 → 提炼候选 → 打分 → 决策 → 写入记忆」，并把每一步留成可审计的账本。

> **用法、安装、配置、卸载请看仓库根目录的 [`README.md`](../README.md)。**
> 本文件只面向**读代码的人**：它说明每个模块负责什么。

---

## 目录（`src/`，共 39 个模块 / 10242 行）

| 模块 | 职责 |
|---|---|
| `apply.cjs` | 手动梦提案的**计划与执行**（V2 §5.2 ④）。 |
| `auto.cjs` | ★ P5：`POST /event` 的**真实消费端**（自动梦调度器）。 |
| `cli.cjs` | dreamctl：全部运维与诊断命令的唯一入口。 |
| `config.cjs` | 配置加载与默认值合并。 |
| `daemon.cjs` | 常驻引擎入口（对应 V2 §1.1「引擎层」）。 |
| `decide.cjs` | 双层阈值的晋升决策（V2 §4.4 / §4.5）。 |
| `extract.cjs` | 候选经验提炼（V2 §4.2）。**纯代码，零 LLM。** |
| `fanout.cjs` | G2 全局分发（V2 §3.2.2 / §3.2.3）。 |
| `github-api.cjs` | GitHub REST 传输层（只做「取 JSON」，不含任何业务语义）。 |
| `github-collect.cjs` | 采集并**归一化** GitHub 条目（不含渲染、不含状态）。 |
| `github-report.cjs` | 状态比对（delta）与 Markdown 报告渲染。 |
| `github.cjs` | GitHub 采集的编排层：日闸门 → 采集 → delta → 渲染 → 落盘。 |
| `gitops.cjs` | 内容目录 git 化（对应 V2 §8.4 与 P0 "memory/ 与 .dream/global/ git 化"）。 |
| `guard.cjs` | 官方 AutoDream 冲突隔离（V2 风险 8 的处置层）。 |
| `hook.cjs` | 宿主 hooks.json 的直接入口（对应 V2 §7.2 M4 修正）。 |
| `hygiene.cjs` | 候选文本的**上游污染**检测与规范化。 |
| `inbox.cjs` | 手动梦的 `prepare`：把"需要模型做语义判断的东西"汇总成一份可读的 inbox |
| `jev.cjs` | Jev（TypeSafe System One）客户端。 |
| `labeling.cjs` | 精度标注与计算（P1 精度处置的前置基础设施）。 |
| `lock.cjs` | 单实例 PID 锁（对应 V2 §6.4 第 5 道门控）。 |
| `log.cjs` | 日志：运行日志（按日 JSONL）+ 引擎自身 daemon.log（按大小滚动）。 |
| `memory.cjs` | 受控区块写入器（V2 §3.3 / §4.5）。 |
| `nudge.cjs` | 宿主 hook 的薄转发器（对应 V2 §7.2 与 M4 修正）。 |
| `p2.cjs` | 自动梦闭环编排（V2 line 740「P2 打分」）。 |
| `paths.cjs` | 解析 DREAM_HOME 与全部子路径。 |
| `pipeline.cjs` | P1 管线：门控 → 采集 → 提炼 → 落盘。 |
| `projects.cjs` | 扫描宿主记忆目录，为 state.projects 生成初始条目。 |
| `promote.cjs` | 把决策为 promote 的候选**落成记忆**（V2 §4.5）。 |
| `proposal.cjs` | 手动梦提案的 schema 与校验器（V2 §5.2 ③）。 |
| `redact.cjs` | 脱敏流水线（V2 §8.2，🟢5：覆盖所有进入 state 的文本）。 |
| `risk8.cjs` | V2 风险 8：检测**官方 AutoDream** 是否已启用。 |
| `server.cjs` | 本地 HTTP 服务（对应 V2 §6.2 / §7.1 的 P0 子集）。 |
| `spawn.cjs` | 探活 + 拉起常驻引擎（对应 V2 §6.2）。 |
| `state.cjs` | state.json 的原子读写。 |
| `stats.cjs` | 报告数字的唯一产出点（F4 流程根治）。 |
| `store.cjs` | 候选/被拒/账本的持久化（V2 §3 / §4.5）。 |
| `support.cjs` | 候选的「跨会话复现度」聚合（convention 精度处置的核心机制）。 |
| `token.cjs` | 本地服务鉴权 token（对应 V2 §6.2 本地服务安全）。 |
| `transcripts.cjs` | 转录增量解析（V2 §4.1，含 M1 全部修正）。 |

---

## 不变量（改代码前请先读）

1. **引擎不含任何 LLM 客户端**（设计决策 6）。唯一出网点是评分服务的那个 `fetch`；
   「手动梦」的合并提案由**宿主模型**产出，引擎只当裁判与执行者。
2. **Jev 只从程序代码里调用，永不暴露给模型**（决策 1）。模型可见面只有
   `/dream`、`/dream-status` 这类命令。
3. **记忆只存指针，不存副本**（决策 5）—— 单一事实源，避免两处内容漂移。
4. **凭据只从宿主 `settings.json` 的 `env` 读**，绝不硬编码、绝不落进本插件的任何文件。
5. **失败向保守方向**：未知配置值按最保守解释；采集失败宁可"不跑"也不写半份数据。

## 运行态落在哪

| 路径 | 内容 |
|---|---|
| `~/.claude/.dream/` | 引擎运行态：`config.json` / `state.json` / `token` / `logs/` / `candidates/` / `global/` |
| `~/.claude/projects/<slug>/memory/` | **项目级记忆**（独立目录、独立 git 仓库，**不在** `.dream` 下） |

> ⚠️ 项目级记忆目录是**宿主与本插件共用**的。判断一个 `.md` 是不是本插件写的：
> 本插件的晋升文件带完整 `dream:` frontmatter 块（`score`/`jevModel`/`durability`/`promotedAt`…），
> 宿主原生记忆只有 `node_type`/`type`/`originSessionId`/`modified`。

