// Format snapshot tests: the on-disk files and CLI output are the integration surface.
//
// A fixed board with deterministic ids and timestamps (store.seams) is driven through chosen CLI
// commands; their stdout/stderr (transcript.txt) and the resulting file bytes are compared to the
// verified snapshots in tests/ts/fixtures/format/. A legacy board in today's-original v1 format
// (tests/ts/fixtures/v1-board: integer version 1, 14 keys, written by the pre-1.1.0 code) must
// upgrade on first touch to exactly the snapshot bytes.
//
// When a snapshot fails, do not just regenerate it. Evaluate the diff:
// - Additive change (new optional field, new default, clarification): bump the minor/patch version
//   in scripts/lib/versions.ts (CURRENT) and add an upgrade step that only fills defaults.
// - Breaking change (rename, restructure, changed meaning): first try to make it non-breaking.
//   If that is impossible, bump the major and add an upgrade step to PIPELINES that transforms the
//   data (and the same step to board.html), with tests on the legacy fixtures.
// Then regenerate with `UPDATE_SNAPSHOTS=1 bun test tests/ts/format.test.ts`, review every changed
// byte in the diff, and commit the snapshots together with the code.
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/agentboard';
import * as store from '../../scripts/lib/store';

const FIXTURES = join(import.meta.dir, 'fixtures');
const SNAPSHOTS = join(FIXTURES, 'format');
const LEGACY = join(FIXTURES, 'v1-board');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const original = { ...store.seams };
let tick = 0;
let counter = 0;
beforeEach(() => {
  tick = 0;
  counter = 0;
  store.seams.now = () => new Date(Date.UTC(2026, 1, 3, 4, 5, 6) + 1000 * tick++).toISOString();
  store.seams.randomHex = bytes => (++counter).toString(16).toUpperCase().padStart(bytes * 2, '0');
});
afterEach(() => Object.assign(store.seams, original));

/** Runs the CLI in-process and appends `$ command`, exit code, stdout and stderr to the transcript. */
function session(root: string) {
  const lines: string[] = [];
  const run = (env: Record<string, string>, ...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(['--root', root, ...args], { out: t => out.push(t), err: t => err.push(t), env });
    lines.push(`$ agentboard ${args.map(a => (/^[\w./=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`);
    lines.push(`[exit ${code}]`);
    if (out.length) lines.push('--- stdout', ...out);
    if (err.length) lines.push('--- stderr', ...err);
    lines.push('');
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { lines, cli: (...args: string[]) => run({}, ...args), cliEnv: run };
}

function boardFiles(root: string): Record<string, string> {
  const files: Record<string, string> = { 'board.json': readFileSync(join(root, '.agentboard', 'board.json'), 'utf8') };
  for (const name of readdirSync(join(root, '.agentboard', 'items')).sort()) {
    files[`items/${name}`] = readFileSync(join(root, '.agentboard', 'items', name), 'utf8');
  }
  const features = join(root, '.agentboard', 'features');
  if (existsSync(features)) {
    for (const name of readdirSync(features).sort()) files[`features/${name}`] = readFileSync(join(features, name), 'utf8');
  }
  return files;
}

/** Compares (or with UPDATE_SNAPSHOTS=1 writes) a directory of expected files. */
function matchSnapshot(name: string, files: Record<string, string>) {
  const dir = join(SNAPSHOTS, name);
  if (UPDATE) {
    rmSync(dir, { recursive: true, force: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return;
  }
  expect(existsSync(dir), `missing snapshot ${name}; run with UPDATE_SNAPSHOTS=1 and review`).toBe(true);
  const expected: Record<string, string> = {};
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const path = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else expected[path] = readFileSync(join(dir, path), 'utf8');
    }
  };
  walk('');
  expect(Object.keys(files).sort()).toEqual(Object.keys(expected).sort());
  for (const path of Object.keys(expected)) expect(files[path], `${name}/${path}`).toBe(expected[path]);
}

function tempRoot(name: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'ab-format-'));
  dirs.push(parent);
  return join(parent, name);
}

describe('format snapshots', () => {
  test('a fixed board driven through the CLI matches the verified output and file bytes', () => {
    const root = tempRoot('format');
    store.init(root);
    const { lines, cli, cliEnv } = session(root);
    const first = JSON.parse(cli('--json', 'create', 'Write the parser', '--priority', 'high', '--label', 'parser',
      '--description', 'Flags and errors.\nUnicode: é 漢 😀', '--criterion', 'Parses flags', '--criterion', 'Reports errors').out);
    const second = JSON.parse(cli('--json', 'create', 'Pick a license', '--status', 'todo').out);
    cli('edit', first.id, '--notes', 'Started', '--labels-json', '["parser","cli"]');
    cli('move', first.id, 'in-progress');
    cli('claim', first.id, 'agent-a');
    const question = JSON.parse(cli('--json', 'ask', first.id, 'Which flag syntax?', '--author', 'agent-a').out).thread[0];
    cli('comment', first.id, 'Context: argparse style today.', '--reply-to', question.id);
    cli('answer', first.id, question.id, 'Use --opt=value.', '--author', 'alice');
    const open = JSON.parse(cliEnv({ AGENTBOARD_AUTHOR: 'env-agent' }, '--json', 'ask', second.id, 'MIT or Apache-2.0?').out).thread[0];
    cli('edit-entry', second.id, open.id, '--body', 'MIT or Apache-2.0?\nThe answer decides the header.');
    cli('show', first.id);
    cli('--json', 'list');
    cli('thread', first.id);
    cli('questions');
    cli('--json', 'questions');
    cli('move', second.id, 'needs-grilling');
    cli('grill');
    cli('--json', 'grill', second.id);
    cli('--quiet', 'show', second.id);
    matchSnapshot('fresh', { 'transcript.txt': lines.join('\n'), ...boardFiles(root) });
  });

  test('feature commands preserve their output and file format', () => {
    const root = tempRoot('features');
    store.init(root);
    const { lines, cli } = session(root);
    const feature = JSON.parse(cli('--json', 'feature-create', 'Release', '--description', 'First release').out);
    cli('feature-edit', feature.id, '--title', 'Release one');
    cli('feature-move', feature.id, 'active');
    const first = JSON.parse(cli('--json', 'create', 'Linked', '--feature', feature.id).out);
    const second = JSON.parse(cli('--json', 'create', 'Later').out);
    cli('edit', second.id, '--feature', feature.id);
    cli('list', '--feature', feature.id);
    cli('feature-show', feature.id);
    cli('features');
    cli('edit', second.id, '--clear-feature');
    expect(store.get(root, first.id).feature).toBe(feature.id);
    matchSnapshot('features', { 'transcript.txt': lines.join('\n'), ...boardFiles(root) });
  });

  test('the v1 legacy board upgrades on first touch to exactly the snapshot bytes', () => {
    const root = tempRoot('legacy');
    cpSync(LEGACY, join(root, '.agentboard'), { recursive: true });
    const before = boardFiles(root);
    expect(JSON.parse(before['board.json']).version).toBe(1);
    expect(Object.keys(JSON.parse(before['items/AB-0000000000A1.json']))).toHaveLength(14);

    const { lines, cli } = session(root);
    cli('show', 'AB-0000000000A1');
    const touched = boardFiles(root);
    // Only the files that were read are upgraded; the others keep their v1 bytes.
    expect(touched['board.json']).not.toBe(before['board.json']);
    expect(touched['items/AB-0000000000A1.json']).not.toBe(before['items/AB-0000000000A1.json']);
    expect(touched['items/AB-0000000000B2.json']).toBe(before['items/AB-0000000000B2.json']);
    expect(touched['items/AB-0000000000C3.json']).toBe(before['items/AB-0000000000C3.json']);

    cli('--json', 'list', '--all');
    const after = boardFiles(root);
    // A pure format upgrade keeps revision and updatedAt (and every other value).
    for (const id of ['AB-0000000000A1', 'AB-0000000000B2', 'AB-0000000000C3']) {
      const old = JSON.parse(before[`items/${id}.json`]);
      const now = JSON.parse(after[`items/${id}.json`]);
      expect(now).toEqual({ ...old, version: '1.1.0', feature: null, thread: [] });
      expect(Object.keys(now)).toEqual([...Object.keys(old), 'feature', 'thread']);
    }
    expect(tick).toBe(0);   // no clock reads: nothing was edited
    cli('list', '--all');   // already current: nothing changes any more
    expect(boardFiles(root)).toEqual(after);
    matchSnapshot('legacy-upgraded', { 'transcript.txt': lines.join('\n'), ...after });
  });
});
