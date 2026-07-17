// Scans Claude Code's session transcripts (~/.claude/projects/**/*.jsonl) and
// reports every non-trivial session as plain data, so a 3D planet app can
// render each session as a building.
//
// Zero npm dependencies: node:fs, node:path, node:os only. Called on every
// dev-server poll (~4s), so repeated calls must be cheap — see the in-memory
// cache below.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HEAD_BYTES = 256 * 1024; // only read the first 256KB of each file
const TAIL_BYTES = 64 * 1024; // only read the last 64KB when probing for live activity
const MIN_BYTES = 1500; // sessions smaller than this are aborted/noise
const MAX_TOPIC_CHARS = 80;
const MAX_ACTION_CHARS = 60;
const MAX_SUBAGENTS = 20; // count is capped/approximate, see extractTailActivity
const MAX_RESULTS = 250;
const RECENT_WINDOW_MS = 30 * 60 * 1000; // always keep sessions active in the last 30min
const LAST_ACTION_WINDOW_MS = 10 * 60 * 1000; // lastAction/subagents only computed for sessions active in the last 10min

// Cache keyed by absolute file path: { size, topic, project, resolved,
// tailSize, lastAction, subagents }
// Once topic+project are both found they never change for a given file, so
// we never re-read its content again (stat only). Otherwise we only re-read
// when the file's size has changed since the last attempt. The tail-derived
// fields (tailSize/lastAction/subagents) are a separate cheap layer on top:
// they're only (re)computed for sessions currently inside the "active"
// window, and only when the file's size changed since they were last
// computed — see extractTailActivity and its call site below.
const fileCache = new Map();

function formatTopic(raw) {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (!collapsed) return null;
  return collapsed.length > MAX_TOPIC_CHARS ? collapsed.slice(0, MAX_TOPIC_CHARS) : collapsed;
}

function extractUserText(message) {
  if (!message || typeof message !== 'object') return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
    }
  }
  return null;
}

function realUserTopic(message) {
  const raw = extractUserText(message);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('Caveat:')) return null;
  if (trimmed.startsWith('Base directory for')) return null; // skill-invocation preamble
  return formatTopic(trimmed);
}

// Fallback project path: decode a munged project-dir name (e.g.
// "-Users-omertdk-Cloover-cloover-dbt") by turning every separator back into
// a slash. Imperfect for hyphenated real names, fine as a last resort.
function decodeDirName(dirName) {
  return dirName.replace(/-/g, '/');
}

function readHead(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(maxBytes, size);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

// Reads (at most) the first HEAD_BYTES of a session file and extracts the
// topic (per TOPIC RULES) and project cwd. Tolerates anything: unparseable
// lines/files never throw, they're just skipped.
function extractTopicAndProject(filePath) {
  let text;
  try {
    text = readHead(filePath, HEAD_BYTES);
  } catch {
    return { topic: null, project: null };
  }

  let summaryTopic = null;
  let userTopic = null;
  let project = null;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    if (project == null && typeof obj.cwd === 'string' && obj.cwd) {
      project = obj.cwd;
    }

    // Rule 1 sources: legacy {type:'summary'} lines and the {type:'ai-title'}
    // lines current Claude Code emits.
    if (summaryTopic == null && (obj.type === 'summary' || obj.type === 'ai-title')) {
      const t = formatTopic(obj.type === 'summary' ? obj.summary : obj.aiTitle);
      if (t) summaryTopic = t;
    } else if (summaryTopic == null && userTopic == null && obj.type === 'user' && !obj.isSidechain) {
      const t = realUserTopic(obj.message);
      if (t) userTopic = t;
    }

    // Rule 1 always wins over rule 2, so once we have a summary topic and a
    // project we can stop scanning early. Otherwise keep going in case a
    // (higher-priority) summary line shows up later, or cwd is still missing.
    if (summaryTopic != null && project != null) break;
  }

  return { topic: summaryTopic ?? userTopic, project };
}

function clampAction(raw) {
  const collapsed = String(raw).replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ACTION_CHARS ? collapsed.slice(0, MAX_ACTION_CHARS) : collapsed;
}

// Compact extract from a tool_use input: prefer a file path's basename, then
// a command's first ~40 chars, then a description field — whatever exists.
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.file_path === 'string' && input.file_path) return path.basename(input.file_path);
  if (typeof input.command === 'string' && input.command) return input.command.slice(0, 40);
  if (typeof input.description === 'string' && input.description) return input.description;
  return null;
}

function readTail(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(maxBytes, size);
    if (len <= 0) return { text: '', truncated: false };
    const start = size - len;
    const buf = Buffer.alloc(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8', 0, bytesRead), truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

// Walks the tail lines backward looking for the most recent meaningful
// assistant activity: an assistant tool_use wins over a plain text part, and
// lines with neither (e.g. thinking-only) are skipped in favor of an earlier
// line.
function findLastAction(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || obj.type !== 'assistant') continue;
    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;

    let toolUse = null;
    let text = null;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (toolUse == null && part.type === 'tool_use') toolUse = part;
      else if (text == null && part.type === 'text' && typeof part.text === 'string') text = part;
    }

    if (toolUse) {
      const name = typeof toolUse.name === 'string' && toolUse.name ? toolUse.name : 'tool';
      const summary = summarizeToolInput(toolUse.input);
      return clampAction(summary ? `⚒ ${name}: ${summary}` : `⚒ ${name}`);
    }
    if (text) return clampAction(text.text.slice(0, 48));
  }
  return null;
}

// Approximate: a plain substring count over raw lines rather than a JSON
// parse, so it's cheap even on a 64KB tail; can overcount if the literal
// string appears somewhere other than the isSidechain key (rare in practice).
function countSubagents(lines) {
  let count = 0;
  for (const line of lines) {
    if (line.includes('"isSidechain":true')) {
      count++;
      if (count >= MAX_SUBAGENTS) return MAX_SUBAGENTS;
    }
  }
  return count;
}

// Reads the last TAIL_BYTES of the file once and derives both lastAction and
// subagents from it. Never throws: unreadable/unparseable content just
// yields nulls/zero.
function extractTailActivity(filePath) {
  let tail;
  try {
    tail = readTail(filePath, TAIL_BYTES);
  } catch {
    return { lastAction: null, subagents: 0 };
  }
  const lines = tail.text.split('\n');
  if (tail.truncated) lines.shift(); // we started mid-file: first line is a partial line
  return {
    lastAction: findLastAction(lines),
    subagents: countSubagents(lines),
  };
}

export async function scanSessions(root = path.join(os.homedir(), '.claude', 'projects')) {
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const now = Date.now();
  const sessions = [];

  for (const dirent of dirEntries) {
    if (!dirent.isDirectory()) continue;
    const dirPath = path.join(root, dirent.name);

    let files;
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, fileName);

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      let cached = fileCache.get(filePath);
      if (!cached || (!cached.resolved && cached.size !== stat.size)) {
        const { topic, project } = extractTopicAndProject(filePath);
        cached = {
          size: stat.size,
          topic,
          project,
          resolved: topic != null && project != null,
        };
        fileCache.set(filePath, cached);
      }

      if (cached.topic == null) continue; // no usable topic: excluded
      if (stat.size < MIN_BYTES) continue; // too small: aborted/noise

      // lastAction/subagents are only meaningful (and only ever computed —
      // no tail read at all otherwise) for sessions active in the last 10min;
      // `age >= 0` also guards against a future mtime (clock skew) being
      // misread as "recent".
      const age = now - stat.mtimeMs;
      const isRecentlyActive = age >= 0 && age <= LAST_ACTION_WINDOW_MS;

      let lastAction = null;
      let subagents = 0;
      if (isRecentlyActive) {
        if (cached.tailSize !== stat.size) {
          const activity = extractTailActivity(filePath);
          cached.tailSize = stat.size;
          cached.lastAction = activity.lastAction;
          cached.subagents = activity.subagents;
        }
        lastAction = cached.lastAction;
        subagents = cached.subagents;
      }

      sessions.push({
        id: path.basename(fileName, '.jsonl'),
        project: cached.project || decodeDirName(dirent.name),
        topic: cached.topic,
        lastActive: stat.mtimeMs,
        bytes: stat.size,
        lastAction,
        subagents,
      });
    }
  }

  sessions.sort((a, b) => b.lastActive - a.lastActive);

  if (sessions.length <= MAX_RESULTS) return sessions;

  const cutoff = now - RECENT_WINDOW_MS;
  const head = sessions.slice(0, MAX_RESULTS);
  const extra = [];
  for (let i = MAX_RESULTS; i < sessions.length; i++) {
    // sessions is sorted desc, so once we drop below the cutoff every
    // subsequent session is also below it.
    if (sessions[i].lastActive >= cutoff) extra.push(sessions[i]);
    else break;
  }
  return head.concat(extra);
}
