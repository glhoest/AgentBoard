import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectRelease, updateInstallation } from '../../scripts/lib/update';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function installation() {
  const root = mkdtempSync(join(tmpdir(), 'agentboard-update-test-'));
  roots.push(root);
  const target = join(root, '.agents', 'skills', 'agentboard');
  mkdirSync(join(target, 'scripts'), { recursive: true });
  mkdirSync(join(root, '.agentboard'));
  writeFileSync(join(target, 'SKILL.md'), 'old');
  writeFileSync(join(target, 'scripts', 'agentboard.ts'), 'old cli');
  writeFileSync(join(target, '.agentboard-release.json'), JSON.stringify({ version: 'v1.0.0' }));
  writeFileSync(join(root, '.agentboard', 'board.json'), 'board bytes');
  return { root, target };
}

async function release(files: Record<string, string>, corruptDigest = false): Promise<typeof fetch> {
  const bytes = await new Bun.Archive(files, { compress: 'gzip' }).bytes();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const metadata = { tag_name: 'v1.2.3', assets: [{ name: 'agentboard.tar.gz', size: bytes.length,
    digest: `sha256:${corruptDigest ? '0'.repeat(64) : digest}`,
    browser_download_url: 'https://github.com/glhoest/AgentBoard/releases/download/v1.2.3/agentboard.tar.gz' }] };
  return (async (input: string | URL | Request) => String(input).includes('api.github.com')
    ? Response.json([{ ...metadata, published_at: '2020-01-01T00:00:00Z', draft: false, prerelease: false }]) : new Response(bytes)) as typeof fetch;
}

const valid = { 'SKILL.md': 'new', 'LICENSE': 'license', 'scripts/agentboard.ts': 'new cli',
  'scripts/board.html': 'board ui', 'scripts/lib/update.ts': 'updater' };

test('verified release replaces the skill and leaves the board unchanged; repeat is idempotent', async () => {
  const { root, target } = installation();
  const fetcher = await release(valid);
  expect(await updateInstallation(target, fetcher)).toEqual({ version: 'v1.2.3', changed: true });
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new');
  expect(readFileSync(join(root, '.agentboard', 'board.json'), 'utf8')).toBe('board bytes');
  expect(await updateInstallation(target, fetcher)).toEqual({ version: 'v1.2.3', changed: false });
});

test('digest mismatch leaves the installed skill and board untouched', async () => {
  const { root, target } = installation();
  await expect(updateInstallation(target, await release(valid, true))).rejects.toThrow('digest');
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('old');
  expect(readFileSync(join(root, '.agentboard', 'board.json'), 'utf8')).toBe('board bytes');
  expect(JSON.parse(readFileSync(join(target, '.agentboard-release.json'), 'utf8')).version).toBe('v1.0.0');
});

test('missing files and unsafe paths are rejected before replacing the installation', async () => {
  const { target } = installation();
  await expect(updateInstallation(target, await release({ 'SKILL.md': 'new' }))).rejects.toThrow('missing required');
  await expect(updateInstallation(target, await release({ ...valid, '../escape': 'bad' }))).rejects.toThrow('Invalid artifact path');
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('old');
});

test('release lookup failure leaves the installation untouched', async () => {
  const { target } = installation();
  const fetcher = (async () => new Response('', { status: 404 })) as typeof fetch;
  await expect(updateInstallation(target, fetcher)).rejects.toThrow('HTTP 404');
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('old');
});


test('release selection applies the seven day boundary, force, and version order', async () => {
  const now = Date.parse('2026-11-09T00:00:00Z');
  const item = (tag: string, time: number, extra = {}) => ({ tag_name: tag, published_at: new Date(time).toISOString(), draft: false, prerelease: false, assets: [{ name: 'agentboard.tar.gz' }], ...extra });
  const entries = [item('v1.0.0', now - 7 * 86400000), item('v2.0.0', now - 7 * 86400000 + 1), item('v9.0.0', now - 8 * 86400000, { prerelease: true })];
  const fetcher = (async () => Response.json(entries)) as typeof fetch;
  expect((await selectRelease(fetcher, false, now)).tag_name).toBe('v1.0.0');
  expect((await selectRelease(fetcher, true, now)).tag_name).toBe('v2.0.0');
  await expect(selectRelease((async () => Response.json([entries[1]])) as typeof fetch, false, now)).rejects.toThrow('No eligible');
});

test('never downgrades an installed release even with force', async () => {
  const { target } = installation();
  writeFileSync(join(target, '.agentboard-release.json'), JSON.stringify({ version: 'v9.0.0' }));
  expect(await updateInstallation(target, await release(valid), true)).toEqual({ version: 'v9.0.0', changed: false });
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('old');
});


test('no-update bundle installs and operates a board without updater capability', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentboard-no-update-'));
  roots.push(root);
  const source = join(root, 'bundle');
  mkdirSync(source);
  for (const name of ['SKILL.md', 'README.md', 'LICENSE', 'agents', 'assets', 'scripts']) {
    cpSync(join(import.meta.dir, '../..', name), join(source, name), { recursive: true });
  }
  rmSync(join(source, 'scripts', 'lib', 'update.ts'));
  writeFileSync(join(source, 'scripts', 'lib', 'update-check.ts'), 'export async function updateNotice() { throw new Error("unexpected check"); }');
  writeFileSync(join(source, '.agentboard-no-update'), '');
  const project = join(root, 'project');
  mkdirSync(project);
  expect(Bun.spawnSync(['bun', join(source, 'scripts', 'agentboard.ts'), 'setup', project]).exitCode).toBe(0);
  const cli = join(project, '.agents', 'skills', 'agentboard', 'scripts', 'agentboard.ts');
  expect(existsSync(join(project, '.agents', 'skills', 'agentboard', 'scripts', 'lib', 'update.ts'))).toBe(false);
  // Reinstalling over an old update-capable copy removes both updater entry points.
  writeFileSync(join(project, '.agents', 'skills', 'agentboard', 'scripts', 'update.ts'), 'old executable');
  writeFileSync(join(project, '.agents', 'skills', 'agentboard', 'scripts', 'lib', 'update.ts'), 'old module');
  expect(Bun.spawnSync(['bun', join(source, 'scripts', 'agentboard.ts'), 'setup', project]).exitCode).toBe(0);
  expect(existsSync(join(project, '.agents', 'skills', 'agentboard', 'scripts', 'update.ts'))).toBe(false);
  expect(existsSync(join(project, '.agents', 'skills', 'agentboard', 'scripts', 'lib', 'update.ts'))).toBe(false);
  expect(Bun.spawnSync(['bun', cli, '--root', project, 'create', 'Works']).exitCode).toBe(0);
  const update = Bun.spawnSync(['bun', cli, 'update', '--force']);
  expect(update.exitCode).toBe(1);
  expect(update.stderr.toString()).toContain('does not support updates');
});
