import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatJson } from '../../scripts/agentboard';
import { locate, init } from '../../scripts/lib/store';

const root = mkdtempSync(join(tmpdir(), 'agentboard-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cli = (...args: string[]) => Bun.spawnSync(['bun', 'scripts/agentboard.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });

test('JSON serializer: compact form uses ", " and ": " separators and raw non-ASCII', () => {
  const value = { timestamp: '2026-10-31T12:34:56.789Z', unicode: 'é 漢 😀', nested: [[], {}, { quote: '"\\,:' }] };
  expect(formatJson(value)).toBe('{"timestamp": "2026-10-31T12:34:56.789Z", "unicode": "é 漢 😀", "nested": [[], {}, {"quote": "\\"\\\\,:"}]}');
  expect(formatJson(value, 2)).toBe(JSON.stringify(value, null, 2));
});

test('edit changes only supplied fields and reports conflicts', () => {
  expect(cli('init', root).exitCode).toBe(0);
  const created = cli('--root', root, '--json', 'create', 'Original');
  expect(created.exitCode).toBe(0);
  const item = JSON.parse(created.stdout.toString());
  const edited = cli('--root', root, '--json', 'edit', item.id, '--title', 'Updated');
  expect(edited.exitCode).toBe(0);
  expect(JSON.parse(edited.stdout.toString()).title).toBe('Updated');
  const conflicting = cli('--root', root, 'edit', item.id, '--archive', '--unarchive');
  expect(conflicting.exitCode).toBe(1);
  expect(conflicting.stdout.toString()).toBe('');
  expect(conflicting.stderr.toString()).toContain('Error: Conflicting options');
  const stale = cli('--root', root, 'edit', item.id, '--revision', '1', '--title', 'Stale');
  expect(stale.exitCode).toBe(2);
  expect(stale.stdout.toString()).toBe('');
});

test('discovery stops at nested repositories and incomplete boards', () => {
  const outer = mkdtempSync(join(tmpdir(), 'agentboard-discovery-'));
  try {
    init(outer);
    const nested = join(outer, 'nested');
    const deep = join(nested, 'deep');
    mkdirSync(join(nested, '.git'), { recursive: true });
    mkdirSync(deep);
    expect(() => locate(deep, true)).toThrow('repository root');
    expect(locate(deep)).toBe(outer);
    mkdirSync(join(nested, '.agentboard'));
    expect(() => locate(deep, true)).toThrow('Incomplete board');
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('worktree git file bounds discovery, nearest board wins, and rejected create changes no boards', () => {
  const outer = mkdtempSync(join(tmpdir(), 'agentboard-worktree-'));
  try {
    init(outer);
    const nested = join(outer, 'worktree');
    const deep = join(nested, 'deep');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(nested, '.git'), 'gitdir: ../somewhere\n');
    const executable = join(import.meta.dir, '../../scripts/agentboard.ts');
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, executable, '--quiet', ...args], { cwd: deep, stdout: 'pipe', stderr: 'pipe' });
    const before = readFileSync(join(outer, '.agentboard', 'board.json'));
    const items = readdirSync(join(outer, '.agentboard', 'items'));
    const rejected = run('create', 'Must not escape');
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain('repository root');
    expect(readFileSync(join(outer, '.agentboard', 'board.json'))).toEqual(before);
    expect(readdirSync(join(outer, '.agentboard', 'items'))).toEqual(items);
    init(nested);
    expect(locate(deep, true)).toBe(nested);
    expect(locate(deep)).toBe(nested);
    expect(run('create', 'Nearest').exitCode).toBe(0);
    expect(readdirSync(join(outer, '.agentboard', 'items'))).toEqual(items);
    expect(readdirSync(join(nested, '.agentboard', 'items'))).toHaveLength(1);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});

test('absolute executable invocation from nested directories selects boards safely', () => {
  const outer = mkdtempSync(join(tmpdir(), 'agentboard-invoke-'));
  try {
    init(outer);
    const deep = join(outer, 'nested', 'deep');
    mkdirSync(deep, { recursive: true });
    const executable = join(import.meta.dir, '../../scripts/agentboard.ts');
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, executable, '--quiet', ...args], { cwd: deep, stdout: 'pipe', stderr: 'pipe' });
    expect(run('list').exitCode).toBe(0);
    mkdirSync(join(outer, 'nested', '.git'));
    const missing = run('list');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain('repository root');
    expect(run('--root', outer, 'list').exitCode).toBe(0);
    mkdirSync(join(outer, 'nested', '.agentboard'));
    const incomplete = run('list');
    expect(incomplete.exitCode).toBe(1);
    expect(incomplete.stderr.toString()).toContain('Incomplete board');
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
