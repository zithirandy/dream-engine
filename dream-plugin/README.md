# AutoDream（P0 地基）

双宿主（Claude Code / DSH）记忆整合引擎。**P0 只交付地基**：常驻引擎 + 薄 hook + 状态/锁/token + 内容 git 化。
**不含**：转录解析、Jev 打分、记忆写入、宿主 hook 注册（分别属 P1–P4）。

设计依据：`../AutoDream自建插件设计方案V2.md`（v2.0）

---

## 目录

| 路径 | 作用 |
|---|---|
| `src/paths.cjs` | 唯一路径拼装点（`DREAM_HOME` 可覆盖） |
| `src/config.cjs` | 配置加载 + 默认值深合并 |
| `src/log.cjs` | 运行日志（按日 JSONL）+ `daemon.log`（2MB 滚动） |
| `src/state.cjs` | `state.json` 原子读写 + 项目映射合并 |
| `src/lock.cjs` | 单实例 PID 锁（1h 过期、崩溃回收、mtime 回滚） |
| `src/token.cjs` | 本地服务 token（32B hex，尽力 0600） |
| `src/server.cjs` | HTTP `:37778`：只绑 127.0.0.1 + Host 白名单 + token + 无 CORS |
| `src/spawn.cjs` | 探活 + detached 拉起（`windowsHide: true`）+ 60s 节流 |
| `src/daemon.cjs` | 引擎入口（拿锁 → 起服务 → 常驻） |
| `src/nudge.cjs` | hook 薄转发器（stdin → `/event`），**永阻塞、永 exit 0** |
| `src/hook.cjs` | `hooks.json` 直接入口（转发 nudge） |
| `src/projects.cjs` | 扫描宿主记忆目录，播种 `state.projects` |
| `src/gitops.cjs` | 内容目录 git 化 / 提交 / 状态 |
| `src/cli.cjs` | `dreamctl`：install / init / status / doctor / start / stop / rollback / projects / hook / hostcheck / auto |
| `src/auto.cjs` | ★ **P5 自动梦调度器**（`/event` 的消费端）：纯门控 `decide()` + 单飞 + 偏移消费 |

---

## 安装与初始化

```bash
# 开发态 = F:\Demo\dream-src\dream-plugin
node src/cli.cjs install     # 复制 src/*.cjs 全部模块 → ~/.claude/.dream/bin/（当前 35 个）
node src/cli.cjs init        # 建目录 + token + state + config + 扫描项目 + git 化 24 个仓库
```

> ⚠️ `install` 的行为是"把 `src/*.cjs` 全量复制过去"，**没有固定的 14/34 名单** ——
> README 里的数字常因新增模块而过期，以 `ls ~/.claude/.dream/bin/*.cjs | wc -l` 为准。

## 日常运维

```bash
node src/cli.cjs status                 # 门控 / 锁 / 引擎一览
node src/cli.cjs doctor                 # 全面体检（含风险 7 探针）
node src/cli.cjs doctor --json          # 机器可读
node src/cli.cjs start | stop           # 拉起 / 优雅关闭引擎
node src/cli.cjs projects --refresh     # 刷新 state.projects 统计
node src/cli.cjs rollback               # 列出内容仓库与最近提交（P0 只读）
node src/cli.cjs hostcheck              # Host 白名单纯函数自检
node src/cli.cjs auto                   # ★ P5 自动梦：开关 / 未消费事件 / **现在会不会跑及理由**
node src/cli.cjs auto once --dry        # 真实跑一轮但**只打分不写记忆**（会外呼付费 Jev）
```

> ⚠️ **`install` 不会重启已运行的守护进程** —— 它会继续跑**旧代码**（"改了没反应"的经典原因）。
> 安装后若有进程在跑，`install` 会**主动告警**；照它提示 `stop` + `start` 即可。
> （它会覆写 config.json，绝不该作用在真实 home 上）。

### 自动梦（P5）默认**关闭**

`POST /event` 的消费端是 `src/auto.cjs`：事件落盘 → 廉价门控 → 守护进程异步跑一轮。
**默认 `autoDream.enabled=false`** —— 打开它意味着会话结束后引擎会**自己外呼付费 Jev 并真实写记忆**。

```bash
node src/cli.cjs config set autoDream.enabled=true          # 显式开启
node src/cli.cjs config set autoDream.minIntervalMinutes=240 # 主要花钱闸（默认 4h）
node src/cli.cjs config set autoDream.dryRun=true            # 空跑：不打分、不出网、不写记忆
node src/cli.cjs config set mode=audit                       # ★ 想"打分但不写记忆"用这个（正确机制）
node src/cli.cjs auto                                        # 看"现在会不会跑、卡在哪一条"
```

**设计约束**（详见 `src/auto.cjs` 文件头）：绝不阻塞宿主会话（hook 只落盘+判定，跑在守护进程）；
单飞；失败也推进消费偏移（防重试风暴）；`force` 不能绕过 `enabled=false` 与单飞；
超时是**看门狗不是取消**（Node 无法取消已发出的异步工作）。

## HTTP 接口（P0 子集）

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `GET /health` | 免 token | 探活，返回 pid/version/uptime |
| `GET /status` | `X-Dream-Token` | 配置摘要 + 锁 + state |
| `POST /event` | `X-Dream-Token` | 事件落 `raw/pending-events.jsonl`（P1 才做门控） |
| `POST /shutdown` | `X-Dream-Token` + `{confirm:true}` | 优雅关闭 |

P1+ 预留：`/run`、`/prepare`、`/validate`、`/apply`、`/rollback`。

## 安全要点

- **只绑 `127.0.0.1`**，绝不 `0.0.0.0`
- **Host 头白名单**（`127.0.0.1` / `localhost` / `[::1]`）防 DNS rebinding
- **`X-Dream-Token`** 定时安全比较；token 在 `~/.claude/.dream/token`
- **不返回任何 CORS 头**
- 引擎**不含 LLM 客户端**（V2 决策 6）

## 接入宿主 hook（属 P3，P0 未做）

`hooks.json` 应调用：

```json
{ "type": "command", "command": "node \"$HOME/.claude/.dream/bin/hook.cjs\" SessionStart", "timeout": 10 }
```

> ⚠️ P0 **不修改** `~/.claude/settings.json`，因此引擎目前不会随真实会话自动启动。
> 手动验证 hook 通道：`echo '{"hook_event_name":"Stop"}' | node src/hook.cjs Stop`

## 已知边界（P0）

- 项目扫描**不递归子目录**（如某项目的 `memory/historical/` 不会被计入）
- 只处理顶层 `.md` 的记忆目录才会被播种
- 事件仅落盘，不做门控/提炼/打分
- `rollback` 只读，不执行回退动作
