'use strict';
/**
 * gitops.cjs —— 内容目录 git 化（对应 V2 §8.4 与 P0 "memory/ 与 .dream/global/ git 化"）。
 * 只用 execFileSync 调 git，不引入依赖。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_IDENT = ['-c', 'user.name=AutoDream', '-c', 'user.email=autodream@localhost'];

function git(args, cwd, { allowFail = false } = {}) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    if (!allowFail) throw e;
    return { ok: false, out: String(out).trim(), code: e.status, error: e.message };
  }
}

function isRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

/** 向上查找是否存在父级仓库（避免嵌套 repo 造成混乱） */
function hasParentRepo(dir) {
  let cur = path.resolve(dir);
  const root = path.parse(cur).root;
  cur = path.dirname(cur);
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (cur === root || parent === cur) return null;
    cur = parent;
  }
}

const GITIGNORE = [
  '# AutoDream: 忽略运行时噪声，只版本化内容',
  '*.tmp',
  '*.tmp.*',
  '.consolidate-lock',
  '',
].join('\n');

/** 初始化仓库并做首次提交；已存在则跳过 */
function initRepo(dir, { message = 'chore(dream): initial import before AutoDream P0' } = {}) {
  if (!fs.existsSync(dir)) return { ok: false, reason: 'dir-not-found', dir };
  if (isRepo(dir)) return { ok: true, reason: 'already-repo', dir };

  const parent = hasParentRepo(dir);
  if (parent) return { ok: false, reason: 'inside-parent-repo', dir, parent };

  git(['init', '-q'], dir);
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE, 'utf8');
  git(['add', '-A'], dir);
  const st = git(['status', '--porcelain'], dir, { allowFail: true });
  if (!st.out) return { ok: true, reason: 'repo-empty-nothing-to-commit', dir };
  git([...GIT_IDENT, 'commit', '-q', '-m', message], dir);
  return { ok: true, reason: 'initialized', dir };
}

function lastCommit(dir) {
  if (!isRepo(dir)) return null;
  const r = git(['log', '-1', '--pretty=%h %ad %s', '--date=short'], dir, { allowFail: true });
  return r.ok ? r.out : null;
}

function dirtyCount(dir) {
  if (!isRepo(dir)) return null;
  const r = git(['status', '--porcelain'], dir, { allowFail: true });
  if (!r.ok) return null;
  return r.out ? r.out.split('\n').filter(Boolean).length : 0;
}

function commitAll(dir, message) {
  if (!isRepo(dir)) return { ok: false, reason: 'not-a-repo', dir };
  git(['add', '-A'], dir);
  const st = git(['status', '--porcelain'], dir, { allowFail: true });
  if (!st.out) return { ok: true, reason: 'clean', dir };
  git([...GIT_IDENT, 'commit', '-q', '-m', message], dir);
  return { ok: true, reason: 'committed', dir, commit: lastCommit(dir) };
}

/**
 * ★ 路径限定提交（2026-10-01 新增）。
 *
 * ── 为什么不能直接用 `commitAll` ────────────────────────────────────────
 * `commitAll` 是 `git add -A`，会把**工作区里所有**改动一并提交。而项目记忆目录
 * （`projects/<slug>/memory/`）是**宿主与本插件共用**的：
 * Claude Code 自己的记忆写入（frontmatter 只有 `node_type`/`type`/`originSessionId`，
 * **没有**我们的 `dream:` 块）也落在同一个目录里，且它**不做 git 管理**。
 * 用 `commitAll` 会把宿主的未跟踪文件卷进一个 `dream(...)` 提交 —— 等于把
 * 别人的写入记到本插件名下，污染记忆变更的可追溯性。
 *
 * ⇒ 只暂存调用方**明确指定**的路径。`add -A` 与 `add -- <paths>` 的区别就是本函数的全部意义。
 *
 * @param {string} dir        仓库目录
 * @param {string[]} paths    要提交的相对路径（相对 dir）
 * @param {string} message    commit message
 * @returns {{ok, reason, dir, staged?, extra?, commit?}}
 *   `extra` = 暂存区里**不属于**本次指定路径的文件（正常应为空；非空说明调用前
 *   暂存区就不干净，如实报出而不是假装没发生）。
 */
function commitPaths(dir, paths, message) {
  if (!isRepo(dir)) return { ok: false, reason: 'not-a-repo', dir };
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return { ok: false, reason: 'no-paths', dir };

  const add = git(['add', '--', ...list], dir, { allowFail: true });
  if (!add.ok) return { ok: false, reason: 'add-failed', dir, error: add.out || add.error };

  // 暂存区现有内容（含**调用前就已暂存**的东西）
  const stagedOut = git(['diff', '--cached', '--name-only'], dir, { allowFail: true });
  const staged = (stagedOut.out || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!staged.length) return { ok: true, reason: 'clean', dir, staged: [] };

  const norm = (s) => s.replace(/\\/g, '/');
  const wanted = new Set(list.map(norm));
  const extra = staged.filter((s) => !wanted.has(norm(s)));

  git([...GIT_IDENT, 'commit', '-q', '-m', message], dir);
  return { ok: true, reason: 'committed', dir, staged, extra, commit: lastCommit(dir) };
}

module.exports = { git, isRepo, hasParentRepo, initRepo, lastCommit, dirtyCount, commitAll, commitPaths, GIT_IDENT };
