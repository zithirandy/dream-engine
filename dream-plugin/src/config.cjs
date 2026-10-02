'use strict';
/**
 * config.cjs —— 配置加载与默认值合并。
 * 对应 V2 §9。缺文件时用默认值，不写盘（写盘由 CLI init 负责）。
 */
const fs = require('fs');
const pathsMod = require('./paths.cjs');

const DEFAULTS = {
  enabled: true,
  // ★ P2 冲突隔离（核验清单 #1）：官方 AutoDream 与本插件改写**同一个记忆库**。
  //   默认 `audit` = 只读审计层：照常采集/打分/产出候选，但不写任何记忆文件。
  //   确认官方不会同时运行后，再显式 `config set mode=active` 打开写入。
  //   未知取值一律按 audit 处理（向保守方向失败）。
  mode: 'audit',
  guard: { lockStaleMinutes: 30 },   // .consolidate-lock 超过此时长视为崩溃残留，不阻塞写入
  minHours: 24,
  scanThrottleMinutes: 10,
  egress: 'redacted',

  jev: {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    keySource: 'settings:TYPESAFE_API_KEY',
    // ★ P2 实测：从 32 提到 64。依据 —— n=96 单次调用 200（in=59,348，619 tokens/候选），
    //   而 n=32 约 656 tokens/候选：块越大越省（digest 与题面开销不重复付），延迟次线性。
    //   真正防 400 的是下面的体积闸；此值只是个数上的保守上限。
    batchSize: 64,
    // ★ P2 实测（核验清单 #6）：网关限制是**请求体积**而非候选个数 ——
    //   n=96 → payload 161,982 B 单次 200；n=112 → 188,447 B 单次 **400**。
    //   故除个数上限外还按估算体积分块（约 1.7 KB/候选，主要是题面开销），
    //   留 ~20% 余量取 150 KB。**128 档在单次调用下不可达**（会超限被 400，
    //   再由 callAdaptive 拆批救回）。
    maxBatchBytes: 150000,
    // ★ P2 实测：拆分触发集合。此前只在 403 拆批，而实测大批量返回的是 **400**
    //   （网关体积/请求类），"非 403 不拆批"导致 n=111 一次性全灭。
    //   含 5xx 是因为网关抖动同样应重试而非判死。
    splitOn: [400, 403, 413, 414, 431, 500, 502, 503, 504],
    // ⚠️ 已证伪：曾假设 403 是"连续大请求触发限流"，于是加块间/拆批延时。
    //   实测**完全无效** —— 两次运行调用次数（22）与失败条目（cand-056/cand-108）
    //   逐字一致，证明失败是**内容确定性**的，与时间无关。
    //   故默认置 0（加延时只浪费时间）；保留键位以便将来若真出现限流可调。
    chunkDelayMs: 0,
    splitDelayMs: 0,
    timeoutMs: 10000,
    retry: { on: [429, 529], max: 3, baseDelayMs: 800 },
    // ★ 出网净化：每条候选送去 Jev 前的最大字符数（实测：不截断时单条 shell 命令
    //   可能命中 WAF 的命令注入指纹规则 → 403 Cloudflare；截断+折叠可显著抬高可批上限）
    egressMaxChars: 400,
    // ★ P2：codebaseDigest 的字符预算（`known` 语义查重的唯一依据）。
    //   1400 字符在记忆丰富的项目上只装得下 ~9/37 条，会漏判"已覆盖"；
    //   2600 约覆盖 ~18 条。digest 每个请求只出现一次，token 影响有限。
    //   ⚠️ 记忆会持续增长，故必须设上限而非全量（否则请求体无界增长）。
    digestMaxChars: 2600,
    digestEntryMaxChars: 120,
  },

  weights: {
    reusable: 0.30,
    nontrivial: 0.25,
    still_true: 0.25,
    durability: 0.20,
    noneKindPenalty: 0.15,
    // P1 修复：convention 从 0.55 降到 0.2。理由见报告 F3——
    // 抽样实测精度仅 ~28–44%，关键词收紧只能降量（143→62）不能提精度。
    // 降到 0.2 使其无法主导 Jev 输入，并默认禁止自动提升（signals.conventionPromotable=false），
    // 只累积在 candidates/ 供手动梦与人工复核。
    convention: 0.2,
  },
  signals: {
    // P2：convention 不参与自动提升，只进 candidates 待人工/手动梦处置
    conventionPromotable: false,

    // ★ S2+S1：convention 有**两个互相独立**的来源开关。
    //   切勿用单一 conventionEnabled 表达"S2+S1"——主开关会同时关掉两个来源，
    //   得到 0 条候选，与"S1 换来源补召回"矛盾。
    conventionEnabled: true,          // 主开关（kill switch）
    conventionFromAssistant: false,   // S2 停用：助手散文来源（标注基线严格精度 23–33% < 40%）
    conventionFromUser: true,         // S1 启用：用户发言来源（用户是约定的权威；过 userTextPurity 纯度闸）
  },
  // ★ P2 前置标定（2026-09-23，样本：F--DemoApi 112 条真实 Jev 答案）
  //   旧值 0.80/0.70 会把 112 条砍到 3 条（97.3% 被拒）—— 因为 `still_true` 原问法
  //   依赖过薄的 codebaseDigest，答案恒钉在 0.50–0.54（std 0.007、112 条仅 5 个
  //   取值、kind 全为 convention，属**退化答案**）。问题改为自足问法后分布恢复
  //   （0.06–0.91，中位 0.30），故闸值必须按新分布重标。
  //   新值经两类验证：
  //   ① 离线扫频（test/_threshold-sweep.cjs）：该组合通过 18/112 = 16.1%，
  //      命中目标区间（每轮 8–20 条），且 18 条中 14 条来自 user-correction
  //      —— 偏向标注基线里精度最高的信道。
  //   ② 可复现性（test/_gate-stability.cjs）：两次独立评分判定一致率 99.1%
  //      （112 条仅 1 条翻转），通过量 21 vs 22（±2.3%）。闸值 0.40 落在
  //      still_true 合并分布的 p69，属稀疏区，故稳定。→ 硬阈值可作晋升依据。
  //   ⚠️ 仍是**单项目（F--DemoApi）单批样本**得出的值；换项目或接入真实
  //      codebaseDigest 后需用同两个脚本复标。改动方式：`cli config set`。
  gates: {
    stillTrueMin: 0.40,
    reusableMin: 0.60,
    // ★ P2 新增：语义查重闸门。`known.noul ≥ 此值` ⇒ 该经验**已被既有记忆覆盖**
    //   （同一事实/约定/坑），不得作为新经验提升，落入 rejected 并记录理由。
    //   `knownReject: false` 可整体关闭该闸门（例如诊断对比）。
    //   P2 之前保存的结果文件没有 `known` 答案 ⇒ 闸门自动跳过，向后兼容。
    knownRejectMin: 0.75,
    knownReject: true,
    // ★ P2 实测新增：片段/进度叙述闸门。把 `labeling.cjs` 已确立的标注标准
    //   （转折词开头 = 片段、进度/状态 = 噪声）编码进决策。实测 13 条 promote 里
    //   有 5–6 条是「文件 X 经 4 次修改后才通过，最终动作：…」这类**过程叙述**，
    //   写进记忆即污染。命中者进 candidates（边缘），不判 reject。
    fragmentHold: true,
  },
  thresholds: {
    // ★ 核验 P2-2 处置：promote 曾被我误设为 0.45，与 hold 同值 ——
    //   复合分带 `[hold, promote)` 成了**空区间**，"过硬门槛但近似达标"的候选
    //   失去人工复核路径直落 rejected（实测 112 条样本中 3 条受影响；
    //   candidates/ 目录本身不会空，硬门槛未过但分数够的仍会进入）。
    //   V2 §4.4 的原始比例是 promote 0.70 / hold 0.45（带宽 0.25）。
    //   按本次标定的分布（通过者 0.45–0.75）取 promote 0.50 / hold 0.35：
    //   提升量仍为 19 条（与 promote=0.45 相同，不改变标定结论），
    //   同时恢复非空的近似达标带（3 条）与更宽的调参样本池（拒绝 51 而非 82）。
    //   ⚠️ `deadZone` 是**逐维度**概念（V2 §4.4"任一判断落入死区则不提升"），
    //      与 hold/promote 的**复合分**两档不是一回事，勿混用。
    promote: 0.50,
    hold: 0.35,
    deadZone: 0.05,
    minDurabilityConfidence: 0.50,
    // P1：候选与既有记忆的**重叠系数**（|A∩B|/min）超过此值即视为「已知」
    // 用重叠系数而非 Jaccard：短候选 vs 长记忆文件时 Jaccard 天然偏低，会漏判
    dupOverlap: 0.60,
    // P1：候选之间的自去重阈值（Jaccard，长度相近时更合适）
    selfDupJaccard: 0.75,
  },
  global: { fanoutMinNoul: 0.75, maxFanout: 5 },

  limits: {
    maxBytesPerRun: 33554432,
    maxCandidatesPerRun: 300,
    maxJevBatchesPerRun: 4,
    maxPromotionsPerRun: 40,
    maxLineBytes: 65536,
    tailSealAfterDays: 7,
    // P1：单类候选上限，防某一类（如 error-fix）淹没其余信号
    maxCandidatesPerSignal: {
      'error-fix': 120,
      'env-fact': 60,
      'user-correction': 80,
      'retry-then-success': 60,
      convention: 60,
    },
  },

  // P1 递归定策：memory 目录递归 1 层；顶层 .md 进索引，子目录 .md 作附属证据
  scan: { recursiveDepth: 1, auxiliarySubdirs: true, maxAuxFiles: 200 },

  redact: { extraPatterns: [], sensitiveTerms: [], redactPrivateIps: true },

  // ★ 核验 N4 处置：候选文本的**上游污染**处理（详见 hygiene.cjs）。
  //   实测 153 条候选里 12 条（7.8%）带 JSON 转义残留，且逐条溯源确认
  //   **源转录本就是字面转义**（`导单` 出现 0 次）—— 不是我们的解析 bug。
  textHygiene: {
    trimJsonFragments: true,      // 清尾部 `",` 之类纯噪声（语义无损，默认开）
    trimRequestTail: true,        // 裁掉用户纠正句尾的请求语（"…，先帮我排查下原因"）
    // ⚠️ 默认**关**：`\uXXXX`→字符 一般安全（`\u5bfc`→导），但"讨论转义序列本身"的
    //    候选会被改坏；且 `\n`/`\t`/`\"` **一律不解码**（命令里的 `\n` 有语义）。
    //    若要还原字符，显式 `config set textHygiene.decodeUnicodeEscapes=true`。
    decodeUnicodeEscapes: false,
  },
  retentionDays: { logs: 90, rejected: 30, daemonLog: 7, appliedProposals: 30, autoLog: 30 },

  // ═══════════════════════════════════════════════════════════════════════
  // ★ P5 自动梦（`POST /event` 的消费端，见 src/auto.cjs）
  //
  //   ★★ `enabled` 默认 **false**，这是刻意的、不可妥协的默认值 ★★
  //   打开它意味着：每个满足条件的会话结束后，引擎会**自己**去
  //     ① 采集转录 → ② **外呼付费 Jev API** → ③ **真实写记忆文件**
  //     （含把指针写进其它项目的 MEMORY.md —— G2 分发）
  //   这种"会自己花钱、自己改记忆"的能力，必须由操作员显式开启。
  //   开启：node cli.cjs config set autoDream.enabled=true
  // ═══════════════════════════════════════════════════════════════════════
  autoDream: {
    enabled: false,

    // 哪些 hook 事件**有权**触发一轮。`session-end` 是最强信号（会话真的结束了）；
    // `stop` 只代表一轮对话结束，**必须**配合下面的静默期，否则会在用户
    // 连续交互中途插进来做梦。
    triggerOn: ['session-end', 'stop'],

    // 距**最后一次**事件多久才认为"用户已经离开"。防止在连续对话中插队。
    idleMinutes: 5,
    requireIdle: true,

    // 两次自动梦之间的最小间隔。★ 这是**主要的花钱闸**：
    // pipeline 自己的 gate 另有 minHours=24 / scanThrottleMinutes=10，
    // 本值是自动梦特有的节奏（比 minHours 更细，因为手动梦不推进 lastRunAt）。
    minIntervalMinutes: 240,

    // 至少积累几个未消费事件才值得跑（1 = 来一个就能触发，配合 minInterval 足够安全）
    minEvents: 1,

    // 跑之前先采集（pipeline.run）。⚠️ 必须为 true：`p2.autoDream` **不自己采集**，
    // 关掉它就只能对**旧候选池**打分，新会话内容永远进不来。
    harvestFirst: true,

    // true = **空跑**：把这一轮交给 `p2.autoDream({dryRun:true})`，它只算出"会做什么"
    // 就返回，**不打分、不出网、不写记忆**（实测 dream 阶段 13ms、0 次 Jev 调用）。
    //
    // ⚠️ 名字改过：原叫 `scoreOnly`（"只打分不写记忆"）—— **名不副实**，因为 dryRun
    //    连打分都跳过。真正的"打分但不写记忆"是既有的 **`mode: 'audit'`**
    //    （guard 会算出 effectiveMode=audit、allow=false，照常打分与决策，只是拒绝落盘）。
    //    想先观察自动梦会打分/提升什么，用 `config set mode=audit`，不要用这个开关。
    dryRun: false,

    tickSeconds: 60,

    // 看门狗：超过它只**告警**（Node 无法取消已发出的异步工作，见 auto.cjs 注释 4）
    maxRunMs: 180000,
    // 超过它才强制清零单飞标志（承认可能重叠），否则自动梦会永久卡死
    hardTimeoutMs: 600000,

    // ★ P5 决策（2026-09-24）：**自动梦路径绕过 `minHours`（24h 采集中枢）**。
    //
    //   为什么：`minHours` 管的是**采集**节奏（依据 `state.lastRunAt`）。自动梦的触发点
    //   是"会话刚结束"——若被 24h 中枢挡住，`dream` 阶段就只能对**旧候选池**打分，
    //   刚结束那个会话的内容进不来。实测第一轮就是 `harvest.skipped=true,
    //   gate:["min-hours (13.03h < 24h)"]`。
    //
    //   ⚠️ 但**只绕过这一道**：`scanThrottleMinutes`（10min）与单例锁**保留** ——
    //      前者是"连续两个会话结束 → 连续两次全量采集"的抖动保护。
    //      注意**不要**用 `--ignore-gate` 实现这件事，那是全绕过，粒度太粗。
    harvestIgnoreMinHours: true,

    // 哪些事件**天然视为已静默**（跳过 `idleMinutes` 等待）。
    // `session-end` 意味着会话真的结束了，用户已经离开 —— 再等 5 分钟观察期没有意义。
    // `stop` 只代表一轮对话结束（用户可能马上继续输入），**必须**保留静默期。
    // 置空数组即可恢复"所有事件都要等静默期"的旧行为。
    idleExemptKinds: ['session-end'],

    // ★ 长线必需：`pending-events.jsonl` 的轮转上限（字节）。
    //
    //   为什么必须有：该文件是**追加式**且此前**无任何轮转** —— 长线跑下去会无界增长
    //   （实测 ~110 B/事件；`Stop` 每轮对话结束都会产生一条）。auto-dream 关闭时
    //   事件只堆积不消费，偏移不动，文件永远不缩。
    //
    //   轮转语义（务必理解，否则会写坏）：**只丢弃"已消费的头部"，保留"未消费的尾部"**。
    //   → 不丢任何未处理事件，也不会把已消费事件重新变成"未消费"（那会凭空触发一轮）。
    //   若未消费尾部本身就超过上限（说明长期未跑、积压成山），则只保留最后一半并**记日志
    //   说明丢弃了多少条触发** —— 这是可接受的：触发事件只在"新鲜"时有意义，
    //   会话内容本身在转录里有独立偏移，不会被丢。
    pendingEventsMaxBytes: 2097152,   // 2 MB ≈ 1.9 万事件 ≈ 数月
  },

  // ══════════════════════════════════════════════════════════════════════
  // GitHub 采集（每早定时拉取 issue / 评论 / PR 并出报告）
  // ══════════════════════════════════════════════════════════════════════
  // 与 autoDream 完全独立：那一个由"会话结束"事件驱动，这一个由墙上时钟驱动。
  github: {
    // 默认关：装插件不等于同意它每天出网打 GitHub（与 autoDream 同一原则）。
    enabled: false,

    // 要采集的仓库，`owner/name`。空数组 = 不跑（并给出配置提示）。
    // ⚠️ 不用 `github.repo` 单数形式：多仓库是自然的扩展方向，一开始就用数组。
    repos: [],

    // 传输层。默认 'gh' —— 见 github-api.cjs 文件头：本机 hosts 把 api.github.com
    // 劫持到 127.0.0.1 做 TLS 中间人，Node 裸 fetch 必然 UNABLE_TO_VERIFY_LEAF_SIGNATURE，
    // 而 hook/daemon 是以不带 --use-system-ca 的 `node xxx.cjs` 拉起的，无法自救。
    // 'rest' 仅在证书链可信的环境可用（那时会给 fetch 带上 token）。
    transport: 'gh',

    // gh 可执行文件路径。null = 自动定位（PATH → 常见安装位置）。
    ghPath: null,

    // 凭据来源，三种互斥取值：
    //   'gh'                      —— 问已登录的 gh CLI 要 token（存在 Windows 凭据管理器，
    //                                **从不落到本插件任何文件**）。默认值。
    //   'settings:GITHUB_TOKEN'   —— 从宿主 settings.json 的 env 读，与 jev.keySource 同约定。
    //   'env:GITHUB_TOKEN'        —— 进程环境变量（显式非默认例外）。
    // ⚠️ 无论哪种，token **绝不进日志**，对外只报 from= 出处。
    tokenSource: 'gh',

    report: {
      // 报告输出目录。null = <DREAM_HOME>/github-reports。
      // 用户可指向任意绝对路径（含空格/中文/&，故**不要**用 CLI 传参设置，
      // 直接改 config.json —— shell 会截断 `&`）。
      dir: null,
      filePrefix: 'GitHub日报',
      // 每条正文最多渲染多少字符（状态文件不存正文，故这只影响报告体积）
      includeBodyChars: 3000,
      // true = 即使本轮零变化也照常出报告（每天一份留痕）
      writeUnchanged: true,
      // 报告正文过 redact.cjs：别人可能在 issue 里贴 token，本地报告不该把它存下来
      redactCredentials: true,
    },

    collection: {
      // 每天的应跑时刻（本地时间 HH:MM）。计划任务与闸门都读这个值。
      schedule: '08:00',
      // 首次运行（无历史游标）时往前回溯多少天，防止无界拉取
      maxAgeDays: 30,
      // 两次运行之间的窗口重叠，兜住时钟偏差与"上一轮跑到一半"
      overlapMinutes: 10,
      perPage: 100,
      // ★ 硬上限：`gh api --paginate` **没有页数上限**，实测对 issue 巨多的仓库
      //   会挂死 120s+。故采集器自己翻页并受此值约束，触顶会在报告里显式告警。
      maxPages: 5,
      // 单个 API 调用的超时（spawnSync timeout 实测能 SIGTERM 兜住不挂死）
      timeoutMs: 30000,
      // PR review 端点无 since，只能逐 PR 拉；限制每轮最多补采几个 PR
      maxReviewPrs: 20,
      sources: {
        issues: true,
        issueComments: true,
        prs: true,
        prReviews: true,
        prReviewComments: true,
        // 通知是跨仓库的，且与上面的条目大量重复 ⇒ 默认关
        notifications: false,
      },
    },

    // ⚠️ 已移除（2026-09-29）：原 `github.schedule: { taskName, catchUp }` 随
    //   `schtasks.cjs` 一起删掉了。调度改由 **DSH 任务看板**承担。
    //
    //   删它的直接原因不是"没用"，而是**它在主动误导**：
    //     · `github doctor` 会恒定报 `✗ 计划任务 未注册 → …schedule install`；
    //     · 每日审查报告会拿 `taskName` 去找一个**已被特意注销**的 Windows 任务，
    //       结果在报告里写成"无法确认守护进程的调度载体"。
    //   残留配置产生的是**假线索**，不是冗余 —— 这是删掉而非保留的理由。
    //   归档见 `archive/schtasks-removed-2026-09-29/`。
  },

  server: { host: '127.0.0.1', port: pathsMod.DEFAULT_PORT, requireToken: true },
};
function deepMerge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (typeof base !== 'object' || typeof over !== 'object') return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function load() {
  const p = pathsMod.paths();
  if (!fs.existsSync(p.config)) return { config: JSON.parse(JSON.stringify(DEFAULTS)), source: 'defaults' };
  try {
    const raw = fs.readFileSync(p.config, 'utf8');
    const user = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return { config: deepMerge(DEFAULTS, user), source: p.config };
  } catch (e) {
    return { config: JSON.parse(JSON.stringify(DEFAULTS)), source: 'defaults', error: e.message };
  }
}

/** 递归列出叶子路径（用于报告"新增了哪些键"） */
function leafPaths(obj, prefix = '') {
  const out = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [prefix];
  for (const [k, v] of Object.entries(obj)) out.push(...leafPaths(v, prefix ? `${prefix}.${k}` : k));
  return out;
}

/**
 * ★ 核验 §5.1 修复：把全量默认值**落进** config.json。
 *
 * 此前 S2+S1 的翻转只存在于代码默认值，直接编辑 config.json 的操作员
 * 看不到 `signals` 段、也不知道它存在。materialize() 以"用户值优先"合并，
 * 只补缺失键，不覆盖任何用户已设的值。
 */
function materialize() {
  const p = pathsMod.paths();
  let existing = {};
  let existed = false;
  if (fs.existsSync(p.config)) {
    existed = true;
    try {
      const raw = fs.readFileSync(p.config, 'utf8');
      existing = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (e) {
      return { ok: false, reason: 'existing-config-invalid-json', error: e.message, path: p.config };
    }
  }
  const before = new Set(leafPaths(existing));
  const merged = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), existing);
  const after = leafPaths(merged);
  const added = after.filter((k) => !before.has(k));

  const withNote = {
    _note: 'AutoDream 配置。install/init 会以「用户值优先」补全缺失键；此文件可直接编辑。',
    _generatedAt: new Date().toISOString(),
    ...merged,
  };
  fs.mkdirSync(p.home, { recursive: true });
  const tmp = `${p.config}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(withNote, null, 2), 'utf8');
  fs.renameSync(tmp, p.config);
  return { ok: true, existed, added, addedCount: added.length, path: p.config };
}

/** 按点号路径取叶子（不存在返回 undefined） */
function getPath(obj, dotted) {
  let cur = obj;
  for (const seg of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * ★ P2 前置：按 DEFAULTS 的类型参照把字符串值强制转换。
 * 拒绝未知路径 —— 否则 `config set gates.stillTureMin=0.4` 这种拼写错误会静默
 * 写进一个**没人读**的键，操作员以为改了闸值而实际没改（本插件的闸值只在
 * jev.cjs 读 `gates.stillTrueMin`，拼错即等于没设）。
 */
function coerce(ref, raw) {
  if (Array.isArray(ref)) {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) throw new Error('期望 JSON 数组');
    return v;
  }
  switch (typeof ref) {
    case 'number': {
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error('期望数字');
      return v;
    }
    case 'boolean':
      if (raw !== 'true' && raw !== 'false') throw new Error('期望 true/false');
      return raw === 'true';
    case 'string':
      return raw;
    default:
      throw new Error('目标不是可赋值的叶子（是对象或 null）');
  }
}

/**
 * ★ P2 前置：**修改已存在的配置值**。
 *
 * 这是 materialize() 补不上的缺口：materialize 明确"用户值优先、只补缺失键"，
 * 所以闸值一经写入 config.json 就再也无法通过 CLI 改动 —— 而阈值标定是需要
 * 反复复标的动作。setValues 走与 materialize 相同的原子写盘，并：
 *   · 以 DEFAULTS 叶子为**类型参照**做校验（数字/布尔/字符串/数组）
 *   · 未在 DEFAULTS 中出现的路径一律拒绝（防拼写错误静默生效）
 *   · 只改被点名的键，其余原样保留
 */
function setValues(pairs, { defaults = DEFAULTS } = {}) {
  const p = pathsMod.paths();
  let existing = {};
  if (fs.existsSync(p.config)) {
    try {
      const raw = fs.readFileSync(p.config, 'utf8');
      existing = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (e) {
      return { ok: false, reason: 'existing-config-invalid-json', error: e.message, path: p.config };
    }
  }
  const base = deepMerge(JSON.parse(JSON.stringify(defaults)), existing);
  const applied = [];
  const rejected = [];
  for (const { path: dotted, value } of pairs) {
    const ref = getPath(defaults, dotted);
    if (ref === undefined) { rejected.push({ path: dotted, reason: 'unknown-key' }); continue; }
    let v;
    try { v = coerce(ref, value); } catch (e) { rejected.push({ path: dotted, reason: e.message }); continue; }
    const segs = dotted.split('.');
    const last = segs.pop();
    let cur = base;
    for (const s of segs) { if (typeof cur[s] !== 'object' || cur[s] === null) cur[s] = {}; cur = cur[s]; }
    const before = cur[last];
    cur[last] = v;
    applied.push({ path: dotted, from: before, to: v });
  }
  if (!applied.length) return { ok: false, reason: 'nothing-applied', applied, rejected, path: p.config };

  const withNote = {
    _note: 'AutoDream 配置。install/init 会以「用户值优先」补全缺失键；此文件可直接编辑，也可用 `node src/cli.cjs config set k=v`。',
    _generatedAt: new Date().toISOString(),
    ...base,
  };
  fs.mkdirSync(p.home, { recursive: true });
  const tmp = `${p.config}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(withNote, null, 2), 'utf8');
  fs.renameSync(tmp, p.config);
  return { ok: true, applied, rejected, path: p.config };
}

/**
 * ★ 默认值 vs 线上值的漂移检测。
 *
 * 存在的理由（本会话被咬过两次）：`materialize()` 保留用户已有值，所以
 * **改了 `DEFAULTS` 不会影响已存在的 config.json**。改默认值的人会以为生效了，
 * 而线上仍是旧值 —— 且无任何提示。第一次发生在闸值（0.8/0.7 改了默认但线上没变），
 * 第二次发生在 `chunkDelayMs`（默认从 350 改成 0，线上仍跑 350）。
 *
 * 返回每个叶子的差异，供 `config diff` 与 `doctor` 使用。
 */
function drift({ defaults = DEFAULTS } = {}) {
  const { config: live, source } = load();
  const out = [];
  const walk = (base, cur, prefix) => {
    for (const [k, v] of Object.entries(base)) {
      const p = prefix ? `${prefix}.${k}` : k;
      const lv = cur === null || typeof cur !== 'object' ? undefined : cur[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) { walk(v, lv, p); continue; }
      if (JSON.stringify(lv) !== JSON.stringify(v)) out.push({ path: p, default: v, live: lv });
    }
  };
  walk(defaults, live, '');

  // ★ P5 补：**反向检测孤儿键**（在 config.json 里、但 DEFAULTS 里没有）。
  //
  //   为什么必须有：`materialize()` 的契约是"用户值优先，只补缺失键"，**从不删除**。
  //   于是**改名的键会永久留成孤儿** —— 实测：`scoreOnly` 改名成 `dryRun` 后，
  //   config.json 里 `dryRun:false` 与残留的 `scoreOnly:true` **并存**。
  //   而原来的 drift() 只遍历 DEFAULTS，**看不见孤儿** ⇒ 操作员读到 `scoreOnly:true`
  //   会以为"仅打分模式开着"，实际没有任何代码读它。这是会骗人的静默陷阱。
  //   同理，删掉一个配置键后，旧值也会一直躺在文件里。
  const extra = [];
  const leaf = (obj, prefix = '') => {
    const acc = [];
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [prefix];
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;                 // _note / _generatedAt 是元数据
      acc.push(...leaf(v, prefix ? `${prefix}.${k}` : k));
    }
    return acc;
  };
  const known = new Set(leaf(defaults));
  for (const p of leaf(live)) {
    if (!known.has(p)) extra.push({ path: p, live: getPath(live, p) });
  }

  return { ok: out.length === 0 && extra.length === 0, count: out.length, extraCount: extra.length, diffs: out, extra, source };
}

module.exports = { load, materialize, setValues, getPath, coerce, drift, DEFAULTS, deepMerge, leafPaths };
