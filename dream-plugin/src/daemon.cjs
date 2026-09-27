'use strict';
/**
 * daemon.cjs —— 常驻引擎入口（对应 V2 §1.1「引擎层」）。
 *
 * P0 职责：拿锁 → 确保 token → 起 HTTP 服务 → 常驻 → 优雅退出。
 * P5 新增：**自动梦调度器**（`auto.cjs`）——`/event` 的真正消费端。
 * 不含任何 LLM 客户端（V2 决策 6）。
 *
 * 用法：node daemon.cjs run        （正常启动；已被锁占用则退出）
 *      node daemon.cjs run --force （忽略锁，用于清理孤儿）
 */
const pathsMod = require('./paths.cjs');
const lockMod = require('./lock.cjs');
const tokenMod = require('./token.cjs');
const serverMod = require('./server.cjs');
const stateMod = require('./state.cjs');
const log = require('./log.cjs');
const configMod = require('./config.cjs');
const autoMod = require('./auto.cjs');

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');

  const p = pathsMod.paths();
  const { config, source } = configMod.load();

  log.ensureDir(p.home);
  log.ensureDir(p.logs);

  // --- 锁 ---
  const got = lockMod.acquire();
  if (!got.ok && !force) {
    log.warn('daemon not started: lock held', got);
    // 已有实例在跑是正常情况，退出码 0
    process.exit(0);
  }
  if (!got.ok && force) log.warn('daemon starting with --force despite lock', got);

  // --- token ---
  tokenMod.ensureToken();

  // --- state 落盘（首次运行会创建） ---
  const st = stateMod.read();
  stateMod.write(st);

  // --- HTTP ---
  // ★ P5：调度器先建好再交给 server —— `/event` 需要它当场给出判定。
  //   注意 `createScheduler` 本身**不启动**任何定时器；是否启动由 config 决定。
  const scheduler = autoMod.createScheduler();

  const onShutdown = () => shutdown(0);
  const { server, port } = serverMod.createServer({ onShutdown, scheduler });

  server.on('error', (e) => {
    log.error('server error', { err: e.message, code: e.code });
    // 端口占用：可能是另一个实例，安静退出
    if (e.code === 'EADDRINUSE') shutdown(0);
    else shutdown(1);
  });

  server.listen(port, config.server.host, () => {
    log.info('daemon listening', { host: config.server.host, port, pid: process.pid, configSource: source });
    // 监听成功后再启动调度器：端口都起不来的实例不该开始做梦
    try { scheduler.start(); } catch (e) {
      log.error('auto-dream scheduler failed to start', { err: e.message });
    }
  });

  let stopping = false;
  function shutdown(code) {
    if (stopping) return;
    stopping = true;
    log.info('daemon shutting down', { code });
    try { scheduler.stop(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { lockMod.release(); } catch { /* ignore */ }
    setTimeout(() => process.exit(code), 50);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', (e) => { log.error('uncaughtException', { err: e.message, stack: e.stack }); shutdown(1); });
  process.on('unhandledRejection', (e) => { log.error('unhandledRejection', { err: String(e) }); });
}

if (require.main === module) main();
module.exports = { main };
