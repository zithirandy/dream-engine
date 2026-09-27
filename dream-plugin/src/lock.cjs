'use strict';
/**
 * lock.cjs —— 单实例 PID 锁（对应 V2 §6.4 第 5 道门控）。
 * 规则：内容为持有者 PID；mtime 视为"上次整合时间"；持有超过 TTL 视为过期（防 PID 复用）。
 * 失败时回滚 mtime，让下一次尝试不受影响。
 */
const fs = require('fs');
const pathsMod = require('./paths.cjs');

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 小时

function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // 存在但无权限 => 视为存活
  }
}

function readLock() {
  const p = pathsMod.paths();
  try {
    const raw = fs.readFileSync(p.lock, 'utf8').trim();
    const st = fs.statSync(p.lock);
    const pid = Number.parseInt(raw, 10);
    return {
      exists: true,
      pid: Number.isFinite(pid) ? pid : null,
      mtimeMs: st.mtimeMs,
      ageMs: Date.now() - st.mtimeMs,
      alive: Number.isFinite(pid) ? pidAlive(pid) : false,
    };
  } catch {
    return { exists: false, pid: null, mtimeMs: null, ageMs: null, alive: false };
  }
}

/**
 * 尝试获取锁。
 * @returns {{ok:boolean, reason?:string, holder?:object}}
 */
function acquire({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const p = pathsMod.paths();
  const cur = readLock();

  if (cur.exists) {
    const stale = cur.ageMs > ttlMs;
    if (!stale && cur.alive) {
      return { ok: false, reason: 'held-by-live-pid', holder: cur };
    }
    // 过期或持有者已死 => 回收，但先记录
    if (!stale && !cur.alive) {
      // PID 已死但锁未过期：仍回收（崩溃恢复）
    }
  }

  const prevMtime = cur.exists ? cur.mtimeMs : null;
  try {
    fs.mkdirSync(p.home, { recursive: true });
    fs.writeFileSync(p.lock, String(process.pid), 'utf8');
    return { ok: true, reclaimed: cur.exists, prevMtime };
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: e.message };
  }
}

/** 释放锁（仅当自己是持有者） */
function release() {
  const p = pathsMod.paths();
  const cur = readLock();
  if (cur.exists && cur.pid !== process.pid) return false;
  try { fs.unlinkSync(p.lock); return true; } catch { return false; }
}

/** 失败回滚：把 mtime 恢复为获取前的值 */
function rollbackMtime(prevMtime) {
  if (!prevMtime) return false;
  const p = pathsMod.paths();
  try {
    const t = new Date(prevMtime);
    fs.utimesSync(p.lock, t, t);
    return true;
  } catch { return false; }
}

/** 记录一次成功整合：刷新锁的 mtime（= 上次整合时间） */
function recordConsolidation() {
  const p = pathsMod.paths();
  const now = new Date();
  try {
    if (!fs.existsSync(p.lock)) fs.writeFileSync(p.lock, String(process.pid), 'utf8');
    fs.utimesSync(p.lock, now, now);
    return true;
  } catch { return false; }
}

module.exports = { DEFAULT_TTL_MS, readLock, acquire, release, rollbackMtime, recordConsolidation, pidAlive };
