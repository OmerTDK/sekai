// Resumes a Claude Code session in a brand-new macOS Terminal window.
//
// Zero npm dependencies: node:fs, node:path, node:os, node:child_process
// only. POST /api/resume with JSON {id, project}; on success a new Terminal
// window is opened running `claude --resume <id>` in `<project>`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ID_PATTERN = /^[a-f0-9-]{8,64}$/i;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Pure validation, no I/O side effects beyond reading directory metadata —
// safe to unit test without spawning anything.
//
// - id must look like a session uuid/hex id (regex-clean: no shell/AppleScript
//   metacharacters are possible once this passes).
// - project must resolve to an existing directory inside the caller's home
//   directory (blocks both nonexistent paths and traversal outside $HOME).
export function validateResumeInput(body) {
  const { id, project } = body && typeof body === 'object' ? body : {};

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { error: 'invalid id' };
  }
  if (typeof project !== 'string' || !project) {
    return { error: 'invalid project' };
  }

  const resolved = path.resolve(project);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { error: 'project must be an existing directory' };
  }

  const home = path.resolve(os.homedir());
  const rel = path.relative(home, resolved);
  const insideHome = rel === '' || (!rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  if (!insideHome) {
    return { error: 'project must be inside the home directory' };
  }

  return { id, project: resolved };
}

// Escapes `value` for safe embedding inside a single-quoted POSIX shell
// argument: close the quote, emit a literal escaped quote, reopen the quote.
// e.g. O'Brien -> 'O'\''Brien'
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Escapes `value` for safe embedding inside an AppleScript double-quoted
// string literal: backslashes and double quotes must themselves be escaped.
function appleScriptQuote(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Builds the AppleScript that opens a new Terminal window and runs the
// resume command in it. `id` is already regex-validated (hex/dashes only,
// so it needs no escaping of its own); `project` gets shell-quoted first
// (it's about to run inside a shell command string), and the resulting
// command string is then AppleScript-quoted (it's about to sit inside an
// AppleScript string literal). `do script` with no target window always
// opens a brand-new window.
function buildResumeScript(id, project) {
  const shellCommand = `cd ${shellQuote(project)} && claude --resume ${id}`;
  const quotedCommand = appleScriptQuote(shellCommand);
  return [
    'tell application "Terminal" to activate',
    `tell application "Terminal" to do script "${quotedCommand}"`,
  ].join('\n');
}

export async function handleResume(req, res) {
  res.setHeader('content-type', 'application/json');

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }

  const validated = validateResumeInput(body);
  if (validated.error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: validated.error }));
    return;
  }

  const script = buildResumeScript(validated.id, validated.project);

  // NEVER build a shell string with interpolated input: execFile runs
  // osascript directly (no shell), with the script passed as a single argv
  // entry, so nothing here is shell-interpreted.
  execFile('osascript', ['-e', script], (err) => {
    // This fires once osascript has told Terminal to open the new window and
    // dispatch the command — it does NOT wait for the resumed `claude`
    // session itself to finish, so this is still "fast" from the caller's
    // perspective.
    if (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
}
