'use strict';
/**
 * log.cjs —— 日志：运行日志（按日 JSONL）+ 引擎自身 daemon.log（按大小滚动）。
 * 对应 V2 §4.6 / §6.7。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');

const DAEMON_LOG_MAX_BYTES = 2 * 1024 * 1024; // 2MB 滚动

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

/** 引擎自身日志：追加到 daemon.log，超限则滚动为 daemon.log.1 */
function daemon(level, msg, extra) {
  const p = pathsMod.paths();
  try {
    ensureDir(p.logs);
    try {
      const st = fs.statSync(p.daemonLog);
      if (st.size > DAEMON_LOG_MAX_BYTES) fs.renameSync(p.daemonLog, p.daemonLog + '.1');
    } catch { /* 不存在则忽略 */ }
    const line = JSON.stringify({ ts: nowIso(), level, msg, ...(extra ? { extra } : {}) });
    fs.appendFileSync(p.daemonLog, line + '\n', 'utf8');
  } catch { /* 日志失败绝不影响主流程 */ }
}

const info = (m, e) => daemon('info', m, e);
const warn = (m, e) => daemon('warn', m, e);
const error = (m, e) => daemon('error', m, e);

/** 每个本地日一个文件：logs/YYYY/MM/YYYY-MM-DD.jsonl */
function runLogPath(date = new Date()) {
  const p = pathsMod.paths();
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(p.logs, y, m, `${y}-${m}-${d}.jsonl`);
}

/** 追加一条运行记录 */
function run(record) {
  const p = pathsMod.paths();
  try {
    const file = runLogPath();
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify({ ts: nowIso(), ...record }) + '\n', 'utf8');
    return file;
  } catch (e) {
    error('run log append failed', { err: e.message, home: p.home });
    return null;
  }
}

/** 追加一条账本记录（ledger.jsonl，全量保留） */
function ledger(record) {
  const p = pathsMod.paths();
  try {
    ensureDir(p.home);
    fs.appendFileSync(p.ledger, JSON.stringify({ ts: nowIso(), ...record }) + '\n', 'utf8');
    return true;
  } catch (e) {
    error('ledger append failed', { err: e.message });
    return false;
  }
}

/**
 * 保留策略：删除超过 retentionDays 的运行日志目录/文件。
 * P0 只实现按日文件删除，不做目录清理。
 */
function prune(retentionDays = 90) {
  const p = pathsMod.paths();
  const cutoff = Date.now() - retentionDays * 86400000;
  let removed = 0;
  try {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.jsonl')) continue;
        try { if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed++; } } catch { /* ignore */ }
      }
    };
    if (fs.existsSync(p.logs)) walk(p.logs);
  } catch { /* ignore */ }
  return removed;
}

module.exports = { daemon, info, warn, error, run, ledger, runLogPath, prune, ensureDir, nowIso, DAEMON_LOG_MAX_BYTES };
