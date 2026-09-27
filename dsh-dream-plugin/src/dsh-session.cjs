'use strict';
/**
 * dsh-session.cjs —— DSH 会话转录适配器（P4 宿主适配层的**已验证部分**）。
 *
 * 本文件的所有结论均来自**对真实 DSH 会话文件的实测**（DSH 0.1.5-rc.1 / Node 24.18），
 * 不是推测。实测记录见同目录 `../README.md`。
 *
 * 三个关键事实：
 *   1. DSH **确实落盘**会话：`~/.dsh/sessions/<slug>/<sessionId>/session.v3.jsonl.zstd`
 *   2. 文件是 **JSONL 但被 zstd 压缩**，且**多帧拼接**（每次 flush 追加一帧）。
 *      ★ **只调一次 zstd API 只会解出第一帧** —— 实测某 5.9 MB 文件：
 *        单次调用得 187 B（仅会话头），**逐帧解压得 19.2 MB / 4504 条记录**。
 *        直接读会「静默只拿到会话头」，是最坏的一类数据丢失。
 *   3. 记录里带 **`cwd` 真实路径**，比 slug 字面匹配可靠。
 *
 * 零依赖：Node 24 自带 `zlib.zstdDecompressSync`。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** DSH 根目录（可用 DSH_HOME 覆盖，便于测试隔离） */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.dsh');
}
function sessionsRoot() { return path.join(dshHome(), 'sessions'); }

/** 找出所有 zstd 帧的起始偏移 */
function frameOffsets(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const at = buf.indexOf(ZSTD_MAGIC, i);
    if (at < 0) break;
    out.push(at);
    i = at + 4;
  }
  return out;
}

/**
 * **逐帧**解压（读取 DSH 会话的正确方式）。
 * 单帧失败可容忍：帧之间可能夹带极小的非帧尾部。
 * @returns {{text:string, frames:number, ok:number, failed:number}}
 */
function decompressFrames(buf) {
  const offs = frameOffsets(buf);
  const parts = [];
  let ok = 0; let failed = 0;
  for (let k = 0; k < offs.length; k++) {
    const start = offs[k];
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')); ok++; }
    catch { failed++; }
  }
  return { text: parts.join(''), frames: offs.length, ok, failed };
}

/** 枚举会话（含会话头里的 cwd / createdAt） */
function listSessions() {
  const root = sessionsRoot();
  const out = [];
  let slugs = [];
  try { slugs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const slug of slugs) {
    const slugDir = path.join(root, slug);
    let ids = [];
    try { ids = fs.readdirSync(slugDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    for (const id of ids) {
      const dir = path.join(slugDir, id);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.zstd')); } catch { continue; }
      for (const f of files) {
        const full = path.join(dir, f);
        let st = null;
        try { st = fs.statSync(full); } catch { /* ignore */ }
        out.push({
          path: full, slug, sessionId: id, file: f,
          size: st ? st.size : null, mtimeMs: st ? st.mtimeMs : null,
        });
      }
    }
  }
  return out;
}

/** 从文件里取会话头（第一条 `type:"session"` 记录）—— 只在需要元信息时用，代价低 */
function readHeader(file) {
  try {
    const buf = fs.readFileSync(file);
    const offs = frameOffsets(buf);
    if (!offs.length) return null;
    const end = offs.length > 1 ? offs[1] : buf.length;
    const txt = zlib.zstdDecompressSync(buf.subarray(offs[0], end)).toString('utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.type === 'session') return r;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 推导项目 slug。
 *
 * ⚠️ **不一定可靠**：Claude Code 的 slug 规则会把非 ASCII 路径压成难以还原的形式
 *    （实测 `F:\Demo\dream-src` → `F--Demo--dream-src`，`Demo` 已丢失），
 *    故**不能**只靠字符串推导。本函数先按规则推导，再由调用方核对目录是否存在；
 *    对不上就退回 `null`，让调用方决定（绝不猜一个错的 slug 去写别人的记忆目录）。
 */
function projectSlugFromPath(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  // Claude Code 规则：`:` 与每个路径分隔符**各自**替换为一个 `-`（**不合并连续字符**）。
  //   ★ 实测：`[:\\/]+`（合并）会把 `F:\DemoApi` 变成 `F-DemoApi`，
  //     而正确结果是 `F--DemoApi` —— 两处 `-` 分别来自 `:` 与 `\`。
  //   `&` 也映射为 `-`（实测 `…\A&B` → `…-A-B`）。
  const s = cwd.replace(/[:\\/&]/g, '-');
  return s.replace(/^-+/, '').replace(/-+$/, '') || null;
}

/**
 * DSH 记录 → 引擎事件（与 `dream-plugin/src/transcripts.cjs` 的 `normalizeLine` 同构）。
 *
 * 引擎期望的事件形状：`{sessionId, project, ts, role, kind, text, toolName?, filePath?}`
 * 其中 `kind ∈ {text, tool_use, tool_result, error}`。
 *
 * @returns {Array<{role,kind,text,toolName?,filePath?}>} 不含 sessionId/project（由调用方补）
 */
function recordToEvents(rec) {
  const events = [];
  const d = rec && rec.data;
  if (!d) return events;
  const ts = rec.time ? new Date(rec.time).toISOString() : null;

  const pushContent = (role, content, kindWhenTool) => {
    if (typeof content === 'string') { if (content.trim()) events.push({ role, kind: 'text', text: content, ts }); return; }
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        events.push({ role, kind: 'text', text: c.text, ts });
      } else if (kindWhenTool) {
        // 工具结果：保留为 tool_result（与 Claude Code 侧一致，便于同一条提炼规则复用）
        events.push({ role, kind: 'tool_result', text: String(c.text || c.content || JSON.stringify(c)).slice(0, 200000), ts });
      }
    }
  };

  switch (rec.type) {
    case 'user/message':
      pushContent('user', d.content);
      break;
    case 'assistant/message':
      // 只取 `text`；`reasoning` 是模型的思维链，不进候选（与 CC 侧仅取 text 一致）
      pushContent('assistant', d.message && d.message.content);
      break;
    case 'tool/call': {
      // ⚠️ DSH 的 `arguments` 是**字符串化的 JSON**（实测），故原样作 text
      const text = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments || {});
      events.push({ role: 'assistant', kind: 'tool_use', toolName: d.name || null, text, filePath: null, ts });
      break;
    }
    case 'tool/result': {
      const msg = d.message || {};
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          events.push({
            role: 'user', kind: 'tool_result', ts,
            text: String((c && (c.text || c.content)) || JSON.stringify(c)).slice(0, 200000),
          });
        }
      } else if (typeof content === 'string' && content.trim()) {
        events.push({ role: 'user', kind: 'tool_result', text: content, ts });
      }
      break;
    }
    default:
      // turn/* step/* compaction/* goal/change todo/write 等：**不进候选**
      // （它们是流程/元数据，不是"值得记住的判断"——与 CC 侧忽略非消息记录同构）
      break;
  }
  return events;
}

/**
 * 读一个 DSH 会话文件 → 引擎事件序列。
 *
 * ★ `fromFrame`：**增量读取**。DSH 每次 flush 追加一帧，故"已消费的帧数"就是天然的
 *   偏移量（与 Claude Code 侧的字节偏移同构）。`nextFrame` 可持久化，下次只解新帧，
 *   避免每次全量重读（实测最大会话 5.9 MB / 2528 帧）。
 *
 * @param {string} file
 * @param {{raw?:boolean, fromFrame?:number}} [opts]
 * @returns {{header, records, events, frames:{total,ok,failed,consumed}, nextFrame, compactedSeqs}}
 */
function readSession(file, { raw = false, fromFrame = 0 } = {}) {
  const buf = fs.readFileSync(file);
  const offs = frameOffsets(buf);
  const start = Math.max(0, Math.min(fromFrame, offs.length));
  const events = [];
  const compactedSeqs = new Set();
  let header = null;
  let records = 0;
  let ok = 0; let failed = 0;
  const parts = [];
  for (let k = start; k < offs.length; k++) {
    const s = offs[k];
    const e = k + 1 < offs.length ? offs[k + 1] : buf.length;
    let txt;
    try { txt = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); ok++; }
    catch { failed++; continue; }   // 不完整的尾帧：跳过（下次会作为新帧再出现）
    parts.push(txt);
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      records++;
      if (rec.type === 'session' && !header) { header = rec; continue; }
      if (rec.type === 'compaction/prune' && rec.data && Array.isArray(rec.data.shadowedSeqs)) {
        for (const x of rec.data.shadowedSeqs) compactedSeqs.add(x);
      }
      events.push(...recordToEvents(rec));
    }
  }
  return {
    header, records, events, compactedSeqs,
    frames: { total: offs.length, ok, failed, from: start, consumed: offs.length - start },
    nextFrame: offs.length,   // 下次从这里继续（注意：只有成功解出的帧才算消费）
    ...(raw ? { rawText: parts.join('') } : {}),
  };
}

module.exports = {
  dshHome, sessionsRoot, frameOffsets, decompressFrames,
  listSessions, readHeader, readSession, recordToEvents, projectSlugFromPath,
};
