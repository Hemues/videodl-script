/**
 * Sandboxed challenge-solver host (child side).
 *
 * Entered via the hidden `__solve` subcommand, always as a child of the main videodl
 * process with Node's permission model enabled (see solver-sandbox.js). Everything it
 * needs arrives on stdin as one JSON document — `{ player, requests, solverCode }` —
 * so this process performs no filesystem access at all. It writes exactly one JSON
 * document to stdout and exits.
 *
 * Do not add logging to stdout here: the parent parses stdout as JSON.
 */

import fs from 'node:fs';

function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < buf.length) {
    try {
      written += fs.writeSync(fd, buf, written, buf.length - written);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      throw err;
    }
  }
}

export async function runSolverHost() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    writeAll(1, JSON.stringify({ type: 'error', error: `solver host: invalid input: ${err.message}` }));
    process.exit(2);
  }

  if (!input || typeof input.player !== 'string' || typeof input.solverCode !== 'string' || !Array.isArray(input.requests)) {
    writeAll(1, JSON.stringify({ type: 'error', error: 'solver host: missing player / requests / solverCode' }));
    process.exit(2);
  }

  let result;
  try {
    const meriyah = await import('meriyah');
    const astring = await import('astring');
    const factory = new Function('meriyah', 'astring', input.solverCode + '\nreturn jsc;');
    const solver = factory(meriyah, astring);
    result = solver({ type: 'player', player: input.player, requests: input.requests });
  } catch (err) {
    result = { type: 'error', error: err instanceof Error ? err.message : String(err) };
  }

  writeAll(1, JSON.stringify(result));
  process.exit(0);
}
