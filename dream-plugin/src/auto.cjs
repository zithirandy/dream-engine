'use strict';
/**
 * auto.cjs —— ★ P5：`POST /event` 的**真实消费端**（自动梦调度器）。
 *
 * 存在的理由：此前 `server.cjs` 的 `/event` 只把事件追加到 `pending-events.jsonl`
 * 就返回 `processed:false, phase:'P0'` —— **没有任何消费者**。hook 接上了，
 * 下游是空的：整条链在最后一环断掉（见《CC 安装状态检查报告》§2）。
 * 本模块补上那一环。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么它必须长成这样（每一条都对应一个真实约束）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1) **绝不阻塞宿主会话**。hook 的 `Stop` 超时是 3s，`SessionStart` 是 10s。
 *    所以 `/event` 只做"追加 + 算一个廉价 verdict"，**当场返回**；
 *    真正的"跑一轮"由**守护进程**异步做。这是"常驻 worker + 极薄 hook"
 *    架构的兑现，而不是把活儿塞回 hook。
 *
 * 2) **默认关闭**（`autoDream.enabled=false`）。自动梦会**真实外呼付费 Jev**
 *    并**真实写记忆**（含把指针写进其它项目的 MEMORY.md）。这种动作必须显式
 *    开启，不能因为"装上了"就自己开始跑。
 *
 * 3) **复用既有门控，不另造一套**。`pipeline.gate()` 已经在管
 *    `enabled` / `minHours` / `scanThrottleMinutes` / 锁占用。自动梦在此之上
 *    只加**它自己特有的**两件事：**触发事件类型**与**静默期**（别在用户
 *    打字中途插进来）。
 *
 * 4) **单飞**。守护进程是唯一 runner，用进程内标志保证同一时刻只有一轮。
 *    ⚠️ 如实说明：**Node 无法取消已发出的异步工作**。所以 `maxRunMs` 是
 *    **看门狗**（超过就告警），不是"取消"。只有超过 `hardTimeoutMs` 才会
 *    强制清零标志并**大声记日志**（承认可能重叠），因为否则自动梦会永久卡死。
 *
 * 5) **消费偏移必须推进，即使本轮失败**。否则一个"毒批次"会让每次 tick 都
 *    重试同一批事件 → 重试风暴。事件本身只是**触发器**（kind/project/sessionId），
 *    会话内容由 `pipeline` 从转录按它自己的偏移读取 —— 所以丢弃触发器事件
 *    不会丢内容。失败改为记在 state 里由 `/dream-status` 呈现。
 *
 * 6) **`decide()` 是纯函数**。门控是这套东西里最容易出错、也最该被测的部分，
 *    所以它不碰 I/O：给定 (cfg, state, pending, lock, now) 就给出确定答案。
 *    `test/auto.cjs` 因此可以离线穷举各种组合，**不调 Jev、不写记忆**。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const stateMod = require('./state.cjs');
const lockMod = require('./lock.cjs');
const log = require('./log.cjs');

const OFF = 0x0a; // '\n'

// ---------------------------------------------------------------- 事件消费

/**
 * 从 `pending-events.jsonl` 的**字节偏移**处读取未消费事件。
 *
 * 两处必须小心：
 *   · **按字节而非字符**切分 —— 中文事件会因多字节字符导致偏移漂移。
 *   · **只消费完整的行**（到最后一个 `\n` 为止）—— 否则会读到写入中的半行。
 *   · 文件被截断/轮转（size < offset）时**归零重读**，不猜。
 */
function readPending({ file, fromOffset = 0, maxEvents = 500 } = {}) {
  if (!file || !fs.existsSync(file)) return { events: [], offset: 0, size: 0, truncated: false, malformed: 0 };
  const size = fs.statSync(file).size;
  let start = Number(fromOffset) || 0;
  let truncated = false;
  if (start > size) { start = 0; truncated = true; }   // 轮转/截断
  if (start === size) return { events: [], offset: size, size, truncated, malformed: 0 };

  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally { fs.closeSync(fd); }

  const nl = buf.lastIndexOf(OFF);
  const consumable = nl === -1 ? Buffer.alloc(0) : buf.subarray(0, nl + 1);
  const nextOffset = start + consumable.length;

  const events = [];
  let malformed = 0;
  for (const line of consumable.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    if (events.length >= maxEvents) break;
    try { events.push(JSON.parse(line)); } catch { malformed++; }
  }
  return { events, offset: nextOffset, size, truncated, malformed };
}

function readAutoOffsets() {
  const p = pathsMod.paths();
  const f = p.autoOffsets;
  if (!fs.existsSync(f)) return { pendingOffset: 0, updatedAt: null, lastRunAt: null };
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    // ★ 修正（2026-09-28）：此前**只回传 3 个字段**，而 `writeAutoOffsets` 写入的
    //   `primed` / `rotatedAt` / `consumed` / `trigger` / `note` 被**读后即弃**。
    //   后果是 `cli.cjs` 里两条诊断分支成了死代码 —— `offs.primed ? ' · 已预热…'`
    //   与 `offs.rotatedAt ? ' · 上次轮转…'` **永远不会显示**，即使文件里确实有值
    //   （实测磁盘上的 auto-offsets.json 就带 consumed/trigger，却看不到）。
    //   改为**透传全部字段**：消费方只取自己要用的，多余字段无害。
    //   ⚠️ 三个"必有"字段仍显式归一化，保持原有契约不变。
    return {
      ...j,
      pendingOffset: Number(j.pendingOffset) || 0,
      updatedAt: j.updatedAt || null,
      lastRunAt: j.lastRunAt || null,
    };
  } catch { return { pendingOffset: 0, updatedAt: null, lastRunAt: null, corrupt: true }; }
}

function writeAutoOffsets(next) {
  const p = pathsMod.paths();
  log.ensureDir(p.raw);
  const tmp = `${p.autoOffsets}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  fs.renameSync(tmp, p.autoOffsets);
}

function appendAutoLog(obj) {
  try {
    const p = pathsMod.paths();
    log.ensureDir(p.logs);
    fs.appendFileSync(p.autoLog, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8');
  } catch { /* 日志失败绝不能影响主流程 */ }
}

// ---------------------------------------------------------------- 纯门控

/**
 * ★ 纯函数门控：**不碰任何 I/O**，只根据传入的快照给答案。
 *
 * @param {object}  a0
 * @param {object}  a0.cfg        配置（含 autoDream 段与顶层 enabled）
 * @param {object}  a0.state      引擎 state
 * @param {object}  a0.pending    readPending() 的返回
 * @param {object}  a0.lock       lockMod.readLock() 的返回
 * @param {number}  a0.nowMs
 * @param {boolean} a0.running    是否已有一轮在跑（单飞）
 * @param {number}  a0.selfPid    本进程 pid（自己持有的锁不算占用）
 * @param {boolean} a0.force      运维显式绕过（仍**不**绕过 enabled 与 running）
 * @param {boolean} a0.allowNoEvents 仅**运维命令行**使用：允许"没有未消费事件也跑一轮"。
 *        调度器**永远不传**它 —— 事件驱动的东西不该在没事件时自动启动。
 * @returns {{pass:boolean, reasons:string[], detail:object}}
 */
function decide({ cfg, state = {}, pending = { events: [] }, lock = {}, nowMs = Date.now(), running = false, selfPid = process.pid, force = false, allowNoEvents = false } = {}) {
  const a = (cfg && cfg.autoDream) || {};
  const reasons = [];
  const events = pending.events || [];

  // 这些**永远不能被 force 绕过**：关着就是关着；已在跑就不能再起一轮。
  if (!cfg || cfg.enabled === false) reasons.push('engine-disabled');
  if (a.enabled !== true) reasons.push('auto-dream-disabled');
  if (running) reasons.push('already-running');

  const lastEventTs = events.length ? events[events.length - 1].ts : (pending.lastTs || null);
  const lastEventMs = lastEventTs ? Date.parse(lastEventTs) : 0;
  const idleMin = lastEventMs ? (nowMs - lastEventMs) / 60000 : Infinity;

  const lastAutoMs = state.lastAutoDreamAt ? Date.parse(state.lastAutoDreamAt) : 0;
  const sinceAutoMin = lastAutoMs ? (nowMs - lastAutoMs) / 60000 : Infinity;

  const kinds = [...new Set(events.map((e) => e.kind))];
  const triggerOn = a.triggerOn || [];
  const triggered = kinds.filter((k) => triggerOn.includes(k));

  // ★ 天然静默：`session-end` 意味着会话真的结束了、用户已离开，再等 `idleMinutes`
  //   观察期没有意义（`stop` 不同 —— 用户可能马上继续输入，必须保留静默期）。
  const idleExempt = (a.idleExemptKinds || []).filter((k) => kinds.includes(k));

  // 锁：自己持有的不算占用（守护进程自己就拿着单例锁）
  const lockHeld = !!(lock && lock.exists && lock.alive && lock.pid !== selfPid);

  if (!force) {
    // ⚠️ 这一整段是**非 force** 路径：`allowNoEvents` 在此**绝不能生效**。
    //    （曾经的 bug：把 allowNoEvents 也用在这里，导致安静期、零事件也能通过 →
    //     `auto once` 会在没有任何事件时意外跑一轮付费梦。测试 A18 抓住。）
    if (lockHeld) reasons.push(`lock-held (pid ${lock.pid})`);
    if (events.length < (a.minEvents || 1)) reasons.push(`min-events (${events.length} < ${a.minEvents || 1})`);
    if (!triggered.length) reasons.push(`no-trigger-event (kinds=${kinds.join('|') || 'none'})`);
    if (a.requireIdle !== false && !idleExempt.length && idleMin < (a.idleMinutes || 0)) {
      reasons.push(`not-idle (${idleMin === Infinity ? '∞' : idleMin.toFixed(1)}min < ${a.idleMinutes}min)`);
    }
    if (sinceAutoMin < (a.minIntervalMinutes || 0)) {
      reasons.push(`min-interval (${sinceAutoMin === Infinity ? '∞' : sinceAutoMin.toFixed(0)}min < ${a.minIntervalMinutes}min)`);
    }
  } else {
    reasons.push('force-bypass');
  }

  // force 时仍要求"至少有一个触发器事件"，除非运维显式 `allowNoEvents`
  // （只有 CLI 的 `auto once --force` 会传它）—— 否则 force 就成了"无缘无故跑一轮"。
  const hasTrigger = events.length > 0 || (force && allowNoEvents);
  const pass = force
    ? (cfg && cfg.enabled !== false) && a.enabled === true && !running && hasTrigger
    : reasons.length === 0;

  return {
    pass,
    reasons,
    detail: {
      events: events.length, kinds, triggered,
      idleExempt,
      idleMinutes: idleMin === Infinity ? null : Number(idleMin.toFixed(2)),
      sinceLastAutoMinutes: sinceAutoMin === Infinity ? null : Number(sinceAutoMin.toFixed(2)),
      lastAutoDreamAt: state.lastAutoDreamAt || null,
      lockHeld,
    },
  };
}

// ---------------------------------------------------------------- 轮转

/**
 * ★ 长线必需：`pending-events.jsonl` 轮转（此前无任何轮转，会无界增长）。
 *
 * 语义（唯一不会写坏的做法）：**只丢弃"已消费的头部"，保留"未消费的尾部"**。
 *   · 不丢任何未处理事件
 *   · 不把已消费事件重新变成"未消费"（那会凭空触发一轮梦）
 *   · 尾部被搬到文件开头，故**偏移归零**
 *
 * 若未消费尾部本身就超上限（长期未跑、积压成山），只保留最后一半并按行对齐，
 * 并**记录丢了多少条触发**。可接受的理由：触发事件只在"新鲜"时有意义；
 * 会话内容在 `raw/offsets.json`（转录偏移）里有独立记账，不受此影响。
 */
function rotatePendingIfNeeded({ cfg, deps, file } = {}) {
  try {
    const p = file || pathsMod.paths().pendingEvents;
    if (!fs.existsSync(p)) return { rotated: false };
    const size = fs.statSync(p).size;
    const cap = (cfg && cfg.autoDream && Number(cfg.autoDream.pendingEventsMaxBytes)) || 2097152;
    if (size <= cap) return { rotated: false, size, cap };

    const offs = deps ? deps.readOffsets() : readAutoOffsets();
    const consumed = Math.min(Math.max(0, Number(offs.pendingOffset) || 0), size);
    let buf = fs.readFileSync(p).subarray(consumed);      // 未消费尾部
    let droppedTriggers = 0;

    if (buf.length > cap) {
      const keepFrom = buf.length - Math.floor(cap / 2);
      const nl = buf.indexOf(OFF, keepFrom);
      const trimmed = nl === -1 ? buf.subarray(keepFrom) : buf.subarray(nl + 1);
      droppedTriggers = buf.subarray(0, buf.length - trimmed.length).toString('utf8')
        .split('\n').filter((l) => l.trim()).length;
      buf = trimmed;
    }

    const kept = buf.toString('utf8').split('\n').filter((l) => l.trim()).length;
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, buf, 'utf8');
    fs.renameSync(tmp, p);

    const rec = {
      fromBytes: size, toBytes: buf.length, cap,
      keptUnconsumed: kept, droppedTriggers,
      note: droppedTriggers
        ? '未消费积压超上限，丢弃最旧的触发事件（会话内容不受影响：转录偏移独立记账）'
        : '仅丢弃已消费头部',
    };
    const next = { pendingOffset: 0, rotatedAt: new Date().toISOString(), rotated: true };
    if (deps) { deps.writeOffsets(next); deps.info('auto-dream: pending-events rotated', rec); }
    else { writeAutoOffsets(next); appendAutoLog({ reason: 'rotate', ...rec }); }
    return { rotated: true, ...rec };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (deps) deps.warn('auto-dream: rotation failed (non-fatal)', { err: msg });
    return { rotated: false, error: msg };
  }
}

// ---------------------------------------------------------------- 跑一轮

/** 默认依赖：真实实现。测试全部注入替身，故这里不会被测试触发。 */
function defaultDeps() {
  return {
    now: () => Date.now(),
    selfPid: process.pid,
    loadCfg: () => configMod.load().config,
    readState: () => stateMod.read(),
    updateState: (fn) => stateMod.update(fn),
    readLock: () => { try { return lockMod.readLock(); } catch { return {}; } },
    readPending: (fromOffset) => readPending({ file: pathsMod.paths().pendingEvents, fromOffset }),
    readOffsets: readAutoOffsets,
    writeOffsets: writeAutoOffsets,
    appendLog: appendAutoLog,
    // 真实"跑一轮"= 先采集（pipeline.run）再打分/决策/提升（p2.autoDream）。
    // ⚠️ p2.autoDream **不会自己采集**，漏掉 harvest 就只有旧候选池可打分。
    harvest: (opts) => require('./pipeline.cjs').run(opts),
    dream: (opts) => require('./p2.cjs').autoDream(opts),
    warn: (msg, extra) => log.warn(msg, extra),
    info: (msg, extra) => log.info(msg, extra),
    error: (msg, extra) => log.error(msg, extra),
  };
}

/**
 * 跑一轮。**只被调度器调用**；单飞由调度器的 `running` 标志保证。
 * 任何异常都在内部消化并记录 —— 绝不允许把调度器带崩。
 */
async function runRound({ cfg, deps, reason = 'manual', force = false } = {}) {
  const a = (cfg && cfg.autoDream) || {};
  const t0 = deps.now();
  const rec = { reason, force, ok: false, phase: 'start', harvest: null, dream: null, error: null };

  try {
    if (a.harvestFirst !== false) {
      rec.phase = 'harvest';
      // ★ P5 决策：自动梦路径**只绕过 `minHours`**（24h 采集中枢），
      //   `scanThrottleMinutes` 与锁照旧 —— 否则"会话刚结束"采不到该会话的内容。
      //   绕过事实记进日志，方便日后审计"这一轮到底采没采"。
      const ignoreMinHours = a.harvestIgnoreMinHours !== false;
      const h = await deps.harvest({ dryRun: false, ignoreMinHours });
      rec.harvest = h && {
        ok: h.ok,
        skipped: !!h.skipped,
        gate: h.gate && h.gate.reasons,
        minHoursBypassed: !!(h.gate && h.gate.detail && h.gate.detail.minHoursBypassed),
        candidates: h.candidates && h.candidates.length,
      };
    }
    rec.phase = 'dream';
    const d = await deps.dream({ json: false, dryRun: a.dryRun === true });
    rec.dream = d && {
      skipped: !!d.skipped, reason: d.reason,
      policy: d.policy && { effectiveMode: d.policy.effectiveMode, allow: d.policy.allow, conflict: d.policy.conflict },
      selected: d.selected, jevCalls: d.scoring && d.scoring.calls,
      decisions: d.decisions && { promote: d.decisions.promote, hold: d.decisions.hold, reject: d.decisions.reject },
      // ★ 2026-09-30：只把**真正新写入**的算作提升；`refreshed`（正文逐字相同、
      //   只重算元数据）单列 —— 否则"同一条目反复提升"在轮次日志里看起来像持续产出。
      promoted: d.applied && d.applied.promoted && d.applied.promoted.filter((x) => x.ok && !x.refreshed).length,
      refreshed: d.applied && d.applied.promoted && d.applied.promoted.filter((x) => x.ok && x.refreshed).length,
      refused: d.applied && d.applied.refused,
      durationMs: d.durationMs,
    };
    rec.ok = true;
    rec.phase = 'done';
  } catch (e) {
    rec.ok = false;
    rec.error = e && e.message ? e.message : String(e);
    rec.stack = e && e.stack ? String(e.stack).slice(0, 1200) : null;
    deps.error('auto-dream round failed', { reason, err: rec.error, phase: rec.phase });
  }

  rec.durationMs = deps.now() - t0;
  try {
    deps.updateState((s) => {
      s.counters = s.counters || {};
      s.counters.autoRuns = (s.counters.autoRuns || 0) + 1;
      if (rec.ok) {
        s.lastAutoDreamAt = new Date(t0).toISOString();
        s.lastAutoDreamOk = true;
        s.lastAutoDreamError = null;
      } else {
        // ⚠️ 有意**不**推进 lastAutoDreamAt：失败不应被当成"刚梦过"。
        //    限流改由 offsets.lastRunAt + autoRuns 的节流共同承担（见 decide 的
        //    min-interval 用的是 lastAutoDreamAt，故失败后 min-interval 仍会拦住
        //    立刻重试 —— 这是刻意的：失败通常意味着外部服务不可用）。
        s.lastAutoDreamOk = false;
        s.lastAutoDreamError = { at: new Date().toISOString(), phase: rec.phase, error: rec.error };
        s.counters.autoFailures = (s.counters.autoFailures || 0) + 1;
      }
      s.lastAutoDreamReason = reason;
      return s;
    });
  } catch (e) {
    deps.warn('auto-dream: failed to update state', { err: e.message });
  }

  try { deps.appendLog(rec); } catch { /* ignore */ }
  return rec;
}

// ---------------------------------------------------------------- 调度器

/**
 * 调度器：守护进程里唯一的 tick 循环。
 *
 * 生命周期内保证：
 *   · `tick()` 永不抛异常（任何错误都吞掉并记录）——它是 `setInterval` 的回调，
 *     抛出去会变成 uncaughtException 并**杀掉守护进程**。
 *   · 同一时刻最多一轮（`running` 标志）。
 *   · 无论跑不跑，都把**判定理由**写进日志与 state —— 「为什么没做梦」和
 *     「做了什么梦」一样重要。
 */
function createScheduler({ deps: injected = {}, cfgOverride = null } = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const S = { running: false, runningSince: 0, timer: null, started: false, ticks: 0, lastVerdict: null, lastRound: null, skipped: 0, startedAt: null, prime: null };

  function snapshotCfg() { return cfgOverride || deps.loadCfg(); }

  /** 读快照 + 纯门控。**任何异常都降级为"不跑"**（保守方向失败）。 */
  function evaluate({ force = false } = {}) {
    try {
      const cfg = snapshotCfg();
      const offs = deps.readOffsets();
      const pending = deps.readPending(offs.pendingOffset);
      const state = deps.readState();
      const lock = deps.readLock();
      const d = decide({
        cfg, state, pending, lock,
        nowMs: deps.now(), running: S.running, selfPid: deps.selfPid, force,
      });
      return { cfg, offs, pending, state, lock, verdict: d };
    } catch (e) {
      deps.error('auto-dream: evaluate failed', { err: e.message });
      return { error: e.message, verdict: { pass: false, reasons: ['evaluate-failed:' + e.message], detail: {} } };
    }
  }

  /** 推进消费偏移。**失败也要推进**（防重试风暴，见文件头注释 5）。 */
  function consume(pending, extra = {}) {
    try {
      deps.writeOffsets({
        pendingOffset: pending.offset,
        lastRunAt: new Date(deps.now()).toISOString(),
        consumed: (pending.events || []).length,
        ...extra,
      });
    } catch (e) { deps.warn('auto-dream: failed to persist offsets', { err: e.message }); }
  }

  /** 看门狗：只告警；超过 hardTimeoutMs 才强制清零（并承认可能重叠）。 */
  function watchdog(cfg) {
    if (!S.running) return;
    const a = cfg.autoDream || {};
    const held = deps.now() - S.runningSince;
    if (held > (a.hardTimeoutMs || 600000)) {
      deps.error('auto-dream: round exceeded hard timeout, force-clearing single-flight flag', {
        heldMs: held, hardTimeoutMs: a.hardTimeoutMs || 600000,
        note: 'Node 无法取消已发出的异步工作；上一轮可能仍在跑，存在重叠风险',
      });
      S.running = false;
    } else if (held > (a.maxRunMs || 180000)) {
      deps.warn('auto-dream: round still running past maxRunMs (watchdog, not cancel)', { heldMs: held });
    }
  }

  function tick({ force = false } = {}) {
    S.ticks++;
    // ★ 长线：先做轮转检查（`rotatePendingIfNeeded` 自带上限判断，未超限时只花一次 statSync）。
    //   放在判定之前，因为轮转会把消费偏移归零；先转再读，语义才自洽。
    try {
      const r = rotatePendingIfNeeded({ cfg: snapshotCfg(), deps });
      if (r.rotated) S.lastRotate = r;
    } catch { /* 已在函数内消化，绝不影响 tick */ }

    let ev;
    try { ev = evaluate({ force }); } catch (e) {
      deps.error('auto-dream: tick crashed (swallowed)', { err: e.message });
      return { pass: false, reasons: ['tick-crashed'] };
    }
    S.lastVerdict = { at: new Date(deps.now()).toISOString(), ...ev.verdict };

    try { watchdog(ev.cfg || {}); } catch { /* ignore */ }

    if (!ev.verdict.pass) {
      S.skipped++;
      // 只在"有事件但没跑"时记 info，避免安静期刷屏
      if ((ev.pending && ev.pending.events || []).length) {
        deps.info('auto-dream skipped', { reasons: ev.verdict.reasons, events: ev.pending.events.length });
      }
      return ev.verdict;
    }

    // 先推进偏移再开跑：即使进程随后崩掉，也不会把同一批事件反复当触发器。
    consume(ev.pending, { trigger: ev.verdict.detail.triggered });

    S.running = true;
    S.runningSince = deps.now();
    const reason = force ? 'force' : `event:${(ev.verdict.detail.triggered || []).join('+')}`;
    deps.info('auto-dream round starting', { reason, events: ev.pending.events.length, detail: ev.verdict.detail });

    // ★ 刻意不 await：tick 必须立刻返回（它是 setInterval 回调，且 /event 也用它）。
    Promise.resolve()
      .then(() => runRound({ cfg: ev.cfg, deps, reason, force }))
      .then((rec) => {
        S.lastRound = rec;
        S.running = false;
        deps.info('auto-dream round finished', { ok: rec.ok, reason, durationMs: rec.durationMs, error: rec.error });
      })
      .catch((e) => {
        S.running = false;
        S.lastRound = { ok: false, error: e && e.message };
        deps.error('auto-dream: round promise rejected (swallowed)', { err: e && e.message });
      });

    return ev.verdict;
  }

  /**
   * ★ 首次启动"预热"：把**启动之前**就已存在的历史事件记为已消费，但**不触发**。
   *
   * 为什么必须有：`pending-events.jsonl` 是追加文件，装上插件后里面的历史事件
   * （实测有 134 条冒烟测试残留）在首次开启时会被当成"刚发生的事件" →
   * 立刻满足 `minEvents`/`triggerOn` → **意外跑一轮付费自动梦**。
   * 语义上正确的行为是：自动梦只对"它开始值守之后"发生的事件作反应。
   *
   * 判据：偏移文件**从未初始化过**（`updatedAt === null`）。这同时覆盖
   * "偏移文件被删掉"的情形 —— 那也是"重新开始值守"，同样不该吃历史。
   */
  function primeIfNeeded() {
    try {
      const offs = deps.readOffsets();
      if (offs.updatedAt) return { primed: false };
      const p = deps.readPending(0);
      if (!p.size) { deps.writeOffsets({ pendingOffset: 0, primed: true }); return { primed: true, skippedEvents: 0 }; }
      deps.writeOffsets({ pendingOffset: p.size, primed: true, note: '首次值守：历史事件不计为触发' });
      deps.info('auto-dream primed: historical events ignored', { skippedEvents: p.events.length, offset: p.size });
      return { primed: true, skippedEvents: p.events.length };
    } catch (e) {
      deps.warn('auto-dream: prime failed (conservative: will not run until next event)', { err: e.message });
      return { primed: false, error: e.message };
    }
  }

  function start() {
    if (S.started) return S;
    const cfg = snapshotCfg();
    const a = cfg.autoDream || {};
    if (a.enabled !== true) {
      deps.info('auto-dream scheduler not started (disabled)', { hint: 'node cli.cjs config set autoDream.enabled=true' });
      return S;
    }
    S.prime = primeIfNeeded();
    const every = Math.max(10, Number(a.tickSeconds) || 60) * 1000;
    S.started = true;
    S.startedAt = new Date(deps.now()).toISOString();
    S.timer = setInterval(() => tick(), every);
    if (S.timer.unref) S.timer.unref();   // 不阻止进程退出
    deps.info('auto-dream scheduler started', { everySeconds: every / 1000, triggerOn: a.triggerOn, idleMinutes: a.idleMinutes, minIntervalMinutes: a.minIntervalMinutes });
    // 启动即评估一次：守护进程可能是被 hook 冷启动的，此时事件已经躺在文件里了。
    setTimeout(() => { try { tick(); } catch { /* ignore */ } }, 1500).unref?.();
    return S;
  }

  function stop() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    S.started = false;
    return S;
  }

  function status() {
    return {
      started: S.started, startedAt: S.startedAt, running: S.running,
      ticks: S.ticks, skipped: S.skipped, lastVerdict: S.lastVerdict, lastRound: S.lastRound,
      prime: S.prime,
    };
  }

  return { start, stop, tick, status, evaluate, S };
}

module.exports = {
  decide, readPending, runRound, createScheduler, rotatePendingIfNeeded,
  readAutoOffsets, writeAutoOffsets, appendAutoLog,
};
