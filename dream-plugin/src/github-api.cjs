'use strict';
/**
 * github-api.cjs —— GitHub REST 传输层（只做「取 JSON」，不含任何业务语义）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么默认走 `gh` 而不是 fetch —— 本机实测结论，不是偏好
 * ══════════════════════════════════════════════════════════════════════════
 * 本机 hosts 把**整块 GitHub 域名**（含 `api.github.com`）重定向到 127.0.0.1，
 * 由本机代理持自签根证书做 TLS 中间人（典型的"GitHub 加速"工具）。
 * 后果实测：
 *
 *   · Node 裸 `fetch('https://api.github.com/')` → `fetch failed`
 *     cause: `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
 *     （Node 读自己的内置 CA，不读 Windows 证书store）
 *   · 同一个请求加 `--use-system-ca` → **200 OK**（Node 改读系统store后命中该根证书）
 *   · `gh api` → 一直正常（Go 的 TLS 栈默认读系统store）
 *
 * 而插件在 hook / 守护进程里是被 `node xxx.cjs`（**不带任何标志**）拉起的，
 * 我们无法事后给自己加 `--use-system-ca` ⇒ **在插件内部用 fetch 必然失败**。
 * 故默认 `transport: 'gh'`，把 TLS 与凭据都交给已经能用的 `gh`。
 *
 * ⚠️ 对照：`api.typesafe.ai` **没有**被 hosts 劫持（解析到真实 Cloudflare IP），
 *    所以 `jev.cjs` 用的 fetch 一直正常 —— 两处不能互相推断。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 翻页：必须自己翻，且必须带页上限
 * ══════════════════════════════════════════════════════════════════════════
 * 实测陷阱：`gh api --paginate` **没有页数上限**。对 issue 数巨大的仓库
 * （octocat/Hello-World）会一路翻几百页 —— 实测**挂死超过 120 秒**。
 * 故本模块**不使用 `--paginate`**，改为逐页调用并：
 *   1. 硬上限 `maxPages`；
 *   2. 每页 `spawnSync` 带 `timeout`（实测能 SIGTERM 兜住，不会挂死）。
 *
 * 另一个实测细节：GitHub 的 `Link: rel="next"` 用的是 **cursor 分页**
 * （`&after=Y3Vyc29yOnYyOpLP…`）而非纯页码 ⇒ **必须直接跟随 Link URL**，
 * 不能自己拼 `page=N+1`，否则会漏数据或重复。（本模块把 Link 的完整 URL
 * 剥成 path+query 再交给 `gh api`，避免依赖 gh 对完整 URL 的支持。）
 *
 * ⚠️ 凭据：本模块**永不记录、永不返回可打印的 token 全文**，
 *    只回报 `from=` 出处（与 `jev.cjs:readApiKey` 的报法一致）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const pathsMod = require('./paths.cjs');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BUFFER = 64 * 1024 * 1024;

// ------------------------------------------------------------------ gh 定位

/**
 * 候选路径。
 *
 * ★ `ghPath` 一旦**显式配置**就成为唯一候选 —— 不做"配错了就悄悄回退到 PATH"
 *   的兜底。理由：那正是本项目反复踩过的"配置了但没生效"的静默陷阱
 *   （测试 I5 抓到：配了一个不存在的路径，仍然拿 PATH 里的 gh 成功返回，
 *   调用方完全看不出自己的配置被忽略了）。配错就报错，提示里带上配的那个路径。
 */
function ghCandidates(cfg) {
  const c = (cfg && cfg.github) || {};
  if (c.ghPath) return [c.ghPath];
  const out = [];
  const exe = process.platform === 'win32' ? 'gh.exe' : 'gh';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) out.push(path.join(dir, exe));
  }
  if (process.platform === 'win32') {
    out.push('C:\\Program Files\\GitHub CLI\\gh.exe');
    out.push(path.join(os.homedir(), 'AppData', 'Local', 'GitHubCLI', 'gh.exe'));
  } else {
    out.push('/usr/local/bin/gh', '/usr/bin/gh', '/opt/homebrew/bin/gh');
  }
  return out;
}

/** 找到可用的 gh 绝对路径；找不到返回 null（调用方据此报错并给出提示） */
function ghPath(cfg) {
  for (const p of ghCandidates(cfg)) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/** 排查 gh 不可用时到底找过哪些路径（错误提示用） */
function ghSearchDetail(cfg) {
  const c = (cfg && cfg.github) || {};
  const cands = ghCandidates(cfg);
  return c.ghPath
    ? `github.ghPath 配置为 ${c.ghPath}，但该文件不存在`
    : `已尝试 ${cands.length} 个位置（PATH + 常见安装目录）均未找到 gh`;
}

// ------------------------------------------------------------------ 凭据

/**
 * 解析 GitHub 凭据。
 *
 * 三种来源，**互斥**，由 `github.tokenSource` 决定：
 *   · `gh`（默认）—— 直接问已登录的 gh CLI 要 token（token 存在 Windows
 *     凭据管理器里，**从不落到本插件的任何文件**）。选它当默认是因为：
 *     它现在就可用，且不需要用户为插件新造一个明文 secret。
 *   · `settings:<NAME>` —— 从宿主 `settings.json` 的 `env.<NAME>` 读，
 *     与 `jev.keySource` 同一套约定（用户明确要求的口径）。
 *   · `env:<NAME>` —— 进程环境变量（显式非默认例外，与 jev 一致）。
 *
 * ★ 返回值里的 `token` 可以拿去发请求，但**绝不能进日志**；对外只报 `from`。
 */
function resolveToken(cfg, { deps = {} } = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const src = (cfg && cfg.github && cfg.github.tokenSource) || 'gh';
  const [where, name] = String(src).split(':');

  if (where === 'gh') {
    const bin = ghPath(cfg);
    if (!bin) return { ok: false, reason: 'gh-not-found', hint: '安装 GitHub CLI，或改 github.tokenSource=settings:GITHUB_TOKEN', detail: ghSearchDetail(cfg) };
    let r;
    try {
      r = spawn(bin, ['auth', 'token'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    } catch (e) {
      return { ok: false, reason: 'gh-spawn-failed', error: e.message };
    }
    if (r.error) return { ok: false, reason: 'gh-spawn-failed', error: r.error.code || r.error.message };
    const tok = String(r.stdout || '').trim();
    if (r.status !== 0 || !tok) {
      return {
        ok: false, reason: 'gh-not-authenticated',
        hint: 'gh auth login',
        detail: String(r.stderr || '').trim().slice(0, 200),
      };
    }
    return { ok: true, token: tok, from: `gh:${bin} (keyring)`, kind: 'gh' };
  }

  if (where === 'settings') {
    const f = path.join(pathsMod.claudeHome(), 'settings.json');
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      const v = (j.env || {})[name];
      if (v) return { ok: true, token: String(v), from: `${f}#env.${name}`, kind: 'settings' };
    } catch (e) {
      return { ok: false, reason: 'settings-read-failed', error: e.message };
    }
    return { ok: false, reason: `not-found: ${name}`, hint: `在 ${f} 的 env 里加 ${name}` };
  }

  if (where === 'env') {
    const v = process.env[name];
    return v
      ? { ok: true, token: String(v), from: `env:${name}`, kind: 'env' }
      : { ok: false, reason: `env ${name} 未设置` };
  }

  return { ok: false, reason: `未知 tokenSource: ${src}` };
}

// ------------------------------------------------------------------ 响应解析

/** 从 `gh api --include` 的输出里剥出「状态码 + 头 + JSON 正文」 */
function parseIncludeOutput(raw) {
  const text = String(raw || '');
  const parts = text.split(/\r?\n\r?\n/);
  if (parts.length < 2) return { ok: false, reason: 'no-header-body-separator' };

  const headBlock = parts[0];
  const lines = headBlock.split(/\r?\n/);
  const statusLine = lines[0] || '';
  const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine);
  const status = m ? Number(m[1]) : 0;

  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }

  // 用第一个空行之后的所有内容作正文：多信封（不该出现）时也不会静默丢数据
  const body = parts.slice(1).join('\n\n');
  return { ok: true, status, headers, body };
}

/** 把 Link 头里的 rel="next" 完整 URL 剥成 gh 能吃的 path+query */
function nextFromLink(link) {
  if (!link) return null;
  const m = /<([^>]+)>\s*;\s*rel="next"/i.exec(link);
  if (!m) return null;
  try {
    const u = new URL(m[1]);
    return u.pathname.replace(/^\//, '') + (u.search || '');
  } catch {
    return null;
  }
}

function rateFromHeaders(h) {
  const n = (k) => { const v = h[k]; return v === undefined ? null : Number(v); };
  return {
    limit: n('x-ratelimit-limit'),
    remaining: n('x-ratelimit-remaining'),
    used: n('x-ratelimit-used'),
    resource: h['x-ratelimit-resource'] || null,
    reset: n('x-ratelimit-reset'),
    resetAt: h['x-ratelimit-reset'] ? new Date(Number(h['x-ratelimit-reset']) * 1000).toISOString() : null,
  };
}

// ------------------------------------------------------------------ 请求

/**
 * 取一页。返回 `{ok, status, headers, data, error, hint}`。
 * **绝不抛异常** —— 调用方是定时任务，一次网络抖动不该让整轮崩掉。
 */
function requestOnce({ spec, cfg, token, timeoutMs = DEFAULT_TIMEOUT_MS, deps = {} }) {
  const spawn = deps.spawnSync || spawnSync;
  const transport = (cfg && cfg.github && cfg.github.transport) || 'gh';
  const accept = 'application/vnd.github+json';

  if (transport === 'gh') {
    const bin = ghPath(cfg);
    if (!bin) return { ok: false, error: 'gh-not-found', hint: '装 gh 或改 github.transport=rest', detail: ghSearchDetail(cfg) };
    let r;
    try {
      r = spawn(bin, ['api', '--include', '-H', `Accept: ${accept}`, spec], {
        encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER,
      });
    } catch (e) {
      return { ok: false, error: 'gh-spawn-failed', detail: e.message };
    }
    if (r.error) {
      const to = r.error.code === 'ETIMEDOUT';
      return { ok: false, error: to ? 'timeout' : 'gh-spawn-failed', detail: r.error.code || r.error.message, timeoutMs };
    }
    const parsed = parseIncludeOutput(r.stdout);
    if (!parsed.ok) {
      return {
        ok: false, error: 'unparsable-gh-output',
        detail: String(r.stderr || '').trim().slice(0, 300) || parsed.reason,
      };
    }
    const { status, headers, body } = parsed;
    let data = null;
    if (body.trim()) {
      try { data = JSON.parse(body); }
      catch (e) { return { ok: false, status, error: 'json-parse-failed', detail: e.message, bodyHead: body.slice(0, 200) }; }
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false, status, headers, data,
        error: `http-${status}`,
        detail: (data && (data.message || data.error)) || String(r.stderr || '').trim().slice(0, 200),
      };
    }
    return { ok: true, status, headers, data, rate: rateFromHeaders(headers), etag: headers.etag || null };
  }

  // ---- transport: 'rest'（标准环境；本机因 TLS 中间人需要 --use-system-ca） ----
  if (!token) return { ok: false, error: 'no-token', hint: 'transport=rest 需要可用的 github.tokenSource' };
  const url = /^https?:\/\//i.test(spec) ? spec : `https://api.github.com/${String(spec).replace(/^\//, '')}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'autodream-github-digest',
  };
  const fetchImpl = deps.fetch || fetch;
  return Promise.resolve()
    .then(() => fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) }))
    .then(async (res) => {
      const h = {};
      res.headers.forEach((v, k) => { h[String(k).toLowerCase()] = v; });
      let data = null;
      const text = await res.text();
      if (text.trim()) { try { data = JSON.parse(text); } catch { /* 非 JSON 也照常处理 */ } }
      if (!res.ok) {
        return { ok: false, status: res.status, headers: h, data, error: `http-${res.status}`, detail: (data && data.message) || text.slice(0, 200) };
      }
      return { ok: true, status: res.status, headers: h, data, rate: rateFromHeaders(h), etag: h.etag || null };
    })
    .catch((e) => {
      const cause = e && e.cause ? e.cause : null;
      const certIssue = cause && /CERT|VERIFY|SELF_SIGNED/i.test(String(cause.code || cause.message));
      return {
        ok: false,
        error: certIssue ? 'tls-untrusted' : 'fetch-failed',
        detail: (cause && (cause.code || cause.message)) || e.message,
        hint: certIssue
          ? '本机 TLS 被中间人（hosts 劫持 + 自签根证书）。用 transport=gh，或给 node 加 --use-system-ca / 设 NODE_EXTRA_CA_CERTS'
          : null,
      };
    });
}

/**
 * 逐页取全部条目（**有界**）。
 *
 * @returns {Promise<{ok, items, pages, rate, truncated, errors, status}>}
 */
async function paginate({ path: p, cfg, token, perPage = 100, maxPages = 5, timeoutMs = DEFAULT_TIMEOUT_MS, deps = {} }) {
  const items = [];
  const errors = [];
  let spec = p;
  if (!/[?&]per_page=/.test(spec)) spec += (spec.includes('?') ? '&' : '?') + `per_page=${perPage}`;
  let pages = 0;
  let rate = null;
  let truncated = false;

  while (spec && pages < maxPages) {
    const res = await requestOnce({ spec, cfg, token, timeoutMs, deps });
    pages++;
    if (!res.ok) {
      errors.push({ spec, status: res.status || null, error: res.error, detail: res.detail || null, hint: res.hint || null });
      // 404 是确定性错误，继续翻页没有意义
      if (res.status === 404) break;
      if (res.error !== 'timeout' && String(res.error).startsWith('http-4')) break;
      break;
    }
    rate = res.rate || rate;
    if (Array.isArray(res.data)) items.push(...res.data);
    else if (res.data && typeof res.data === 'object') items.push(res.data);

    const next = nextFromLink(res.headers && res.headers.link);
    if (!next) { spec = null; break; }
    spec = next;
  }

  if (spec && pages >= maxPages) truncated = true;

  return {
    ok: errors.length === 0,
    items, pages, rate, truncated, errors,
    status: errors.length ? (errors[0].status || null) : 200,
  };
}

/** 查速率配额。`/rate_limit` 本身**不消耗**配额（实测 remaining 不变）。 */
async function rateLimit({ cfg, token, timeoutMs = DEFAULT_TIMEOUT_MS, deps = {} }) {
  const res = await requestOnce({ spec: 'rate_limit', cfg, token, timeoutMs, deps });
  if (!res.ok) return { ok: false, error: res.error, detail: res.detail || null };
  const core = res.data && res.data.resources && res.data.resources.core;
  return {
    ok: true,
    core: core ? { limit: core.limit, remaining: core.remaining, used: core.used, resetAt: new Date(core.reset * 1000).toISOString() } : null,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ghPath,
  ghCandidates,
  ghSearchDetail,
  resolveToken,
  parseIncludeOutput,
  nextFromLink,
  rateFromHeaders,
  requestOnce,
  paginate,
  rateLimit,
};
