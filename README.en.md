# dream-engine

> A **self-hosted** memory consolidation engine for coding agents —
> session transcripts → candidate extraction → external scoring → threshold decisions → writes into a controlled memory store.
> Inspired by Claude Code's AutoDream behaviour. **Independent implementation**; contains and depends on none of its source.

**Zero runtime dependencies** (engine: Node ≥ 18; DSH session reading: Node ≥ 24).
Both host adapters share **one single engine**.

English | [中文](README.md)

---

## The problem it solves

Coding agents produce a lot of *judgements worth remembering* — the root cause of a trap,
a convention, an environment fact. All of it scatters across sessions.
This engine mechanically extracts, scores and (above a threshold) settles that material into a memory store,
so the next session can read what the previous one concluded.

The key trade-off: **the engine contains no LLM client**.
Semantic judgement is delegated to a replaceable **external scoring service**.
The engine only decides *what deserves remembering, whether it qualifies, and how to write it in*.

---

## Architecture

```
host session
  │
  ├─ event layer (host-driven)   SessionStart / Stop / SessionEnd
  │     → ultra-thin forward → POST /event (append + cheap verdict; returns in ms, never blocks the session)
  │
  └─ command layer (model-visible)   /dream  /dream-status
        → engine mechanically collects leads → restricted subagent drafts a proposal
        → engine validates → user confirms → written to disk
  │
  ▼
resident daemon (127.0.0.1; loopback-only + Host allow-list + token)
  ├─ harvest     read host transcripts → candidates (no network)
  ├─ score       the single egress point, forced redaction
  ├─ decide      two-tier thresholds + multiple gates (known / fragment / dead-zone / confidence …)
  ├─ write       controlled blocks only + one git commit per change
  └─ auto-dream  event → debounce → gates → run one round asynchronously
                 (single-flight, rate-limited, fully switchable)
```

| Path | What it is |
|---|---|
| `dream-plugin/` | **The engine** (the bulk of this repo). Zero-dependency CJS: CLI, daemon, harvest/score/decide/write |
| `dream-plugin/hooks/`, `commands/`, `agents/` | **Claude Code host adapter** (hook declarations, slash commands, restricted subagent) |
| `dsh-dream-plugin/` | **DeepSeek Harness (Cordis) host adapter**. Per-frame zstd session reading, automatic slug index |

There is exactly one engine; each host attaches a thin adapter.
Adapters own *how the host's sessions are read, how events arrive, how a session maps to a project* —
**the engine does not know hosts exist**.

---

# Installing on Claude Code

## Prerequisites

- **Node.js ≥ 18** (`node --version`; the DSH adapter additionally needs ≥ 24)
- Claude Code installed (`claude --version` works)
- Optional: a compatible scoring-service endpoint and credential.
  **You can install without one** — harvest and extraction work; only the scoring step will fail

## Option A — install as a plugin (recommended)

The repo root ships `.claude-plugin/marketplace.json`, so **a local directory is a valid marketplace**.

```bash
# 1) get the repo (anywhere you like)
git clone <this-repo> dream-engine

# 2) register the repo root as a marketplace (source accepts a URL, a path, or a GitHub repo)
claude plugin marketplace add /path/to/dream-engine

# 3) install the plugin (plugin name is autodream)
claude plugin install autodream@dream-engine
```

The three events declared in `dream-plugin/hooks/hooks.json`
(`SessionStart` / `Stop` / `SessionEnd`) are then wired automatically, and `commands/` plus `agents/`
are discovered automatically — **no manual `settings.json` editing**.

> **What was actually verified** (by the author, on Windows + Claude Code):
> - `marketplace add` accepts a **local directory path** and records it as
>   `source: {"source":"directory","path":"…"}`
> - You can confirm the plugin is discovered **without installing**:
>   ```bash
>   claude plugin list --available --json    # expect autodream@dream-engine
>   ```
>
> ⚠️ **If you previously installed via Option B (manual)**: remove those three manual hook entries
> from `settings.json` **before** switching to the plugin route — otherwise every event fires twice.

```bash
# 4) ★ install the engine runtime (the plugin only wires things up; the engine lands separately)
cd /path/to/dream-engine/dream-plugin
node src/cli.cjs install    # copy modules to ~/.claude/.dream/bin/
node src/cli.cjs init       # dirs / token / state / config + scan projects + git-ify content dirs
```

> **Why step 4?** The plugin's hook is only a **thin forwarder** (returns in milliseconds, never blocks the session).
> The actual engine is a resident process plus a token and state files, and must live in `~/.claude/.dream/`.
> This step is idempotent — re-run it after upgrading the engine.

```bash
# 5) verify
claude            # start a new session
/dream-status     # expect: engine online, write policy, counters, auto-dream switch
```

## Option B — manual install (no marketplace)

For when you want full control over where things land, or prefer not to register a marketplace.

```bash
cd /path/to/dream-engine/dream-plugin

# 1) engine runtime
node src/cli.cjs install
node src/cli.cjs init

# 2) commands and subagent: drop them into the host's discovery paths
#    (macOS / Linux)
cp commands/dream.md ~/.claude/commands/
cp commands/dream-status.md ~/.claude/commands/
mkdir -p ~/.claude/agents && cp agents/dream-merge.md ~/.claude/agents/
#    Windows PowerShell: replace ~/.claude with $env:USERPROFILE\.claude
```

Then add three entries to `hooks` in `~/.claude/settings.json`
(**merge into the existing `hooks` object; do not overwrite it**):

```jsonc
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [
      { "type": "command",
        "command": "node \"<HOME>/.claude/.dream/bin/hook.cjs\" SessionStart",
        "timeout": 10 }
    ]}],
    "Stop": [{ "matcher": "", "hooks": [
      { "type": "command",
        "command": "node \"<HOME>/.claude/.dream/bin/hook.cjs\" Stop",
        "timeout": 3 }
    ]}],
    "SessionEnd": [{ "matcher": "", "hooks": [
      { "type": "command",
        "command": "node \"<HOME>/.claude/.dream/bin/hook.cjs\" SessionEnd",
        "timeout": 3 }
    ]}]
  }
}
```

> On Windows `<HOME>` looks like `C:/Users/you`. **Use forward slashes or doubled backslashes**,
> and quote the path with `\"` inside JSON.
> The manual route **must** use absolute paths — `${CLAUDE_PLUGIN_ROOT}` is only substituted
> when installed as a plugin.

## Wiring up the scoring service (optional, required for auto-dream)

```bash
node src/cli.cjs config set jev.endpoint=https://your-scorer.example/api
node src/cli.cjs config set jev.keySource=settings:YOUR_API_KEY
```

### 🔑 Credential-source rule (**every key/token is read from the host's `settings.json`**)

**This is a hard rule, not a suggestion:**

| Item | Rule |
|---|---|
| **Single source** | The host's `settings.json` → its `env.<NAME>` section. The host home comes from `DREAM_CLAUDE_HOME`, defaulting to `~/.claude` |
| **How it is declared** | `jev.keySource = "settings:<ENV_NAME>"`. The default is already `settings:TYPESAFE_API_KEY` |
| **Never persisted** | The engine does **not** write credentials into `config.json`, `state.json`, logs, audit files or round records |
| **Never egressed raw** | There is exactly one `fetch` call site; payloads are force-redacted (`egress: "redacted"`, on by default) and credential shapes become `[REDACTED:…]` |
| **Never logged** | The same redaction applies to logs and error messages, so failures never carry the credential out |

```jsonc
// ~/.claude/settings.json — put the credential here, nowhere else
{
  "env": {
    "TYPESAFE_API_KEY": "<your-key>"
  }
}
```

> **This repository's own code follows the same rule**: any maintenance or diagnostic script that needs
> that credential reads it **from `settings.json` at runtime** — never hardcoded, never taken from an
> environment variable. That avoids the trap of *a leak-detection tool that itself carries the key*.

**The one explicit exception**: `jev.keySource = "env:<NAME>"` reads from a **process environment
variable** instead. It is **not the default** and exists only for setups without a `settings.json`
(CI, for instance). **Do not use it without a concrete reason** — environment variables leak more
easily through process listings, log collectors and inherited child processes.

## Defaults after install

| Item | Default | Meaning |
|---|---|---|
| Engine | running | a hook cold-starts the daemon |
| **auto-dream** | **off** | it will not call out or write memory on its own |
| **write policy** | `audit` | scores and produces candidates, **writes no memory** |
| manual dream | available | `/dream` always works; it shows you a diff and asks for confirmation before writing |

```bash
# observe only (recommended to start)
node src/cli.cjs config set mode=audit
# allow memory writes
node src/cli.cjs config set mode=active
# enable auto-dream (it will call the scorer and write memory — enable only once you are sure)
node src/cli.cjs config set autoDream.enabled=true
# stop everything at once
node src/cli.cjs config set autoDream.enabled=false
node src/cli.cjs stop
```

## Day-to-day

```bash
# inside a session
/dream            # manual dream: collect leads → proposal → validate → show diff → you confirm → write
/dream --dry      # show only, write nothing
/dream-status     # engine / write policy / counters / auto-dream switch and "would it run now"

# from the shell
node src/cli.cjs status              # gates / lock / engine
node src/cli.cjs auto                # auto-dream: switch, unconsumed events, last result, **would it run now and why**
node src/cli.cjs guard               # write policy + conflict check against the official AutoDream
node src/cli.cjs config diff         # config health (drift + orphan keys)
```

## GitHub digest (optional, **off by default**)

Beyond consolidating session memory, the engine can collect repository activity:
issues, issue comments, pull requests, PR reviews and review comments — diffed against
the previous local snapshot so only the **delta** is reported, rendered as a Markdown digest.

```bash
node src/cli.cjs github doctor       # health: gh / credential / API reachability / repo access / report dir
node src/cli.cjs github now          # collect once now (bypasses the built-in daily gate)
node src/cli.cjs github now --dry    # dry run: writes no file, advances no cursor
node src/cli.cjs github run          # run subject to the built-in daily gate (for a system scheduler)
node src/cli.cjs github status       # config + gate verdict + recent rounds
node src/cli.cjs github log          # structured per-round JSON log
```

**Scheduling is not part of the engine.** The engine does no system-level timing; use your
host's own scheduler (Windows Task Scheduler / cron / a DSH task board) to call `github run`
or `github now` — daily at 08:00 is a good default.

Main config (the `github` section of `~/.claude/.dream/config.json`):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Installing the plugin does not mean consenting to daily egress |
| `repos` | `[]` | Repositories to collect, `["owner/name", ...]` |
| `transport` | `"gh"` | `gh` or `rest` (see below) |
| `tokenSource` | `"gh"` | `gh` / `settings:NAME` / `env:NAME` |
| `report.dir` | `null` | Output directory; `null` → `<DREAM_HOME>/github-reports` |
| `report.writeUnchanged` | `true` | Whether to write a report on zero-change days too |
| `report.includeBodyChars` | `3000` | Per-item body render limit |
| `report.redactCredentials` | `true` | Redact report bodies (so a token someone pasted into an issue is not kept locally) |
| `collection.schedule` | `"08:00"` | Daily gate time (applies to `github run` only) |
| `collection.maxPages` | `5` | **Hard page cap** (see below) |

**About the transport**: the default is `gh` (GitHub CLI), which requires `gh auth login`.
That keeps the credential in the system keyring and **never lets it land in any file this plugin writes**.

> ⚠️ **Why not `fetch` by default**: if the machine redirects `api.github.com` to a local proxy
> via the hosts file (a common "GitHub accelerator" setup), Node's `fetch` fails with an
> untrusted certificate chain (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) while `gh` keeps working
> because it reads the system certificate store. Keep `transport: "gh"` on such machines;
> on a standard network you can switch to `rest` with `settings:GITHUB_TOKEN`.

> ⚠️ **Why a `maxPages` cap exists**: `gh api --paginate` has **no page limit** and can hang for
> a very long time on repositories with huge issue counts. The collector therefore pages
> manually under this cap and warns explicitly in the report when it truncates, instead of
> silently returning half the data.

## Uninstall / rollback

```bash
# plugin route
claude plugin disable autodream        # or uninstall
# manual route: remove the three command/agent files and the three hook entries in settings.json

# engine runtime
node src/cli.cjs stop
rm -rf ~/.claude/.dream     # global experiences + runtime state (token / state / candidates)
```

> ⚠️ **Project-level memory is NOT under `.dream`.** Each project's writes live in
> `~/.claude/projects/<slug>/memory/` — a **separate directory with its own git repo**;
> the `rm -rf` above does **not** touch them. To roll those back, use git in that directory:
> `git -C ~/.claude/projects/<slug>/memory log` / `git revert`.

---


## Design principles (non-negotiable)

1. **No LLM client in the engine** — semantic judgement is delegated to a replaceable scoring endpoint
2. **Exactly one engine** — hosts attach thin adapters; the engine does not know hosts exist
3. **A tiny model-visible surface** — status queries and manual triggering only; the scorer is never exposed
4. **Never guess** — if project attribution cannot be resolved, mark it unmapped and skip;
   never write into somebody else's memory directory
5. **Never block the host** — hooks return in milliseconds; all heavy work goes to the resident process
6. **Off by default, one switch to stop** — anything that spends money or mutates data ships disabled
7. **Failures leave a trace** — failed rounds, skip reasons and write rationales all go to logs

## License

MIT — see `LICENSE`.
