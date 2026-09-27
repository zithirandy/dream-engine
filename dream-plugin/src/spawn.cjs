'use strict';
/**
 * spawn.cjs —— 探活 + 拉起常驻引擎（对应 V2 §6.2）。
 *
 * 核验快报残余注意项 #3：spawn 必须带 windowsHide: true，
 * 否则 Windows 上每次 hook 拉起都会闪一个控制台黑框。
 *
 * 拉起节流：同一分钟内最多 spawn 一次（state.lastSpawnAt），防 hook 风暴。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pathsMod = require('./paths.cjs');
const stateMod = require('./state.cjs');
const log = require('./log.cjs');

const SPAWN_THROTTLE_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 250;
const WAIT_AFTER_SPAWN_MS = 3000;

function pingHttp(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = require('http').get(
        { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try { done({ ok: res.statusCode === 200, body: JSON.parse(body) }); }
            catch { done({ ok: res.statusCode === 200, body: null }); }
          });
        },
      );
    } catch { return done({ ok: false, error: 'http-error' }); }
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, error: e.code || e.message }));
  });
}

/** 引擎脚本路径：安装态优先，其次开发态 */
function daemonScript() {
  const p = pathsMod.paths();
  const installed = path.join(p.bin, 'daemon.cjs');
  if (fs.existsSync(installed)) return installed;
  const dev = path.resolve(__dirname, 'daemon.cjs');
  if (fs.existsSync(dev)) return dev;
  return null;
}

/**
 * 确保引擎在跑。返回 {ok, spawned, reason}
 * 绝不抛异常——调用方是 hook。
 */
async function ensureRunning({ port, waitMs = WAIT_AFTER_SPAWN_MS } = {}) {
  const p = pathsMod.paths();
  const cfgPort = port || require('./config.cjs').load().config.server.port;

  const first = await pingHttp(cfgPort);
  if (first.ok) return { ok: true, spawned: false, reason: 'already-running', health: first.body };

  // 节流检查
  const st = stateMod.read();
  const last = st.lastSpawnAt ? Date.parse(st.lastSpawnAt) : 0;
  const since = Date.now() - last;
  if (since < SPAWN_THROTTLE_MS) {
    return { ok: false, spawned: false, reason: 'throttled', retryInMs: SPAWN_THROTTLE_MS - since };
  }

  const script = daemonScript();
  if (!script) return { ok: false, spawned: false, reason: 'daemon-script-not-found' };

  stateMod.update((s) => { s.lastSpawnAt = new Date().toISOString(); return s; });

  try {
    const child = spawn(process.execPath, [script, 'run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,          // ★ 残余注意项 #3
      cwd: p.home,
      env: { ...process.env, DREAM_HOME: p.home },
    });
    child.unref();
    log.info('daemon spawned', { pid: child.pid, script, port: cfgPort });
  } catch (e) {
    log.error('daemon spawn failed', { err: e.message });
    return { ok: false, spawned: false, reason: 'spawn-failed', error: e.message };
  }

  // 轮询等待健康
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const probe = await pingHttp(cfgPort, 400);
    if (probe.ok) return { ok: true, spawned: true, reason: 'spawned-and-healthy', health: probe.body };
  }
  return { ok: false, spawned: true, reason: 'spawned-but-unhealthy' };
}

module.exports = { pingHttp, ensureRunning, daemonScript, SPAWN_THROTTLE_MS };
