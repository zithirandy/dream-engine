---
description: 手动梦 —— 引擎汇总记忆线索 → 受限子代理产出合并提案 → 校验 → 确认后落盘
argument-hint: "[--yes] [--dry]"
---

执行 AutoDream **手动梦**。严格按下面四步做，**不要跳过校验**。

引擎**不含任何 LLM 客户端**：语义合并由你（宿主当前会话的模型）通过 `dream-merge` 子代理完成。
运行时 CLI 是 **`~/.claude/.dream/bin/cli.cjs`**。
> ⚠️ `dreamctl` 只是 `package.json` 里的 npm bin 名，**该目录下并没有 `dreamctl` 这个文件**；
> 必须写 `cli.cjs`，否则 `node …/dreamctl` 会因文件不存在而失败。

## 第 1 步：prepare（引擎机械汇总）

用 Bash 执行：

```bash
node ~/.claude/.dream/bin/cli.cjs prepare --mode manual
```

它会写出一份 `~/.claude/.dream/proposals/inbox-<ts>.md`，并打印汇总与线索统计。
记下输出的 inbox 路径。

> inbox 只列**线索**（词面重叠、索引超限、未索引文件、待裁决候选），不下结论。

## 第 2 步：产出提案（受限子代理）

调用 `dream-merge` 子代理，把 inbox 路径交给它：

> 读 `<inbox 路径>`，按你的 schema 规则产出提案，写到 `~/.claude/.dream/proposals/proposal-<ts>.json`。

**若 inbox 显示"无值得处理的内容"**（无线索、无超限、重复为 0），就**不要**为了产出而产出：
直接告诉用户"本次没有需要合并的东西"，然后结束。空提案只是噪声。

## 第 3 步：validate（引擎当裁判）

```bash
node ~/.claude/.dream/bin/cli.cjs validate ~/.claude/.dream/proposals/proposal-<ts>.json
```

- 通过 → 进入第 4 步；
- 失败 → 输出是结构化错误 `{path, expected, got}`。**据此修正提案文件后重跑 validate**，
  最多 3 轮。若 3 轮仍不过，停下来把错误原样报告给用户，**不要**反复猜。

## 第 4 步：apply（展示 diff → 用户确认 → 落盘）

```bash
node ~/.claude/.dream/bin/cli.cjs apply ~/.claude/.dream/proposals/proposal-<ts>.json
```

该命令**默认只展示计划与 diff，不落盘**。把预览（尤其是这些项）念给用户看：

- 新建 / 更新 / 删除 各几条；
- **是否有删除**（破坏性）；
- **是否有文件位于手写区索引**（`touchesUserFiles`）—— 若有，明确告知用户"这些索引行会变成孤儿，
  引擎不会去改你的手写区，需要你手动清理"。

然后：

- 用户明确同意 → 加 `--yes` 重跑同一条命令落盘；
- `$ARGUMENTS` 含 `--yes` → 视为已预授权，直接带 `--yes` 执行；
- `$ARGUMENTS` 含 `--dry` → 只展示，不落盘，也不要询问。

落盘后汇报：执行了几步、git 提交、提案归档路径；若有失败步骤，逐条列出。

## 严禁

- 不得绕过 `validate` 直接 `apply`；
- 不得直接编辑任何记忆文件或 `MEMORY.md`（绕开受控区块与 git 提交）；
- 不得在用户未确认时落盘（除非 `$ARGUMENTS` 里有 `--yes`）。
