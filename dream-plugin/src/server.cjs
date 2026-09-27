'use strict';
/**
 * server.cjs —— 本地 HTTP 服务（对应 V2 §6.2 / §7.1 的 P0 子集）。
 *
 * 安全三件套：
 *   1) 只绑 127.0.0.1（绝不 0.0.0.0）
 *   2) 校验 Host 头，只接受 127.0.0.1 / localhost / [::1]（防 DNS rebinding）
 *   3) 非 /health 请求必须带 X-Dream-Token
 *   4) 不返回任何 CORS 头（浏览器跨源读不到响应）
 *
 * P0 路由：GET /health、GET /status、POST /event、POST /shutdown
 * P1+ 路由：/run、/prepare、/validate、/apply、/rollback
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const stateMod = require('./state.cjs');
const lockMod = require('./lock.cjs');
const tokenMod = require('./token.cjs');
const log = require('./log.cjs');

const MAX_BODY = 1024 * 1024; // 1MB
const STARTED_AT = Date.now();
const VERSION = require('../package.json').version;

function hostAllowed(hostHeader, port) {
  if (!hostHeader) return false;
  const h = hostHeader.toLowerCase().trim();
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  // 也接受不带端口的裸主机名（部分客户端会省略）
  const bare = ['127.0.0.1', 'localhost', '[::1]'];
  return allowed.includes(h) || bare.includes(h);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer({ onShutdown, scheduler = null } = {}) {
  const { config } = configMod.load();
  const port = config.server.port;

  const server = http.createServer(async (req, res) => {
    // --- 安全门 1：Host 头 ---
    if (!hostAllowed(req.headers.host, port)) {
      log.warn('rejected: bad host header', { host: req.headers.host, url: req.url });
      return send(res, 403, { ok: false, error: 'bad-host' });
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const route = `${req.method} ${url.pathname}`;

    // --- 免鉴权路由 ---
    if (route === 'GET /health') {
      return send(res, 200, {
        ok: true,
        pid: process.pid,
        version: VERSION,
        uptimeMs: Date.now() - STARTED_AT,
        home: pathsMod.paths().home,
      });
    }

    // --- 安全门 2：token ---
    if (config.server.requireToken) {
      const supplied = req.headers['x-dream-token'];
      if (!tokenMod.matches(supplied)) {
        log.warn('rejected: bad token', { route, host: req.headers.host });
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }
    }

    try {
      if (route === 'GET /status') {
        const cfg = configMod.load();
        return send(res, 200, {
          ok: true,
          pid: process.pid,
          version: VERSION,
          uptimeMs: Date.now() - STARTED_AT,
          home: pathsMod.paths().home,
          configSource: cfg.source,
          config: {
            enabled: cfg.config.enabled,
            minHours: cfg.config.minHours,
            egress: cfg.config.egress,
            port: cfg.config.server.port,
            // ★ P5：自动梦的关键闸值一并暴露，便于 `/dream-status` 直接汇报
            autoDream: {
              enabled: !!(cfg.config.autoDream && cfg.config.autoDream.enabled),
              triggerOn: (cfg.config.autoDream && cfg.config.autoDream.triggerOn) || [],
              idleMinutes: cfg.config.autoDream && cfg.config.autoDream.idleMinutes,
              minIntervalMinutes: cfg.config.autoDream && cfg.config.autoDream.minIntervalMinutes,
              dryRun: !!(cfg.config.autoDream && cfg.config.autoDream.dryRun),
            },
          },
          // ★ P5：调度器实时状态（跑没跑、为什么、上一次结果）
          autoDream: scheduler ? scheduler.status() : { available: false, reason: 'no-scheduler-in-this-process' },
          lock: lockMod.readLock(),
          state: stateMod.read(),
        });
      }

      if (route === 'POST /event') {
        const raw = await readBody(req);
        let evt;
        try { evt = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
        const record = {
          kind: evt.kind || 'unknown',
          host: evt.host || 'claude-code',
          project: evt.project || null,
          sessionId: evt.sessionId || null,
          ts: new Date().toISOString(),
          // ★ DSH 落地（D-P1）：把「项目归属是谁给的」落盘，供审计。
          //
          //   为什么必须落盘：`nudge.cjs` 会带上 `raw.projectSource`（`host-provided` |
          //   `cc-derived`），但此前 `/event` **重建** record 时把它丢了 ⇒ 该字段是**惰性的**。
          //   结果是："项目正确"无法区分"宿主覆盖生效"与"引擎兜底碰巧推对" ——
          //   而这两件事的可靠性完全不同（后者对所有路径都会**发明**一个 slug）。
          //
          //   ⚠️ **白名单**，不落任意 `raw`：载荷来自本地 hook，但仍应按不可信输入处理，
          //      避免有人塞一个大对象把事件文件撑爆（该文件还有 2MB 轮转上限）。
          raw: {
            hook_event_name: (evt.raw && evt.raw.hook_event_name) || null,
            projectSource: (evt.raw && evt.raw.projectSource) || null,
          },
        };
        // ★ P5：事件不再"只落盘"。追加后**立刻做一次廉价判定**并把
        //   判定结果回给宿主 —— 这样"为什么没做梦"对操作员是可见的。
        //   `scheduler.tick()` **不会**等待一轮跑完（它刻意不 await，见 auto.cjs），
        //   所以这里仍然是毫秒级返回，绝不拖慢宿主会话。
        log.ensureDir(pathsMod.paths().raw);
        require('fs').appendFileSync(pathsMod.paths().pendingEvents, JSON.stringify(record) + '\n', 'utf8');
        log.info('event recorded', record);

        let auto = { available: false };
        if (scheduler) {
          try {
            const v = scheduler.tick();
            auto = { available: true, pass: !!v.pass, reasons: v.reasons, detail: v.detail };
          } catch (e) {
            // 判定失败绝不能让事件上报失败 —— 事件已经落盘了
            log.warn('event recorded but auto-dream verdict failed', { err: e.message });
            auto = { available: true, error: e.message };
          }
        }
        return send(res, 200, { ok: true, recorded: record, processed: true, phase: 'P5', autoDream: auto });
      }

      if (route === 'POST /shutdown') {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* allow empty */ }
        if (body.confirm !== true) return send(res, 400, { ok: false, error: 'confirm-required' });
        send(res, 200, { ok: true, shuttingDown: true });
        log.info('shutdown requested via http');
        setImmediate(() => { try { onShutdown && onShutdown(); } catch { /* ignore */ } });
        return;
      }

      // ---------------- P3 手动梦端点（V2 §7.1）----------------
      // 写操作一律要求 token（上面的安全门 2）+ 显式 confirm。
      if (route === 'POST /prepare') {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
        const r = require('./inbox.cjs').writeInbox({ mode: body.mode || 'manual' });
        return send(res, 200, { ok: true, inbox: r.file, stats: r.stats, findings: r.findings });
      }

      if (route === 'POST /validate') {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
        // 既接受内联提案，也接受 proposals/ 下的文件名
        let prop = body.proposal;
        if (!prop && body.file) {
          const f = path.join(pathsMod.paths().proposals, path.basename(body.file));
          if (!fs.existsSync(f)) return send(res, 404, { ok: false, error: 'proposal-not-found', file: body.file });
          try { prop = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return send(res, 400, { ok: false, error: 'invalid-json' }); }
        }
        if (!prop) return send(res, 400, { ok: false, error: 'need-proposal-or-file' });
        return send(res, 200, require('./proposal.cjs').validateProposal(prop));
      }

      if (route === 'POST /apply') {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
        if (body.confirm !== true) return send(res, 400, { ok: false, error: 'confirm-required' });
        let prop = body.proposal;
        if (!prop && body.file) {
          const f = path.join(pathsMod.paths().proposals, path.basename(body.file));
          if (!fs.existsSync(f)) return send(res, 404, { ok: false, error: 'proposal-not-found', file: body.file });
          try { prop = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return send(res, 400, { ok: false, error: 'invalid-json' }); }
        }
        if (!prop) return send(res, 400, { ok: false, error: 'need-proposal-or-file' });
        const v = require('./proposal.cjs').validateProposal(prop);
        if (!v.ok) return send(res, 400, { ok: false, error: 'validation-failed', errors: v.errors });
        const r = require('./apply.cjs').applyProposal(prop, { confirm: true, proposalName: body.file || null });
        return send(res, r.ok ? 200 : 409, r);
      }

      if (route === 'GET /proposals') {
        return send(res, 200, { ok: true, ...require('./inbox.cjs').listProposals() });
      }

      return send(res, 404, { ok: false, error: 'not-found', route });
    } catch (e) {
      log.error('request failed', { route, err: e.message });
      return send(res, 500, { ok: false, error: 'internal', detail: e.message });
    }
  });

  return { server, port };
}

module.exports = { createServer, hostAllowed, VERSION, STARTED_AT };
