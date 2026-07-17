// Polls git + GitHub for "charm" events (commits, merged PRs) on projects
// that currently have an active Claude Code session, so the planet can throw
// fireworks / plant monuments in near-real-time without ever shelling out to
// git for settlements nobody is working in right now.
//
// Zero npm dependencies: node:child_process (execFile — argv arrays only,
// NEVER a shell string) plus this repo's own scan.js for the active-project
// set. Called on a ~60s client poll (see main.js), so — like scan.js — the
// in-memory cache below is what keeps repeated calls cheap and safe.

import { execFile } from 'node:child_process'
import { scanSessions } from './scan.js'

// Mirrors scan.js's LAST_ACTION_WINDOW_MS (kept as its own constant rather
// than importing scan.js's private one — see scan.test.js's own local
// MIN_BYTES for the same "small threshold constants get duplicated, not
// exported" convention already used in this codebase). A project is only
// polled if one of its sessions has been active this recently — the plan's
// "don't hammer git for idle settlements" rule.
const ACTIVE_WINDOW_MS = 10 * 60 * 1000

// Hard floor between real git/gh invocations, per project, no matter how
// often gitEvents() itself is called.
const MIN_POLL_INTERVAL_MS = 60 * 1000

// The first time a project is seen there is no "last poll" to diff against;
// look back this far so the very first poll can still surface genuinely
// recent activity, without replaying a project's entire history.
const BOOTSTRAP_LOOKBACK_MS = ACTIVE_WINDOW_MS

const GH_PR_LIMIT = 3
const MAX_TITLE_CHARS = 60
const GIT_TIMEOUT_MS = 5000
const GH_TIMEOUT_MS = 5000
const MAX_BUFFER = 1024 * 1024

// Per-project state, keyed by project path: { lastInvoke, commitSince,
// prSince, seenCommits, seenPrs, githubRepo }. `githubRepo` is `undefined`
// until first detected, then either an "owner/repo" string or `null`
// (confirmed: no GitHub remote) — checked once per project, not every poll.
const projectState = new Map()

let warnedGitLog = false
function warnGitLog(reason) {
  if (warnedGitLog) return
  warnedGitLog = true
  console.warn('[planet] gitinfo.js: commit polling degraded for one or more projects — ' + reason)
}

let warnedGh = false
function warnGh(reason) {
  if (warnedGh) return
  warnedGh = true
  console.warn('[planet] gitinfo.js: PR-merge polling degraded — ' + reason)
}

// Same truncation convention as scan.js's formatTopic/clampAction: trim +
// collapse whitespace + hard slice — no ellipsis.
function truncateTitle(raw) {
  const collapsed = String(raw == null ? '' : raw)
    .trim()
    .replace(/\s+/g, ' ')
  return collapsed.length > MAX_TITLE_CHARS ? collapsed.slice(0, MAX_TITLE_CHARS) : collapsed
}

function execFileText(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function getState(project) {
  let st = projectState.get(project)
  if (!st) {
    const bootTs = Date.now() - BOOTSTRAP_LOOKBACK_MS
    st = {
      lastInvoke: 0,
      commitSince: bootTs,
      prSince: bootTs,
      seenCommits: new Set(),
      seenPrs: new Set(),
      githubRepo: undefined,
    }
    projectState.set(project, st)
  }
  return st
}

// Extracts "owner/repo" from a GitHub remote URL — SSH
// (git@github.com:owner/repo.git) or HTTPS (https://github.com/owner/repo),
// .git suffix optional. Returns null if it isn't a GitHub URL at all.
function parseGithubRepo(remoteUrl) {
  const m = /github\.com[:/]([^/\s]+)\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())
  return m ? m[1] + '/' + m[2] : null
}

async function detectGithubRepo(project) {
  let url
  try {
    url = await execFileText('git', ['-C', project, 'remote', 'get-url', 'origin'], GIT_TIMEOUT_MS)
  } catch {
    return null // no `origin` remote (or not a git repo at all) — not an error, just not a GitHub project
  }
  return parseGithubRepo(url)
}

// Parses one `git log --pretty=%H|%ct|%s` line. Splits on only the first two
// '|' so a commit subject that happens to contain a literal pipe survives
// intact rather than truncating the title.
function parseCommitLine(line) {
  const idx1 = line.indexOf('|')
  const idx2 = idx1 === -1 ? -1 : line.indexOf('|', idx1 + 1)
  if (idx1 === -1 || idx2 === -1) return null
  const hash = line.slice(0, idx1)
  const ctSeconds = Number(line.slice(idx1 + 1, idx2))
  if (!hash || !Number.isFinite(ctSeconds)) return null
  return { hash, ts: ctSeconds * 1000, subject: line.slice(idx2 + 1) }
}

async function pollCommits(project, state, out) {
  let stdout
  try {
    stdout = await execFileText(
      'git',
      ['-C', project, 'log', '--since=' + new Date(state.commitSince).toISOString(), '--pretty=%H|%ct|%s'],
      GIT_TIMEOUT_MS,
    )
  } catch (e) {
    warnGitLog(e && e.message ? e.message : String(e))
    return
  }

  let maxTs = state.commitSince
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const parsed = parseCommitLine(line)
    if (!parsed) continue
    if (parsed.ts > maxTs) maxTs = parsed.ts
    if (state.seenCommits.has(parsed.hash)) continue
    state.seenCommits.add(parsed.hash)
    out.push({
      project,
      kind: 'commit',
      id: parsed.hash,
      ts: parsed.ts,
      title: truncateTitle(parsed.subject),
    })
  }
  state.commitSince = maxTs
}

async function pollPrs(project, state, out) {
  if (state.githubRepo === undefined) {
    state.githubRepo = await detectGithubRepo(project)
  }
  if (!state.githubRepo) {
    warnGh(
      'no GitHub remote on one or more active projects (or `git remote` unavailable) — PR-merge events skipped for it',
    )
    return
  }

  let stdout
  try {
    stdout = await execFileText(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        state.githubRepo,
        '--state',
        'merged',
        '--limit',
        String(GH_PR_LIMIT),
        '--json',
        'number,mergedAt,title',
      ],
      GH_TIMEOUT_MS,
    )
  } catch (e) {
    warnGh('`gh pr list` failed (missing/unauthenticated gh?) — ' + (e && e.message ? e.message : String(e)))
    return
  }

  let list
  try {
    list = JSON.parse(stdout)
  } catch (e) {
    warnGh('`gh pr list` returned unparseable JSON — ' + e)
    return
  }
  if (!Array.isArray(list)) return

  let maxTs = state.prSince
  for (const pr of list) {
    if (!pr || typeof pr.number !== 'number' || typeof pr.mergedAt !== 'string') continue
    const ts = Date.parse(pr.mergedAt)
    if (!Number.isFinite(ts)) continue
    if (ts > maxTs) maxTs = ts
    if (ts <= state.prSince) continue
    const id = state.githubRepo + '#' + pr.number
    if (state.seenPrs.has(id)) continue
    state.seenPrs.add(id)
    out.push({ project, kind: 'pr-merged', id, ts, title: truncateTitle(pr.title) })
  }
  state.prSince = maxTs
}

export async function gitEvents() {
  let sessions
  try {
    sessions = await scanSessions()
  } catch {
    return []
  }
  if (!Array.isArray(sessions)) return []

  const now = Date.now()
  const activeProjects = new Set()
  for (const s of sessions) {
    if (!s || typeof s.project !== 'string' || !s.project) continue
    if (!Number.isFinite(s.lastActive)) continue
    const age = now - s.lastActive
    if (age >= 0 && age <= ACTIVE_WINDOW_MS) activeProjects.add(s.project)
  }

  // Polled concurrently across projects — a real dev machine can easily have
  // a dozen+ active worktrees at once, and this is a background poll: total
  // latency should track the slowest single project, not their sum.
  const perProject = await Promise.all(
    Array.from(activeProjects, async (project) => {
      const out = []
      try {
        const state = getState(project)
        if (now - state.lastInvoke < MIN_POLL_INTERVAL_MS) return out // cache: too soon since our last real invocation
        state.lastInvoke = now
        await pollCommits(project, state, out)
        await pollPrs(project, state, out)
      } catch (e) {
        // Never let one misbehaving project break the whole poll.
        warnGitLog('unexpected error polling ' + project + ': ' + e)
      }
      return out
    }),
  )

  const events = perProject.flat()
  events.sort((a, b) => a.ts - b.ts)
  return events
}
