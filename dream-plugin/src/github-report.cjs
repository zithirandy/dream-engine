'use strict';
/**
 * github-report.cjs —— 状态比对（delta）与 Markdown 报告渲染。
 *
 * 纯函数层：不读文件、不发请求、不碰时钟（时间从参数传入）⇒ 可以直接单测。
 *
 * ── 为什么要有 delta 而不是"把窗口内所有东西列一遍" ──────────────────
 * 每天 8:00 跑一次，若只是把 `since` 窗口内的条目全列出来，用户每天都要
 * 重读一遍昨天已经看过的内容。真正有用的是**这一天里变了什么**：
 * 谁新开了 issue、谁在旧 issue 下追了评论、哪个 PR 被合了。
 * 故状态里保存每个条目的 `updatedAt/state` 快照，本轮与之比对得出增量。
 */
const redactMod = require('./redact.cjs');

// ------------------------------------------------------------------ 格式化

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间 `YYYY-MM-DD HH:mm`；无法解析时原样返回 */
function fmtLocal(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Markdown 表格单元格：管道符会破坏列结构（P1 踩过），统一换成 ¦ */
function cell(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/\|/g, '¦')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function ageDays(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86400000));
}

const KIND_LABEL = {
  issue: 'Issue',
  pr: 'Pull Request',
  issue_comment: '评论',
  pr_review: 'Review',
  pr_review_comment: 'Review 评论',
  notification: '通知',
};

const STATE_LABEL = {
  open: '打开',
  closed: '已关闭',
  merged: '已合并',
  APPROVED: '已批准',
  CHANGES_REQUESTED: '要求修改',
  COMMENTED: '已评论',
  DISMISSED: '已驳回',
  PENDING: '待处理',
};

function stateLabel(s) { return s ? (STATE_LABEL[s] || s) : '—'; }

// ------------------------------------------------------------------ delta

/**
 * 与上一轮快照比对。
 *
 * @param items  本轮采集到的条目
 * @param prev   上一轮状态（`{items: {id: {updatedAt, state, ...}}}`），首次运行为空
 * @returns {added, updated, closed, reopened, unchanged, totals}
 */
function diffItems({ items, prev }) {
  const prevItems = (prev && prev.items) || {};
  const added = [];
  const updated = [];
  const closed = [];
  const reopened = [];
  const unchanged = [];

  for (const it of items) {
    const p = prevItems[it.id];
    if (!p) { added.push(it); continue; }

    const pu = Date.parse(p.updatedAt || 0);
    const cu = Date.parse(it.updatedAt || 0);
    const stateChanged = p.state !== it.state;

    if (stateChanged) {
      const wasDone = p.state === 'closed' || p.state === 'merged';
      const nowDone = it.state === 'closed' || it.state === 'merged';
      if (!wasDone && nowDone) closed.push({ ...it, prevState: p.state });
      else if (wasDone && !nowDone) reopened.push({ ...it, prevState: p.state });
      else updated.push({ ...it, prevState: p.state });
      continue;
    }

    if (Number.isFinite(cu) && Number.isFinite(pu) && cu > pu) updated.push({ ...it, prevState: p.state });
    else unchanged.push(it);
  }

  return {
    added, updated, closed, reopened, unchanged,
    totals: {
      seen: items.length,
      added: added.length,
      updated: updated.length,
      closed: closed.length,
      reopened: reopened.length,
      unchanged: unchanged.length,
    },
  };
}

/** 生成本轮要持久化的快照（**只存元数据，不存正文** —— 状态文件必须小） */
function snapshot(items, prev) {
  const out = {};
  for (const it of items) {
    out[it.id] = {
      kind: it.kind,
      repo: it.repo,
      number: it.number,
      title: it.title,
      state: it.state,
      updatedAt: it.updatedAt,
      author: it.author,
      url: it.url,
      comments: it.comments || 0,
    };
  }
  // 保留本轮未出现但历史上见过的条目（它们只是这次没更新，不是消失了）。
  // ⚠️ 但必须有上限：否则长期运行后状态文件无界增长。
  const prevItems = (prev && prev.items) || {};
  let carried = 0;
  for (const [id, v] of Object.entries(prevItems)) {
    if (!out[id]) { out[id] = v; carried++; }
  }
  return { items: out, carried };
}

// ------------------------------------------------------------------ 渲染

function truncateBody(text, max) {
  const s = String(text || '').trim();
  if (!max || s.length <= max) return { text: s, truncated: false, fullLength: s.length };
  return { text: s.slice(0, max), truncated: true, fullLength: s.length };
}

function quote(text, maxChars) {
  const t = truncateBody(text, maxChars);
  if (!t.text) return '  _(无正文)_';
  return t.text.split(/\r?\n/).map((l) => '  > ' + l).join('\n')
    + (t.truncated ? `\n  > _(已截断，原文 ${t.fullLength} 字)_` : '');
}

function headingFor(it) {
  const tag = it.kind === 'issue_comment' || it.kind === 'pr_review_comment' || it.kind === 'pr_review'
    ? `${KIND_LABEL[it.kind]}`
    : KIND_LABEL[it.kind];
  const num = it.number !== null && it.number !== undefined ? `#${it.number}` : '';
  const title = it.parentTitle ? `${it.parentTitle}` : (it.title || '');
  return `${tag} ${num} ${title}`.replace(/\s+/g, ' ').trim();
}

function renderItem(it, { maxBody, redactOn }) {
  const lines = [];
  const bits = [];
  if (it.author) bits.push(`@${it.author}${it.authorIsBot ? ' (bot)' : ''}`);
  bits.push(fmtLocal(it.updatedAt || it.createdAt));
  if (it.state) bits.push(stateLabel(it.state));
  if (it.prevState) bits.push(`原为${stateLabel(it.prevState)}`);
  if (it.file) bits.push(`\`${it.file}\`${it.line ? ':' + it.line : ''}`);
  if (it.labels && it.labels.length) bits.push(it.labels.map((l) => `\`${l}\``).join(' '));
  if (it.reactions && it.reactions.total) bits.push(`👍${it.reactions.plus1} ❤️${it.reactions.heart} 🎉${it.reactions.hooray}`);
  if (it.isDraft) bits.push('**草稿**');

  lines.push(`#### ${headingFor(it)}`);
  lines.push('');
  lines.push(`- ${bits.join(' · ')}`);
  if (it.url) lines.push(`- ${it.url}`);

  let body = it.body || '';
  let redactedHits = 0;
  if (redactOn && body) {
    const r = redactMod.redact(body);
    body = r.text;
    redactedHits = Object.values(r.hits).reduce((a, b) => a + b, 0);
  }
  if (redactedHits) lines.push(`- ⚠️ 正文中检出并已脱敏 ${redactedHits} 处疑似凭据`);

  if (body && body.trim()) {
    lines.push('');
    lines.push(quote(body, maxBody));
  }
  lines.push('');
  return { text: lines.join('\n'), redactedHits };
}

/**
 * 渲染完整报告。
 *
 * @returns {{markdown, stats, redactedHits}}
 */
function renderReport({
  repos, delta, meta, prevRunAt, nowMs, cfg, collection = null, errors = [], truncated = false, dryRun = false,
}) {
  const g = (cfg && cfg.github) || {};
  const rcfg = g.report || {};
  const maxBody = Number(rcfg.includeBodyChars) || 3000;
  const redactOn = rcfg.redactCredentials !== false;

  let redactedHits = 0;
  const L = [];
  const nowIso = new Date(nowMs).toISOString();

  // ★ 章节编号必须**动态生成**：中间有几段是条件段（没人需要回应、没有未关闭条目
  //   时整段不出现），写死"一/二/三/四/五"会直接跳号。
  //   实测干跑就出现过「一、概览」→「三、变化明细」的断号。
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  let sec = 0;
  const H = (t) => { sec++; return `## ${CN[sec - 1] || sec}、${t}`; };

  L.push(`# GitHub 动态日报 — ${repos.join(', ')}`);
  L.push('');
  if (dryRun) { L.push('> **DRY RUN**：本次不写状态、不推进游标，报告仅供预览。'); L.push(''); }
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  L.push(`| 生成时间 | ${fmtLocal(nowIso)} |`);
  L.push(`| 上一轮 | ${prevRunAt ? fmtLocal(prevRunAt) : '（首次运行，本轮为基线）'} |`);
  L.push(`| 采集窗口起点 | ${meta.since ? fmtLocal(meta.since) : '（不限）'} |`);
  L.push(`| 触发方式 | ${cell(meta.reason || '—')} |`);
  L.push(`| 仓库 | ${repos.map(cell).join(' / ')} |`);
  if (collection && collection.rate) {
    L.push(`| API 配额 | 剩余 ${collection.rate.remaining ?? '?'}/${collection.rate.limit ?? '?'}${collection.rate.resetAt ? `，${fmtLocal(collection.rate.resetAt)} 重置` : ''} |`);
  }
  L.push('');

  // ---- 概览 ----
  const t = delta.totals;
  L.push(H('概览'));
  L.push('');
  if (t.added + t.updated + t.closed + t.reopened === 0) {
    // 区分"saw 了东西但都没变"与"仓库本来就是空的" —— 后者说"全部与上一轮一致"
    // 会让人以为有过东西（实测仓库刚建时就是这个情形：扫描 0 条）。
    L.push(t.seen === 0
      ? '本轮仓库**没有任何条目**（issue / 评论 / PR 均为空）。'
      : `本轮**无变化**（扫描 ${t.seen} 条，全部与上一轮一致）。`);
  } else {
    L.push('| 变化 | 条数 |');
    L.push('|---|---|');
    L.push(`| 🆕 新增 | ${t.added} |`);
    L.push(`| ✏️ 有更新 | ${t.updated} |`);
    L.push(`| ✅ 关闭/合并 | ${t.closed} |`);
    L.push(`| 🔄 重新打开 | ${t.reopened} |`);
    L.push(`| ➖ 无变化（未列出） | ${t.unchanged} |`);
  }
  L.push('');

  // ---- 待回应（启发式） ----
  const owner = repos.map((r) => r.split('/')[0].toLowerCase());
  const needsReply = delta.added.filter((it) => it.kind === 'issue' && it.state === 'open'
    && it.author && !owner.includes(String(it.author).toLowerCase()) && !it.authorIsBot);
  const newComments = delta.added.filter((it) => it.kind === 'issue_comment' || it.kind === 'pr_review_comment');
  if (needsReply.length || newComments.length) {
    L.push(H('可能需要我回应'));
    L.push('');
    L.push('> 启发式判定，仅供排序参考，不代表真的没人管。');
    L.push('');
    for (const it of needsReply) {
      L.push(`- 🆕 外部新开 issue ${it.url ? `[#${it.number}](${it.url})` : `#${it.number}`} **${cell(it.title)}** — @${it.author}，${ageDays(it.createdAt, nowMs)} 天前`);
    }
    for (const it of newComments) {
      const where = it.parentTitle ? `「${cell(it.parentTitle)}」` : `${it.parentKey || '?'}`;
      const who = it.author ? `@${it.author}` : '(未知作者)';
      L.push(`- 💬 ${who} 在 ${where} ${it.url ? `[${it.parentKey}](${it.url})` : ''} 留言（${fmtLocal(it.createdAt)}）`);
    }
    L.push('');
  }

  // ---- 明细 ----
  const sections = [
    ['新增', delta.added],
    ['有更新', delta.updated],
    ['关闭 / 合并', delta.closed],
    ['重新打开', delta.reopened],
  ];
  const hasAny = sections.some(([, arr]) => arr.length);
  L.push(H('变化明细'));
  L.push('');
  if (!hasAny) {
    L.push('_(无)_');
    L.push('');
  } else {
    for (const [name, arr] of sections) {
      if (!arr.length) continue;
      L.push(`### ${name}（${arr.length}）`);
      L.push('');
      // 有条目（issue/PR）在前，评论在后，各自按更新时间降序
      const sorted = arr.slice().sort((a, b) => {
        const ap = (a.kind === 'issue' || a.kind === 'pr') ? 0 : 1;
        const bp = (b.kind === 'issue' || b.kind === 'pr') ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
      });
      for (const it of sorted) {
        const r = renderItem(it, { maxBody, redactOn });
        redactedHits += r.redactedHits;
        L.push(r.text);
      }
    }
  }

  // ---- 全部未关闭项 ----
  const openItems = [];
  for (const it of delta.unchanged) {
    if ((it.kind === 'issue' || it.kind === 'pr') && (it.state === 'open' || it.state === 'draft')) openItems.push(it);
  }
  if (openItems.length) {
    L.push(H('仍未关闭的条目'));
    L.push('');
    L.push('| 编号 | 类型 | 标题 | 作者 | 最后更新 | 评论 |');
    L.push('|---|---|---|---|---|---|');
    for (const it of openItems.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))) {
      L.push(`| [#${it.number}](${it.url}) | ${KIND_LABEL[it.kind]} | ${cell(it.title)} | ${cell(it.author)} | ${fmtDate(it.updatedAt)} | ${it.comments || 0} |`);
    }
    L.push('');
  }

  // ---- 采集健康 ----
  L.push(H('采集健康'));
  L.push('');
  if (collection && collection.perRepo) {
    L.push('| 仓库 | 条目 | issues | 评论 | PRs | PR review 评论 | reviews | 截断 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const p of collection.perRepo) {
      const s = p.stats || {};
      L.push(`| ${cell(p.repo)} | ${p.count} | ${s.issues || 0} | ${s.issueComments || 0} | ${s.prs || 0} | ${s.prReviewComments || 0} | ${s.prReviews || 0} | ${p.truncated ? '⚠️ 是' : '否'} |`);
    }
    L.push('');
  }
  if (truncated) {
    L.push('> ⚠️ **有条目因达到 `maxPages` 上限被截断** —— 报告可能不完整。调大 `github.collection.maxPages`。');
    L.push('');
  }
  if (errors.length) {
    L.push('### 采集错误');
    L.push('');
    L.push('| 来源 | 状态 | 错误 | 详情 |');
    L.push('|---|---|---|---|');
    for (const e of errors) {
      L.push(`| ${cell(e.source)}${e.repo ? ` @${cell(e.repo)}` : ''} | ${cell(e.status)} | ${cell(e.error)} | ${cell(e.detail)}${e.hint ? ` — ${cell(e.hint)}` : ''} |`);
    }
    L.push('');
  } else {
    L.push('无错误。');
    L.push('');
  }
  L.push(`_(报告由 dream-engine 的 github 采集器生成 · ${nowIso})_`);
  L.push('');

  return {
    markdown: L.join('\n'),
    redactedHits,
    stats: {
      ...t,
      errors: errors.length,
      truncated,
      openItems: openItems.length,
      needsReply: needsReply.length + newComments.length,
      redactedHits,
    },
  };
}

module.exports = {
  diffItems,
  snapshot,
  renderReport,
  renderItem,
  fmtLocal,
  fmtDate,
  cell,
  truncateBody,
  KIND_LABEL,
  STATE_LABEL,
};
