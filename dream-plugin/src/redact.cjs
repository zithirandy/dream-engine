'use strict';
/**
 * redact.cjs —— 脱敏流水线（V2 §8.2，🟢5：覆盖所有进入 state 的文本）。
 *
 * 分五级：
 *   1) 凭据擦除（正则）
 *   2) 业务敏感词（可配置）
 *   3) 路径归一（绝对路径 → 占位）
 *   4) 长 hex/base64 擦除
 *   5) 统计与审计
 *
 * 注意：本模块在「候选落盘前」就调用，因此本地 candidates/ 里也不存凭据。
 */
const path = require('path');

const CREDENTIAL_PATTERNS = [
  // Anthropic / OpenAI 风格
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:sk]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:sk-ant]'],
  // TypeSafe
  [/\bapikey_[A-Za-z0-9_]{16,}\b/gi, '[REDACTED:apikey]'],
  // Bearer / token 赋值
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer [REDACTED]'],
  [/\b(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|TYPESAFE_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|GH_TOKEN|Z_API_KEY|OBSIDIAN_API_KEY|PGPASSWORD|MYSQL_PWD)\b\s*[:=]\s*["']?[^\s"',}]{4,}/g, '$1=[REDACTED]'],
  // 环境变量导出
  [/\bexport\s+([A-Z0-9_]{4,})\s*=\s*["'][^"']{12,}["']/g, 'export $1=[REDACTED]'],

  // ★ F2 修复：口令形态（此前完全缺失，导致 password='…' 直接落盘）
  //   1) 引号在 = 与值之间：password='x' / PASSWORD = "x"
  [/\b(password|passwd|pwd|pass)\b\s*[:=]\s*(['"])[^'"]{1,80}\2/gi, '$1=$2[REDACTED]$2'],
  //   2) 无引号且以分隔符结尾：Password=abc; / password: abc,
  //      排除集含 [ ] { } —— 否则会二次匹配已替换的 `[REDACTED]`，产出 `[REDACTED]]`
  [/\b(password|passwd|pwd|pass)\b\s*[:=]\s*[^\s'";,)\[\]}{]{1,80}/gi, '$1=[REDACTED]'],
  //   3) ADO.NET / SQL 连接串其余敏感键
  //      排除集含 [ ] { } —— 否则会对已脱敏的 `Uid=[REDACTED]` 二次匹配、虚增计数
  [/\b(Uid|User\s?Id|User\s?ID)\b\s*=\s*[^;'"\s\[\]}{]{1,80}/gi, '$1=[REDACTED]'],
  [/\b(AccountKey|SharedAccessKey|AccessKey|SecretKey)\b\s*=\s*[^;'"\s\[\]}{]{4,}/gi, '$1=[REDACTED]'],

  // 私钥块
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]'],
  // 连接串里的密码
  [/((?:mongodb|mysql|postgres|redis|amqp)(?:\+\w+)?:\/\/[^:\s]+):([^@\s]+)@/gi, '$1:[REDACTED]@'],

  // ★ F2 修复（第二轮）：命令行长选项形态（此前只覆盖关键字形态）
  [/(--password|--passwd|--pwd)\s*[= ]\s*(['"])[^'"]{1,80}\2/gi, '$1=[REDACTED]'],
  [/(--password|--passwd|--pwd)\s*[= ]\s*[^\s'";,)\[\]}{]{1,80}/gi, '$1=[REDACTED]'],
];

// ★ F2 修复（第二轮）：命令行短选项需**上下文门控**，否则会误伤 `mkdir -p <dir>`
const SQL_CLI_CTX = /\b(?:sqlcmd|SQLCMD|bcp|isql|osql|Invoke-Sqlcmd|mssql-cli)\b/;
const MYSQL_CLI_CTX = /\b(?:mysql|mysqladmin|mysqldump|mariadb)\b/i;
// 连接语境：只有在这种语境里才脱敏「用户名」（散文里的账号名是业务规则，不能动）
const CONN_CTX = /\b(?:connect\s*\(|server\s*=|data\s?source\s*=|initial\s?catalog\s*=|host\s*=|hostname\s*=|database\s*=|pymssql|psycopg|pymongo|sqlalchemy|jdbc:|mongodb:\/\/)\b/i;

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 旗标取值正则。
 * 关键：旗标后必须是**空白或引号**（lookahead），否则 `-U` 会在 `-Username` 内部命中，
 * 结果吃掉旗标前缀、真正的值反而漏网。
 */
function flagValueRe(flag) {
  return new RegExp(`(\\s${esc(flag)})(?=\\s|['"])(\\s*(?:'[^']*'|"[^"]*"|[^\\s'"]+))`, 'g');
}

/** 上下文相关的 CLI 凭据擦除（sqlcmd -U/-P、mysql -p<val>） */
function redactCliSecrets(out, count) {
  let hits = 0;

  if (SQL_CLI_CTX.test(out)) {
    // 长旗标先于短旗标（虽然 lookahead 已防交叉命中，顺序仍更稳）
    for (const f of ['-Password', '-Username', '-User', '-Pwd', '-P', '-U']) {
      out = out.replace(flagValueRe(f), (_m, pre) => { hits++; return `${pre} [REDACTED]`; });
    }
  }

  if (MYSQL_CLI_CTX.test(out)) {
    // ★ E7：引号形态必须同时覆盖单双引号与含空格的引号值（`-p"pw x"`）
    const quoted = (flag) => new RegExp(`(\\s${esc(flag)}\\s*)(['"])([^'"]{1,80})\\2`, 'g');
    for (const f of ['--password', '--user', '-p', '-u', '-h']) {
      out = out.replace(quoted(f), (_m, pre, q) => { hits++; return `${pre}${q}[REDACTED]${q}`; });
    }
    // 无引号紧贴形态（`-pSec123` / `-uroot`）
    // 注：`-p <空格>` 在真实 mysql 语义里是"提示输入密码"模式，后随 token 是库名而非口令，
    //     故**不**按凭据处理（避免误伤库名）。见 test/p1.cjs E7b。
    out = out.replace(/(\s-p)([^\s'"]{3,})/g, (_m, pre) => { hits++; return `${pre}[REDACTED]`; });
    out = out.replace(/(\s-u)([^\s'"]{2,})/g, (_m, pre) => { hits++; return `${pre}[REDACTED]`; });
    // 带空格无引号（`-u root`）
    out = out.replace(/(\s-u)\s+([^\s'"]{2,})/g, (_m, pre) => { hits++; return `${pre} [REDACTED]`; });
    // 长选项 `--user=alice`（排除集防二次匹配）
    out = out.replace(/(--user|--host)\s*=\s*[^\s'";,)\[\]}{]{1,80}/gi, '$1=[REDACTED]');
  }

  if (hits) count('credential', hits);
  return out;
}

/**
 * ★ F2（第二轮）：连接语境里的**用户名**。
 * 只在 CONN_CTX 命中时执行 —— 散文中的账号名（如"一律只读账号 demo_reader"）
 * 是业务规则，脱敏掉反而毁掉记忆价值。
 */
function redactConnUsernames(out, count) {
  if (!CONN_CTX.test(out)) return out;
  let hits = 0;
  const re = /\b(user|username|uid|login|account)\b(\s*[:=]\s*)(['"])[^'"]{1,60}\3/gi;
  out = out.replace(re, (_m, k, sep, q) => { hits++; return `${k}${sep}${q}[REDACTED]${q}`; });
  if (hits) count('credential', hits);
  return out;
}

const HIGH_ENTROPY = [
  [/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED:hex]'],
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, '[REDACTED:blob]'],
];

// ★ F2 修复：内网 IP 归一（不碰回环，回环无泄漏价值但有用）
const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * @param {string} text
 * @param {{extraPatterns?:Array, sensitiveTerms?:string[], home?:string}} opts
 * @returns {{text:string, hits:object}}
 */
function redact(text, opts = {}) {
  if (typeof text !== 'string' || !text) return { text: '', hits: {} };
  const hits = {};
  let out = text;

  const count = (key, n) => { if (n) hits[key] = (hits[key] || 0) + n; };

  for (const [re, rep] of CREDENTIAL_PATTERNS) {
    const m = out.match(re);
    if (m) { count('credential', m.length); out = out.replace(re, rep); }
  }
  for (const [re, rep] of HIGH_ENTROPY) {
    const m = out.match(re);
    if (m) { count('highEntropy', m.length); out = out.replace(re, rep); }
  }

  // ★ F2：命令行短选项凭据（上下文门控）
  out = redactCliSecrets(out, count);
  // ★ F2：连接语境里的用户名（散文里的账号名保留）
  out = redactConnUsernames(out, count);

  // 内网 IP 归一（F2）：默认开，可用 opts.redactPrivateIps=false 关闭
  if (opts.redactPrivateIps !== false) {
    const m = out.match(PRIVATE_IP);
    if (m) { count('internalIp', m.length); out = out.replace(PRIVATE_IP, '[REDACTED:internal-ip]'); }
  }

  // 业务敏感词
  const terms = Array.isArray(opts.sensitiveTerms) ? opts.sensitiveTerms : [];
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(escapeRe(t), 'g');
    const m = out.match(re);
    if (m) { count('sensitiveTerm', m.length); out = out.replace(re, '[REDACTED:term]'); }
  }

  // 额外正则（配置）
  const extra = Array.isArray(opts.extraPatterns) ? opts.extraPatterns : [];
  for (const p of extra) {
    try {
      const re = new RegExp(p, 'g');
      const m = out.match(re);
      if (m) { count('extraPattern', m.length); out = out.replace(re, '[REDACTED:extra]'); }
    } catch { /* 忽略非法正则 */ }
  }

  // 路径归一：把用户主目录与盘符绝对路径折叠
  const home = opts.home || require('os').homedir();
  const homeRe = new RegExp(escapeRe(home).replace(/\\\\/g, '\\\\'), 'gi');
  if (homeRe.test(out)) { count('path', 1); out = out.replace(homeRe, '~'); }
  const absRe = /\b[A-Za-z]:\\(?:[^\\\s"']+\\){1,}/g;
  const absHits = out.match(absRe);
  if (absHits) { count('absPath', absHits.length); out = out.replace(absRe, (m) => path.basename(m.replace(/\\$/, '')) + '\\'); }

  return { text: out, hits };
}

/** 判断文本是否含明显凭据（用于拒绝把整条候选入库） */
function hasCredential(text) {
  if (!text) return false;
  return CREDENTIAL_PATTERNS.some(([re]) => { re.lastIndex = 0; return re.test(text); });
}

/**
 * 递归脱敏任意结构（F2：evidence[] 此前完全不过脱敏）。
 * 只处理字符串，保持对象形状不变。
 */
function redactDeep(value, opts = {}) {
  const hits = {};
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redact(v, opts);
      for (const [k, n] of Object.entries(r.hits)) hits[k] = (hits[k] || 0) + n;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return { value: walk(value), hits };
}

module.exports = {
  redact, redactDeep, hasCredential, CREDENTIAL_PATTERNS, HIGH_ENTROPY, PRIVATE_IP,
  redactCliSecrets, redactConnUsernames, flagValueRe,
  SQL_CLI_CTX, MYSQL_CLI_CTX, CONN_CTX,
};
