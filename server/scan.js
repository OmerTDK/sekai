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
const MIN_BYTES = 1500; // sessions smaller than this are aborted/noise
const MAX_TOPIC_CHARS = 80;
const MAX_RESULTS = 250;
const RECENT_WINDOW_MS = 30 * 60 * 1000; // always keep sessions active in the last 30min

// Cache keyed by absolute file path: { size, topic, project, resolved }
// Once topic+project are both found they never change for a given file, so
// we never re-read its content again (stat only). Otherwise we only re-read
// when the file's size has changed since the last attempt.
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

      sessions.push({
        id: path.basename(fileName, '.jsonl'),
        project: cached.project || decodeDirName(dirent.name),
        topic: cached.topic,
        lastActive: stat.mtimeMs,
        bytes: stat.size,
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
