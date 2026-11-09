import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateInstallation } from '../../scripts/update';

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
    ? Response.json(metadata) : new Response(bytes)) as typeof fetch;
}

const valid = { 'SKILL.md': 'new', 'LICENSE': 'license', 'scripts/agentboard.ts': 'new cli',
  'scripts/board.html': 'board ui', 'scripts/update.ts': 'updater' };

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
  expect(existsSync(join(target, '.agentboard-release.json'))).toBe(false);
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
