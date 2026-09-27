'use strict';
/**
 * token.cjs —— 本地服务鉴权 token（对应 V2 §6.2 本地服务安全）。
 * 32 字节随机 hex，写入 .dream/token，尽力设为 0600（Windows 上为 no-op）。
 */
const fs = require('fs');
const crypto = require('crypto');
const pathsMod = require('./paths.cjs');

function ensureToken() {
  const p = pathsMod.paths();
  const t = ensureTokenAt(p);
  return t;
}

function ensureTokenAt(p) {
  try {
    if (fs.existsSync(p.token)) {
      const v = fs.readFileSync(p.token, 'utf8').trim();
      if (v) return v;
    }
  } catch { /* fallthrough to regenerate */ }

  const v = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(p.home, { recursive: true });
  fs.writeFileSync(p.token, v, 'utf8');
  try { fs.chmodSync(p.token, 0o600); } catch { /* Windows: no-op */ }
  return v;
}

function readToken() {
  const p = pathsMod.paths();
  try { return fs.readFileSync(p.token, 'utf8').trim(); } catch { return null; }
}

/** 定时安全比较 */
function matches(candidate) {
  const expect = readToken();
  if (!expect || !candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { ensureToken, readToken, matches };
