'use strict';
/**
 * github-collect.cjs —— 采集并**归一化** GitHub 条目（不含渲染、不含状态）。
 *
 * 归一化的目的：把 issue / 评论 / PR / review / review 评论 / 通知这 6 种形状
 * 揉成**同一个 item 结构**，这样下游的「状态比对 → delta → 渲染」只写一遍。
 *
 * ── 采集源与增量键（务必看清，容易搞错） ──────────────────────────────
 *   issues              GET /repos/{r}/issues?state=all&sort=updated&since=  ✅ 有 since
 *                       ⚠️ 该端点**同时返回 PR**！必须按 `pull_request` 字段剔除，
 *                          否则每个 PR 会被当成两条（一条 issue + 一条 PR）。
 *   issueComments       GET /repos/{r}/issues/comments?sort=updated&since=   ✅ 有 since
 *   prs                 GET /repos/{r}/pulls?state=all&sort=updated          ❌ **无 since**
 *                       ⇒ 只能按 updated_at 在客户端截断（已排序，可提前停）
 *   prReviewComments    GET /repos/{r}/pulls/comments?sort=updated&since=    ✅ 有 since
 *   prReviews           GET /repos/{r}/pulls/{n}/reviews                     ❌ 无 since，逐 PR
 *                       ⇒ 只对「本轮 delta 里出现过的 PR」补采，且受 maxReviewPrs 限制
 *   notifications       GET /notifications?all=false                         ❌ 无 since（默认关闭）
 *
 * `since` 按 **updated_at** 过滤。为了避免两次运行之间的边界漏采（时钟偏差、
 * 上一轮跑到一半），调用方应把 since 往前挪 `overlapMinutes` 分钟。
 */
const apiMod = require('./github-api.cjs');

// ------------------------------------------------------------------ 小工具

/** 从 `https://api.github.com/repos/o/r/issues/12` 里取 12 */
function numberFromApiUrl(url, seg) {
  if (!url) return null;
  const m = new RegExp(`/${seg}/(\\d+)(?:$|[?#])`).exec(String(url));
  return m ? Number(m[1]) : null;
}

function login(u) {
  if (!u) return null;
  return u.login || null;
}

/** bot 判定：GitHub 的 `type === 'Bot'`，或登录名以 [bot] 结尾 */
function isBot(u) {
  if (!u) return false;
  return u.type === 'Bot' || /\[bot\]$/i.test(String(u.login || ''));
}

function htmlUrlOf(raw, fallbackRepo) {
  return raw.html_url || (fallbackRepo ? `https://github.com/${fallbackRepo}` : null);
}

// ------------------------------------------------------------------ 归一化

function normIssue(raw, repo) {
  const isPr = !!raw.pull_request;
  if (isPr) return null;                     // ★ 由 pulls 采集器负责，此处剔除
  return {
    id: `issue#${raw.number}`,
    kind: 'issue',
    repo,
    number: raw.number,
    title: raw.title || '(无标题)',
    url: htmlUrlOf(raw, repo),
    author: login(raw.user),
    authorIsBot: isBot(raw.user),
    state: raw.state,
    stateReason: raw.state_reason || null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at || null,
    comments: raw.comments || 0,
    labels: (raw.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    milestone: raw.milestone ? raw.milestone.title : null,
    assignees: (raw.assignees || []).map(login).filter(Boolean),
    reactions: reactionsOf(raw.reactions),
    body: raw.body || '',
    isPr: false,
    parentKey: null,
    parentNumber: null,
    parentTitle: null,
  };
}

function normPr(raw, repo) {
  const merged = !!raw.merged_at;
  return {
    id: `pr#${raw.number}`,
    kind: 'pr',
    repo,
    number: raw.number,
    title: raw.title || '(无标题)',
    url: htmlUrlOf(raw, repo),
    author: login(raw.user),
    authorIsBot: isBot(raw.user),
    // ★ 合并态优先：raw.state 只会是 open/closed，merged 也是 closed，
    //   不区分的话"已合并"和"被关掉"在报告里长得一模一样。
    state: merged ? 'merged' : raw.state,
    stateReason: null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at || null,
    mergedAt: raw.merged_at || null,
    isDraft: !!raw.draft,
    comments: (raw.comments || 0) + (raw.review_comments || 0),
    reviewComments: raw.review_comments || 0,
    labels: (raw.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    base: raw.base ? raw.base.ref : null,
    head: raw.head ? raw.head.ref : null,
    mergedBy: raw.merged_by ? login(raw.merged_by) : null,
    reactions: null,
    body: raw.body || '',
    isPr: true,
    parentKey: null,
    parentNumber: null,
    parentTitle: null,
  };
}

function normIssueComment(raw, repo) {
  const n = numberFromApiUrl(raw.issue_url, 'issues');
  return {
    id: `issue_comment#${raw.id}`,
    kind: 'issue_comment',
    repo,
    number: n,
    title: null,
    url: htmlUrlOf(raw, repo),
    author: login(raw.user),
    authorIsBot: isBot(raw.user),
    state: null,
    stateReason: null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    labels: [],
    reactions: reactionsOf(raw.reactions),
    body: raw.body || '',
    isPr: false,
    parentKey: n === null ? null : `issue#${n}`,
    parentNumber: n,
    parentTitle: null,
  };
}

function normReviewComment(raw, repo) {
  const n = numberFromApiUrl(raw.pull_request_url, 'pulls');
  return {
    id: `pr_review_comment#${raw.id}`,
    kind: 'pr_review_comment',
    repo,
    number: n,
    title: null,
    url: htmlUrlOf(raw, repo),
    author: login(raw.user),
    authorIsBot: isBot(raw.user),
    state: null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    labels: [],
    reactions: reactionsOf(raw.reactions),
    body: raw.body || '',
    file: raw.path || null,
    line: raw.line || raw.original_line || null,
    inReplyTo: raw.in_reply_to_id || null,
    isPr: true,
    // 先用 pr#N 占位；若同轮采到了真正的 PR 条目，稍后会把标题补上
    parentKey: n === null ? null : `pr#${n}`,
    parentNumber: n,
    parentTitle: null,
  };
}

function normReview(raw, prNumber, repo) {
  return {
    id: `pr_review#${raw.id}`,
    kind: 'pr_review',
    repo,
    number: prNumber,
    title: null,
    url: raw.html_url || `https://github.com/${repo}/pull/${prNumber}`,
    author: login(raw.user),
    authorIsBot: isBot(raw.user),
    state: raw.state || null,                 // APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED
    createdAt: raw.submitted_at || null,
    updatedAt: raw.submitted_at || null,      // review 没有 updated_at，用 submitted_at
    labels: [],
    reactions: null,
    body: raw.body || '',
    isPr: true,
    parentKey: `pr#${prNumber}`,
    parentNumber: prNumber,
    parentTitle: null,
  };
}

function normNotification(raw) {
  const repo = raw.repository ? raw.repository.full_name : null;
  const sub = raw.subject || {};
  const num = numberFromApiUrl(sub.url, 'issues') || numberFromApiUrl(sub.url, 'pulls');
  return {
    id: `notification#${raw.id}`,
    kind: 'notification',
    repo,
    number: num,
    title: sub.title || null,
    url: sub.url ? String(sub.url).replace('https://api.github.com/repos', 'https://github.com') : null,
    author: null,
    authorIsBot: false,
    state: null,
    createdAt: raw.updated_at,
    updatedAt: raw.updated_at,
    labels: [],
    reactions: null,
    body: raw.reason || '',
    isPr: sub.type === 'PullRequest',
    parentKey: num === null ? null : (sub.type === 'PullRequest' ? `pr#${num}` : `issue#${num}`),
    parentNumber: num,
    parentTitle: null,
    notificationReason: raw.reason || null,
    unread: !!raw.unread,
  };
}

function reactionsOf(r) {
  if (!r) return null;
  return {
    total: r.total_count || 0,
    plus1: r['+1'] || 0,
    minus1: r['-1'] || 0,
    laugh: r.laugh || 0,
    hooray: r.hooray || 0,
    confused: r.confused || 0,
    heart: r.heart || 0,
    rocket: r.rocket || 0,
    eyes: r.eyes || 0,
  };
}

// ------------------------------------------------------------------ 采集

/**
 * 采集单个仓库。
 *
 * @returns {Promise<{repo, items, stats, errors, truncated, rate, prsSeen}>}
 */
async function collectRepo({ repo, cfg, token, since, deps = {} }) {
  const g = (cfg && cfg.github) || {};
  const c = g.collection || {};
  const src = c.sources || {};
  const perPage = Number(c.perPage) || 100;
  const maxPages = Math.max(1, Number(c.maxPages) || 5);
  const timeoutMs = Number(c.timeoutMs) || apiMod.DEFAULT_TIMEOUT_MS;
  const maxReviewPrs = Math.max(0, Number(c.maxReviewPrs) || 20);

  const items = [];
  const errors = [];
  const stats = {};
  let truncated = false;
  let rate = null;

  const call = async (label, spec, maxP = maxPages) => {
    const r = await apiMod.paginate({ path: spec, cfg, token, perPage, maxPages: maxP, timeoutMs, deps });
    rate = r.rate || rate;
    if (r.truncated) truncated = true;
    for (const e of r.errors) errors.push({ source: label, ...e });
    // ★ `rawCount` 记的是**接口返回条数**，`stats[label]` 记的是**我们真正保留的条数**。
    //   两者必须分开：`/issues` 端点会把 PR 一起返回（要剔除），若 stats 直接记 raw，
    //   报告里就会出现"issues 3 条"而实际只有 2 条 —— 测试 G2 正是抓到了这个口径错误。
    stats[label + 'Raw'] = (stats[label + 'Raw'] || 0) + r.items.length;
    return r.items;
  };
  /** 记一条**保留下来**的条目 */
  const keep = (label) => { stats[label] = (stats[label] || 0) + 1; };

  const sinceQ = since ? `&since=${encodeURIComponent(since)}` : '';
  const bump = (s) => (s.includes('?') ? s + '&' : s + '?');

  // ---- 1. issues（剔除 PR） ----
  if (src.issues !== false) {
    const raw = await call('issues', `repos/${repo}/issues?state=all&sort=updated&direction=desc${sinceQ}`);
    for (const r of raw) {
      const it = normIssue(r, repo);
      if (it) { items.push(it); keep('issues'); }
    }
  }

  // ---- 2. issue 评论 ----
  if (src.issueComments !== false) {
    const raw = await call('issueComments', `repos/${repo}/issues/comments?sort=updated&direction=desc${sinceQ}`);
    for (const r of raw) { items.push(normIssueComment(r, repo)); keep('issueComments'); }
  }

  // ---- 3. PR（无 since，客户端按 updatedAt 截断） ----
  const prNumbers = [];
  if (src.prs !== false) {
    const raw = await call('prs', `repos/${repo}/pulls?state=all&sort=updated&direction=desc`);
    const sinceMs = since ? Date.parse(since) : 0;
    for (const r of raw) {
      // 已按 updated 降序 ⇒ 一旦早于 since 就可以停（后面只会更早）
      if (sinceMs && Date.parse(r.updated_at) < sinceMs) break;
      const it = normPr(r, repo);
      items.push(it);
      keep('prs');
      prNumbers.push({ number: it.number, updatedAt: it.updatedAt });
    }
  }

  // ---- 4. PR review 评论 ----
  if (src.prReviewComments !== false) {
    const raw = await call('prReviewComments', `repos/${repo}/pulls/comments?sort=updated&direction=desc${sinceQ}`);
    for (const r of raw) {
      const it = normReviewComment(r, repo);
      items.push(it);
      keep('prReviewComments');
      if (it.number !== null && !prNumbers.some((p) => p.number === it.number)) {
        prNumbers.push({ number: it.number, updatedAt: it.updatedAt });
      }
    }
  }

  // ---- 5. PR review（逐 PR，无 since） ----
  if (src.prReviews !== false && maxReviewPrs > 0) {
    const targets = prNumbers
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, maxReviewPrs);
    stats.prReviewsSkipped = Math.max(0, prNumbers.length - targets.length);
    for (const t of targets) {
      const raw = await call('prReviews', `repos/${repo}/pulls/${t.number}/reviews`, 2);
      for (const r of raw) {
        const it = normReview(r, t.number, repo);
        if (it.updatedAt) { items.push(it); keep('prReviews'); }
      }
    }
  }

  // ---- 6. 通知（可选；无 since） ----
  if (src.notifications === true) {
    const raw = await call('notifications', `notifications?all=false`);
    for (const r of raw) {
      const it = normNotification(r);
      // 通知是跨仓库的，本仓库之外的丢弃
      if (!repo || (it.repo && it.repo.toLowerCase() === repo.toLowerCase())) { items.push(it); keep('notifications'); }
    }
  }

  // ---- 补父标题：让「#12 上的一条评论」在报告里能显示标题 ----
  const byKey = new Map();
  for (const it of items) if (it.kind === 'issue' || it.kind === 'pr') byKey.set(it.id, it);
  for (const it of items) {
    if (it.parentKey && byKey.has(it.parentKey)) {
      const p = byKey.get(it.parentKey);
      it.parentTitle = p.title;
      it.parentKind = p.kind;
    }
    // PR 上的 issue 评论：parentKey 是 issue#N，但实际是 PR
    if (it.kind === 'issue_comment' && it.parentKey && !byKey.has(it.parentKey)) {
      const prKey = `pr#${it.parentNumber}`;
      if (byKey.has(prKey)) { it.parentKey = prKey; it.parentTitle = byKey.get(prKey).title; it.parentKind = 'pr'; it.isPr = true; }
    } else if (it.parentKey && byKey.has(it.parentKey)) {
      it.parentKind = byKey.get(it.parentKey).kind;
      if (it.parentKind === 'pr') it.isPr = true;
    }
  }

  return { repo, items, stats, errors, truncated, rate };
}

/** 采集多个仓库并合并（repo 字段已写进每个 item） */
async function collectAll({ repos, cfg, token, since, deps = {} }) {
  const out = { items: [], perRepo: [], errors: [], truncated: false, rate: null };
  for (const repo of repos) {
    const r = await collectRepo({ repo, cfg, token, since, deps });
    out.items.push(...r.items);
    out.perRepo.push({ repo, count: r.items.length, stats: r.stats, errors: r.errors.length, truncated: r.truncated });
    out.errors.push(...r.errors.map((e) => ({ repo, ...e })));
    if (r.truncated) out.truncated = true;
    if (r.rate) out.rate = r.rate;
  }
  return out;
}

module.exports = {
  collectRepo,
  collectAll,
  normIssue,
  normPr,
  normIssueComment,
  normReviewComment,
  normReview,
  normNotification,
  numberFromApiUrl,
  reactionsOf,
  isBot,
};
