'use strict';
/**
 * ingest.cjs —— DSH 会话 → 引擎事件的采集（P4 宿主适配层的第二块）。
 *
 * 与 `dsh-session.cjs` 的分工：
 *   · `dsh-session.cjs` 负责「把 DSH 的字节读成 DSH 记录」+「DSH 记录 → 引擎事件形状」；
 *   · 本文件负责「**选哪些会话**、**增量到哪**、**归到哪个项目**、**交给引擎**」。
 *
 * 三条关键设计：
 *   1. **增量按帧数**（`nextFrame`）：DSH 每次 flush 追加一帧，帧数就是天然偏移量
 *      （与 Claude Code 侧的字节偏移同构）。状态存 `raw/dsh-offsets.json`。
 *   2. **项目归属不许猜**：用会话头里的 `cwd` 推导 Claude Code 风格的 slug，
 *      **再核对 `~/.claude/projects/<slug>/memory` 是否存在**；对不上就**跳过并报告**，
 *      绝不猜一个 slug 去污染别人的记忆目录（非 ASCII 路径的推导已知不可靠）。
 *   3. 引擎**不感知 DSH**：本适配层把事件交给引擎的 `pipeline.run({ events })`，
 *      引擎照常走它的提炼/落盘路径 —— "引擎只有一份、宿主各挂薄适配"。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const S = require('./dsh-session.cjs');

/** 引擎（已安装运行时）—— 不复制、只引用 */
function enginePath() {
  const fromEnv = process.env.DREAM_ENGINE_BIN;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.claude', '.dream', 'bin');
}

/** Claude Code 记忆根 */
function claudeProjectsRoot() {
  const fromEnv = process.env.DREAM_CLAUDE_HOME;
  if (fromEnv && fromEnv.trim()) return path.join(path.resolve(fromEnv.trim()), 'projects');
  return path.join(os.homedir(), '.claude', 'projects');
}

/** 增量状态文件（放在引擎的 DREAM_HOME 下，与 CC 侧的 offsets.json 并列） */
function offsetsFile() {
  const fromEnv = process.env.DREAM_HOME;
  const home = (fromEnv && fromEnv.trim()) ? path.resolve(fromEnv.trim())
    : path.join(os.homedir(), '.claude', '.dream');
  return path.join(home, 'raw', 'dsh-offsets.json');
}

function readOffsets() {
  try { return JSON.parse(fs.readFileSync(offsetsFile(), 'utf8')); } catch { return {}; }
}
function writeOffsets(o) {
  const f = offsetsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8');
}

/**
 * 只读文件头部若干字节，取出第一条带 `cwd` 的记录。
 * 用 fd 限定读取范围 —— 转录单文件可达 12 MB，不能整文件读入。
 */
function readFirstCwd(file, maxBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && typeof r.cwd === 'string' && r.cwd) return r.cwd; }
      catch { /* 截断的半行：继续找下一条 */ }
    }
  } catch { /* 打不开就放弃这个文件 */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
  return null;
}

/** 路径归一化（Windows 大小写不敏感、分隔符不统一） */
function normPath(p) {
  return String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * ★ 自动 slug 索引：**从 CC 转录自带的 `cwd` 字段**建立 `真实路径 → 项目 slug` 映射。
 *
 * 为什么需要它：非 ASCII 路径的 slug **推导不可靠**（`F:\Demo` 在 CC 里是 `F--Demo`，
 * 推导只能得到 `F--Demo`）—— 而推导错就会"往别人的记忆目录写东西"，所以适配器选择
 * **拒绝猜测**，代价是这类工作区的会话全被跳过（实测 86/114 = 76%）。
 *
 * 但 CC 转录**每条记录都带 `cwd` 真实路径** —— 那是权威依据，不是猜测。
 * 每个项目只读一条转录的首 64 KB，成本极低，且**对任何路径都自动正确**。
 */
function buildSlugIndex({ maxProjects = 500 } = {}) {
  const root = claudeProjectsRoot();
  const index = new Map();       // normPath(cwd) → slug
  let slugs = [];
  try { slugs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return index; }

  for (const slug of slugs.slice(0, maxProjects)) {
    const dir = path.join(root, slug);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    // 取几个候选文件逐个试（有的转录可能缺 cwd）
    for (const f of files.slice(0, 3)) {
      const cwd = readFirstCwd(path.join(dir, f));
      if (cwd) { if (!index.has(normPath(cwd))) index.set(normPath(cwd), slug); break; }
    }
  }
  return index;
}

/**
 * 把 cwd 解析成**引擎认识的项目 slug**。
 *
 * 三层，逐层降级，**任何一层都不猜**：
 *   1. 显式映射 `projectMap[cwd]`
 *   2. **自动索引**（转录 `cwd` 字段 → slug）—— 权威依据，覆盖非 ASCII 路径
 *   3. 字符串推导（仅对 ASCII 路径可靠）
 * 每层都要求 `~/.claude/projects/<slug>/memory` 真实存在，否则判未映射。
 * @returns {{slug:string|null, mapped:boolean, via?:string, reason?:string}}
 */
function resolveProject(cwd, { projectMap = {}, slugIndex = null } = {}) {
  if (!cwd) return { slug: null, mapped: false, reason: 'no-cwd' };
  const memOk = (slug) => fs.existsSync(path.join(claudeProjectsRoot(), slug, 'memory'));

  // 1) 显式映射优先
  if (projectMap[cwd]) {
    const slug = projectMap[cwd];
    return memOk(slug)
      ? { slug, mapped: true, via: 'explicit-map' }
      : { slug: null, mapped: false, reason: `explicit-map 指向的目录不存在：${slug}` };
  }
  // 2) 自动索引（转录 cwd 字段）
  if (slugIndex && slugIndex.size) {
    const hit = slugIndex.get(normPath(cwd));
    if (hit) {
      return memOk(hit)
        ? { slug: hit, mapped: true, via: 'cwd-index' }
        : { slug: null, mapped: false, reason: `cwd 索引命中 ${hit} 但其 memory 目录不存在` };
    }
  }
  // 3) 字符串推导（ASCII 可靠；非 ASCII 已知不可靠）
  const derived = S.projectSlugFromPath(cwd);
  if (!derived) return { slug: null, mapped: false, reason: 'derive-failed' };
  if (!memOk(derived)) {
    return { slug: null, mapped: false, reason: `推导出的 slug 无对应记忆目录：${derived}` };
  }
  return { slug: derived, mapped: true, via: 'derived' };
}

/**
 * 采集 DSH 会话 → 引擎事件。
 * @param {{sinceMs?:number, force?:boolean, projectMap?:object, maxFiles?:number}} [opts]
 */
function collect({ sinceMs = null, force = false, projectMap = {}, maxFiles = 500, useIndex = true } = {}) {
  const offsets = force ? {} : readOffsets();
  const sessions = S.listSessions();
  // ★ 自动 slug 索引：从 CC 转录的 cwd 字段建立"真实路径 → slug"映射。
  //   它让非 ASCII 工作区（如 F:\Demo → F--Demo）**无需人工映射**即可正确归属。
  const slugIndex = useIndex ? buildSlugIndex() : new Map();
  const events = [];
  const perFile = [];
  const skipped = [];
  let files = 0;

  sessions.sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
  for (const s of sessions) {
    if (files >= maxFiles) break;
    if (sinceMs !== null && (s.mtimeMs || 0) < sinceMs) continue;
    const prev = offsets[s.path] || { nextFrame: 0 };
    let r;
    try { r = S.readSession(s.path, { fromFrame: prev.nextFrame }); }
    catch (e) { skipped.push({ path: s.path, reason: `读取失败：${e.message}` }); continue; }

    // 会话头只在第一次需要（`cwd` 决定项目归属）
    const header = r.header || S.readHeader(s.path);
    const cwd = header && header.cwd;
    const proj = resolveProject(cwd, { projectMap, slugIndex });
    if (!proj.mapped) {
      skipped.push({ path: s.path, cwd: cwd || null, reason: proj.reason });
      // ★ **不推进** offsets（写 0）—— 语义是"本次未消费"。
      //   曾经的实现把 nextFrame 推进到末尾，后果是：**后来修好了归属映射，
      //   这些会话也永远读不出内容了**（fromFrame 已在末尾 ⇒ 0 新帧）。
      //   实测踩到：加了自动索引后，先前被跳过的 86 个会话仍产出 0 事件。
      //   代价是未被归属的会话每轮会重读一遍（由 maxFiles 兜底），换取**可恢复**。
      offsets[s.path] = { nextFrame: 0, skipped: true, reason: proj.reason, cwd: cwd || null, skippedAt: new Date().toISOString() };
      continue;
    }

    files++;
    const sid = (header && header.id) || s.sessionId;
    for (const ev of r.events) events.push({ ...ev, sessionId: sid, project: proj.slug });
    offsets[s.path] = { nextFrame: r.nextFrame, cwd, project: proj.slug, via: proj.via };
    perFile.push({
      path: s.path, project: proj.slug, via: proj.via,
      newFrames: r.frames.consumed, events: r.events.length,
      failedFrames: r.frames.failed, records: r.records,
    });
  }

  writeOffsets(offsets);
  return {
    events, perFile, skipped,
    stats: {
      sessions: sessions.length, filesIngested: files,
      events: events.length, skipped: skipped.length,
      slugIndexEntries: slugIndex.size,
      framesConsumed: perFile.reduce((a, x) => a + x.newFrames, 0),
      framesFailed: perFile.reduce((a, x) => a + x.failedFrames, 0),
    },
  };
}

/**
 * 采集并交给**引擎的** pipeline 提炼（dryRun 时不落盘）。
 * 引擎通过 `pipeline.run({ events })` 接收 —— 引擎不需要知道 DSH 的存在。
 */
function ingestIntoEngine({ dryRun = false, project = null, force = false, projectMap = {} } = {}) {
  const col = collect({ force, projectMap });
  const engine = enginePath();
  const pipelineMod = require(path.join(engine, 'pipeline.cjs'));
  const r = pipelineMod.run({
    project,
    dryRun,
    events: col.events,
    hostSource: 'dsh',
    ignoreGate: true,      // 由调用方（hook / 工具）决定节奏
    limit: 8,
  });
  return { collect: col, engine: r };
}

module.exports = {
  collect, ingestIntoEngine, resolveProject, buildSlugIndex, readFirstCwd, normPath,
  offsetsFile, enginePath, claudeProjectsRoot,
};
