---
description: AutoDream 状态 —— 引擎健康、写入策略、候选与提案概览
---

汇报 AutoDream 状态。**只读，不要修改任何东西。**

用 Bash 执行以下命令，然后把结果整理成简洁的汇报（不要原样倾倒原始输出）：

```bash
node ~/.claude/.dream/bin/cli.cjs status
node ~/.claude/.dream/bin/cli.cjs guard
node ~/.claude/.dream/bin/cli.cjs proposals
node ~/.claude/.dream/bin/cli.cjs auto
```

> ⚠️ 必须是 `cli.cjs`。`dreamctl` 只是 npm bin 名，`~/.claude/.dream/bin/` 下**没有**这个文件。

另外读一次 `~/.claude/.dream/state.json`，汇报其中的 `counters` 与时间戳。

汇报时请覆盖这几件事：

1. **引擎**：在线/离线、PID、运行时长；
2. **写入策略**：`guard` 的有效模式（`audit` = 只打分不写记忆；`active` = 允许写）；
   若 `guard` 报官方 AutoDream 状态不是"未运行"，**明确提示可能存在冲突**；
3. **累计**：`counters.promoted / globalPromoted / dreamRuns / dreamHeld / dreamRejected`；
   注意 `lastDreamAt`（最近一次梦）与 `lastRunAt`（最近一次采集）是**两个不同的时间戳**，
   不要混为一谈；
4. **待决**：`proposals` 里未处理的 inbox 与提案数量；
5. **自动梦**（`auto` 的输出）：**开关是否打开**（默认关）、**现在会不会跑**、不会的话**卡在哪一条**
   （未静默 / 未到间隔 / 无触发事件 / 锁被占用）。这是自动梦唯一能回答"为什么没做梦"的地方；
   同时报 `lastAutoDreamAt`、`autoRuns` / `autoFailures`，以及最近一次失败的错误。
6. **异常**：若 `status` 里锁的 PID 已死或 state 有 `error` 字段，直接点出来。

保持简短。没有异常就不要展开细节。
