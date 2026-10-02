# dream-engine

> 一个**自托管**的编码智能体记忆整合引擎 —— 会话转录 → 候选提炼 → 外部打分 → 阈值决策 → 写入受控记忆库。
> 灵感来自 Claude Code 的 AutoDream 行为，**独立实现**，不含也不依赖其源码。

**零运行时依赖**（引擎 Node ≥ 18；DSH 会话读取需 Node ≥ 24）。两个宿主适配层共用**同一份引擎**。

[English](README.en.md) | 中文

---

## 它解决什么问题

编码智能体会在会话里产出大量"值得记住的判断"——某个坑的根因、某条约定、某个环境事实。
但这些都随会话散落。本引擎把它们**机械地**提炼、打分、按阈值沉淀进记忆库，
使下一次会话能读到上一次的结论。

关键取舍：**引擎里没有任何 LLM 客户端**。
语义判断交给一个可替换的**外部打分服务**，引擎只负责"哪些该被记住、够不够格、怎么写进去"。

---

## 架构

```
宿主会话
  │
  ├─ 事件层（宿主自动）  SessionStart / Stop / SessionEnd
  │     → 极薄转发 → POST /event（只落盘 + 廉价判定，毫秒级返回，绝不阻塞会话）
  │
  └─ 命令层（模型可见）  /dream  /dream-status
        → 引擎机械汇总线索 → 受限子代理产提案 → 引擎校验 → 用户确认 → 落盘
  │
  ▼
常驻守护进程（127.0.0.1，三件套安全：只绑回环 / Host 白名单 / 令牌）
  ├─ 采集提炼    读宿主转录 → 候选（不出网）
  ├─ 外部打分    唯一出网点，强制脱敏
  ├─ 决策        双层阈值 + 多重闸门（已知 / 片段 / 死区 / 置信度 …）
  ├─ 落盘        受控区块写入 + 每次变更 git 提交
  └─ 自动梦调度  事件 → 去抖 → 门控 → 异步跑一轮（单飞、限流、可完全关闭）
```

| 路径 | 说明 |
|---|---|
| `dream-plugin/` | **引擎**（仓库主体）。零依赖 CJS：CLI、守护进程、采集/打分/决策/落盘全套 |
| `dream-plugin/hooks/`、`commands/`、`agents/` | **Claude Code 宿主适配**（hook 声明、斜杠命令、受限子代理） |
| `dsh-dream-plugin/` | **DeepSeek Harness（Cordis）宿主适配**。逐帧 zstd 会话读取、自动 slug 索引 |

引擎只有一份，两个宿主各挂一层薄适配 —— 适配层负责"宿主的会话怎么读、事件怎么来、项目怎么归属"，
**引擎不知道宿主的存在**。

---

# 在 Claude Code 上安装

## 前置要求

- **Node.js ≥ 18**（`node --version` 确认；DSH 适配层另需 ≥ 24）
- Claude Code 已安装（`claude --version` 可用）
- 可选：一个兼容的打分服务端点与凭据。**没有凭据也能装**——采集与提炼可用，只有打分环节会失败

## 方式 A：作为插件安装（推荐）

仓库根已带 `.claude-plugin/marketplace.json`，所以**一个本地目录就是一个 marketplace**。

```bash
# 1) 取仓库（放在哪里都行）
git clone <this-repo> dream-engine

# 2) 把仓库根注册为 marketplace（source 支持 URL / 路径 / GitHub 仓库）
claude plugin marketplace add /path/to/dream-engine

# 3) 安装插件（插件名是 autodream）
claude plugin install autodream@dream-engine
```

装完 `dream-plugin/hooks/hooks.json` 里声明的三个事件（`SessionStart` / `Stop` / `SessionEnd`）
会自动接线，`commands/` 与 `agents/` 也会被自动发现 —— **不需要手动改 `settings.json`**。

> **本方式的实测结论**（作者在 Windows + Claude Code 上验证过）：
> - `marketplace add` 接受**本地目录路径**，登记为 `source: {"source":"directory","path":"…"}`
> - 不安装也能确认插件被正确发现：
>   ```bash
>   claude plugin list --available --json    # 应能看到 autodream@dream-engine
>   ```
>
> ⚠️ **如果你之前已用"方式 B"手工装过**：切到插件方式前，**必须先删掉 `settings.json` 里那三条手工 hook**，
> 否则同一个事件会触发两次（两条路径都在跑）。

```bash
# 4) ★ 安装引擎运行时（插件只负责接线，引擎要单独落地）
cd /path/to/dream-engine/dream-plugin
node src/cli.cjs install    # 复制模块到 ~/.claude/.dream/bin/
node src/cli.cjs init       # 建目录 / token / state / config + 扫描项目 + git 化内容目录
```

> **为什么还要第 4 步？** 插件里的 hook 只是一层**薄转发**（几毫秒返回、绝不阻塞会话），
> 真正的引擎是常驻进程 + 令牌 + 状态文件，必须落在 `~/.claude/.dream/`。
> 这一步是幂等的，升级引擎后重跑一次即可。

```bash
# 5) 验证
claude            # 开一个新会话
/dream-status     # 应看到引擎在线、写入策略、累计计数、自动梦开关
```

## 方式 B：手工安装（不通过 marketplace）

适合想完全掌控落点、或不想注册 marketplace 的情况。

```bash
cd /path/to/dream-engine/dream-plugin

# 1) 引擎运行时
node src/cli.cjs install
node src/cli.cjs init

# 2) 命令与子代理：放进宿主的自动发现路径
#    （macOS / Linux）
cp commands/dream.md ~/.claude/commands/
cp commands/dream-status.md ~/.claude/commands/
mkdir -p ~/.claude/agents && cp agents/dream-merge.md ~/.claude/agents/
#    Windows PowerShell：把上面的 ~/.claude 换成 $env:USERPROFILE\.claude
```

然后在 `~/.claude/settings.json` 的 `hooks` 里加三条（**合并进已有 `hooks`，别覆盖**）：

```jsonc
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [
      { "type": "command",
        "command": "node \"<HOME>/.claude/.dream/bin/hook.cjs\" SessionStart",
        "timeout": 10 }
    ]}],
    "Stop": [{ "matcher": "", "hooks": [
      { "type": "command",
        "command": "node \"<HOME>/.claude/.dream/bin/hook.cjs\" Stop",
        "timeout": 3 }
    ]}],
    "SessionEnd": [{ "matcher": "", "hooks": [
      { "type": "command",
        "command": "node \"<HOME>/.claude/.dream/bin/hook.cjs\" SessionEnd",
        "timeout": 3 }
    ]}]
  }
}
```

> `<HOME>` 在 Windows 上形如 `C:/Users/你`。**用正斜杠或双反斜杠**，并在 JSON 里把路径用 `\"` 引起来。
> 手工方式**必须**写绝对路径 —— `${CLAUDE_PLUGIN_ROOT}` 只在"作为插件安装"时才被替换。

## 接上打分服务（可选，但自动梦需要）

```bash
node src/cli.cjs config set jev.endpoint=https://your-scorer.example/api
node src/cli.cjs config set jev.keySource=settings:YOUR_API_KEY
```

### 🔑 凭据来源规则（**任何 key / token 一律从宿主 `settings.json` 读**）

**这是硬规则，不是建议：**

| 项 | 规则 |
|---|---|
| **唯一来源** | 宿主的 `settings.json` → `env.<NAME>` 段。宿主主目录由 `DREAM_CLAUDE_HOME` 决定，默认 `~/.claude` |
| **声明方式** | `jev.keySource = "settings:<环境变量名>"`。默认值就是 `settings:TYPESAFE_API_KEY` |
| **绝不落盘** | 引擎**不会**把凭据写进 `config.json`、`state.json`、日志、审计文件或轮次记录 |
| **绝不入网** | 出网有且只有一个 `fetch` 调用点；发送前强制脱敏（`egress: "redacted"`，默认开），凭据形态会被擦成 `[REDACTED:…]` |
| **绝不进日志** | 日志与错误信息里同一套脱敏规则生效，失败时的报错也不会带出凭据 |

```jsonc
// ~/.claude/settings.json —— 凭据写在这里，别写在别处
{
  "env": {
    "TYPESAFE_API_KEY": "<your-key>"
  }
}
```

> **本仓库自己的代码也遵守这条规则**：仓库里的运维/排查脚本如果需要那把凭据，
> 都是**运行时读 `settings.json`**，而不是硬编码、也不是读环境变量
> —— 避免出现"防泄漏的工具自己带着密钥"。

**唯一的显式例外**：`jev.keySource = "env:<NAME>"` 会改从**进程环境变量**读。
它**不是默认**，仅供"没有 `settings.json` 的场景"（如 CI）显式选用。
**除非你有明确理由，否则不要用它** —— 环境变量更容易被进程列表、日志采集或子进程继承泄露。

## 装完的默认状态

| 项 | 默认 | 含义 |
|---|---|---|
| 引擎 | 运行 | hook 会冷启动守护进程 |
| **自动梦** | **关闭** | 不会自己外呼、不会自己写记忆 |
| **写入策略** | `audit` | 只打分与产候选，**不写任何记忆** |
| 手动梦 | 可用 | `/dream` 一直可用，落盘前会给你看 diff 并要求确认 |

```bash
# 只观察（推荐先跑一段时间）
node src/cli.cjs config set mode=audit
# 允许写记忆
node src/cli.cjs config set mode=active
# 打开自动梦（会自己外呼打分服务并写记忆 —— 确认后再开）
node src/cli.cjs config set autoDream.enabled=true
# 一键全停
node src/cli.cjs config set autoDream.enabled=false
node src/cli.cjs stop
```

## 日常使用

```bash
# 会话里
/dream            # 手动梦：汇总线索 → 提案 → 校验 → 展示 diff → 你确认 → 落盘
/dream --dry      # 只展示，不落盘
/dream-status     # 引擎 / 写入策略 / 累计 / 自动梦开关与"现在会不会跑"

# 命令行
node src/cli.cjs status              # 门控 / 锁 / 引擎
node src/cli.cjs auto                # 自动梦：开关、未消费事件、上次结果、**现在会不会跑及理由**
node src/cli.cjs guard               # 写入策略 + 与官方 AutoDream 的冲突检查
node src/cli.cjs config diff         # 配置体检（差异 + 孤儿键）
```

## GitHub 动态采集（可选，默认**关闭**）

除了整合会话记忆，引擎还能按需采集仓库动态：issue、issue 评论、PR、PR review、
review 评论，与本地上轮快照比对出**增量**，渲染成中文 Markdown 日报。

```bash
node src/cli.cjs github doctor       # 体检：gh / 凭据 / API 连通 / 仓库可达 / 报告目录可写
node src/cli.cjs github now          # 立刻采一轮（忽略内置日闸门）
node src/cli.cjs github now --dry    # 干跑预览：不落文件、不推进游标
node src/cli.cjs github run          # 按内置日闸门跑（供系统级调度器调用）
node src/cli.cjs github status       # 配置 + 闸门判定 + 最近几轮
node src/cli.cjs github log          # 每轮一行 JSON 的结构化日志
```

**调度不在引擎里。** 引擎不做系统级定时；请用你宿主的定时机制（Windows 计划任务 /
cron / DSH 任务看板等）调用 `github run` 或 `github now`，建议每早 8 点。

主要配置（`~/.claude/.dream/config.json` 的 `github` 段）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。装载插件不等于同意它每天出网，故默认关 |
| `repos` | `[]` | 要采集的仓库，`["owner/name", ...]` |
| `transport` | `"gh"` | `gh` 或 `rest`（见下） |
| `tokenSource` | `"gh"` | `gh` / `settings:NAME` / `env:NAME` |
| `report.dir` | `null` | 报告输出目录；`null` → `<DREAM_HOME>/github-reports` |
| `report.writeUnchanged` | `true` | 零变化日是否也落一份报告 |
| `report.includeBodyChars` | `3000` | 每条正文渲染上限 |
| `report.redactCredentials` | `true` | 报告正文过脱敏（防止别人在 issue 里贴的 token 被本地留存） |
| `collection.schedule` | `"08:00"` | 内置日闸门的应跑时刻（仅 `github run` 生效） |
| `collection.maxPages` | `5` | **硬性页上限**（见下） |

**关于传输层**：默认走 `gh`（GitHub CLI），要求 `gh auth login` 过。
这样凭据留在系统凭据管理器里，**从不落进本插件的任何文件**。

> ⚠️ **为什么默认不是 `fetch`**：若本机用 hosts 把 `api.github.com` 指向本地代理
> （常见的"GitHub 加速"方案），Node 的 `fetch` 会因证书链不受信而失败
> （`UNABLE_TO_VERIFY_LEAF_SIGNATURE`），而 `gh` 读系统证书库故正常。
> 这类环境请保持 `transport: "gh"`；标准环境可切 `rest` 并配 `settings:GITHUB_TOKEN`。

> ⚠️ **为什么有 `maxPages` 硬上限**：`gh api --paginate` **没有页数上限**，
> 对 issue 极多的仓库会长时间不返回。采集器因此自己逐页翻页并受此值约束，
> 触顶会在报告里显式告警，而不是静默给半份数据。

## 卸载 / 回滚

```bash
# 插件形态
claude plugin disable autodream        # 或 uninstall
# 手工形态：删掉 commands/agents 三个文件 + settings.json 里那三条 hook

# 引擎运行时
node src/cli.cjs stop
rm -rf ~/.claude/.dream      # 全局经验 + 运行态（token / 状态 / 候选都在这里）
```

> ⚠️ **项目级记忆不在 `.dream` 下**。各项目的写入在
> `~/.claude/projects/<slug>/memory/`，那是**独立目录、独立 git 仓库**；
> 上面那条 `rm -rf` **不会**碰它们。要回滚项目记忆，请到对应目录用 git：
> `git -C ~/.claude/projects/<slug>/memory log` / `git revert`。

---


## 设计原则（不得违反）

1. **引擎不含 LLM 客户端** —— 语义判断外包给可替换的打分端点
2. **引擎只有一份** —— 宿主各挂薄适配，引擎不知道宿主存在
3. **模型可见面很小** —— 只暴露状态查询与手动触发，不暴露打分服务
4. **绝不猜** —— 项目归属对不上就判未映射并跳过，绝不写进别人的记忆目录
5. **绝不阻塞宿主** —— hook 毫秒级返回；所有重活交给常驻进程
6. **默认关闭 + 可一键停** —— 会花钱、会改数据的自动化能力，默认必须是关的
7. **失败也要留痕** —— 轮次失败、跳过原因、写入理由都入日志，便于事后归因

## 许可

MIT —— 见 `LICENSE`。
