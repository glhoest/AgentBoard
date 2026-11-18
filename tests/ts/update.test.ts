import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectRelease, updateInstallation } from '../../scripts/lib/update';
import { generatedFiles } from '../../scripts/lib/distribution';

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
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/git/matching-refs/tags/v')) {
      return Response.json([{ ref: 'refs/tags/v1.2.3' }]);
    }
    if (url.hostname === 'api.github.com') {
      return Response.json({ ...metadata, published_at: '2020-01-01T00:00:00Z', draft: false, prerelease: false });
    }
    return new Response(bytes);
  }) as typeof fetch;
}

const valid = { 'SKILL.md': 'new', 'LICENSE': 'license', 'scripts/agentboard.ts': 'new cli',
  'scripts/board.html': 'board ui', 'scripts/lib/update.ts': 'updater' };

test('beta respects the three-day gate and verifies the source before replacing the skill', async () => {
  const { root, target } = installation();
  const commit = 'a'.repeat(40), treeSha = 'b'.repeat(40);
  const source = { ...valid, 'README.md': 'readme', 'scripts/lib/update-check.ts': 'notice' };
  const build = { commit, pr: null, noUpdate: false };
  const archive = await new Bun.Archive({ ...source, ...Object.fromEntries(generatedFiles(build)) }, { compress: 'gzip' }).bytes();
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const tag = `beta-${commit}`;
  const url = `https://github.com/glhoest/AgentBoard/releases/download/${tag}/agentboard.tar.gz`;
  const tree = Object.entries(source).map(([path, body]) => ({ path, type: 'blob', mode: '100644',
    sha: createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex') }));
  const now = Date.parse('2026-11-19T00:00:00Z');
  const fetcher = (async (input: string | URL | Request) => {
    const address = String(input);
    if (address === url) return new Response(archive);
    if (address.includes('/commits?sha=main')) return Response.json([{ sha: commit }]);
    if (address.endsWith(`/releases/tags/${tag}`)) return Response.json({ tag_name: tag, draft: false, prerelease: true,
      published_at: new Date(now - 3 * 86400000 + 1).toISOString(), assets: [{ name: 'agentboard.tar.gz', browser_download_url: url, size: archive.length, digest }] });
    if (address.endsWith(`/git/commits/${commit}`)) return Response.json({ sha: commit, tree: { sha: treeSha } });
    if (address.endsWith(`/git/trees/${treeSha}?recursive=1`)) return Response.json({ sha: treeSha, truncated: false, tree });
    if (address.includes('/compare/')) return Response.json({ status: 'ahead' });
    throw new Error(`Unexpected URL ${address}`);
  }) as typeof fetch;
  await expect(updateInstallation(target, fetcher, false, now, 'beta')).rejects.toThrow('No eligible beta');
  expect(await updateInstallation(target, fetcher, true, now, 'beta')).toEqual({ version: tag, changed: true });
  expect(readFileSync(join(root, '.agentboard', 'board.json'), 'utf8')).toBe('board bytes');
  expect(await updateInstallation(target, fetcher, true, now, 'beta')).toEqual({ version: tag, changed: false });
  writeFileSync(join(target, '.agentboard-build.json'), JSON.stringify({ channel: 'beta', commit: 'c'.repeat(40), noUpdate: false }));
  await expect(updateInstallation(target, fetcher, false, now + 1, `beta-${commit}`)).rejects.toThrow('requires --force');
  await expect(updateInstallation(target, fetcher, true, now, 'beta')).rejects.toThrow('requires --force');
  expect(await updateInstallation(target, fetcher, true, now, `beta-${commit}`)).toEqual({ version: tag, changed: true });
});

test('a concurrent no-update installation is not replaced', async () => {
  const { target } = installation();
  const original = await release(valid);
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await original(input, init);
    if (String(input).startsWith('https://github.com/')) writeFileSync(join(target, '.agentboard-no-update'), '');
    return response;
  }) as typeof fetch;
  await expect(updateInstallation(target, fetcher)).rejects.toThrow('does not support updates');
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('old');
});

test('verified release replaces the skill and leaves the board unchanged; repeat is idempotent', async () => {
  const { root, target } = installation();
  const fetcher = await release(valid);
  expect(await updateInstallation(target, fetcher)).toEqual({ version: 'v1.2.3', changed: true });
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new');
  expect(readFileSync(join(root, '.agentboard', 'board.json'), 'utf8')).toBe('board bytes');
  expect(await updateInstallation(target, fetcher)).toEqual({ version: 'v1.2.3', changed: false });
});

test('explicit stable downgrades require force', async () => {
  const { target } = installation();
  writeFileSync(join(target, '.agentboard-release.json'), JSON.stringify({ version: 'v2.0.0' }));
  const fetcher = await release(valid);
  await expect(updateInstallation(target, fetcher, false, Date.now(), 'v1.2.3')).rejects.toThrow('Downgrade requires --force');
  expect(await updateInstallation(target, fetcher, true, Date.now(), 'v1.2.3')).toEqual({ version: 'v1.2.3', changed: true });
  expect(await updateInstallation(target, fetcher, false, Date.now(), '1.2.3')).toEqual({ version: 'v1.2.3', changed: false });
});

test('latest switches a beta installation to an eligible stable release', async () => {
  const { target } = installation();
  rmSync(join(target, '.agentboard-release.json'));
  writeFileSync(join(target, '.agentboard-build.json'), JSON.stringify({ channel: 'beta', commit: 'a'.repeat(40), noUpdate: false }));
  expect(await updateInstallation(target, await release(valid), false, Date.now(), 'latest')).toEqual({ version: 'v1.2.3', changed: true });
  expect(existsSync(join(target, '.agentboard-build.json'))).toBe(false);
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
  function fixture(releases: typeof entries) {
    return (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/git/matching-refs/tags/v')) {
        return Response.json([
          { ref: 'refs/tags/beta-' + 'a'.repeat(40) },
          { ref: 'refs/tags/experiment-42-' + 'a'.repeat(40) },
          { ref: 'refs/tags/v10.0.0' }, // Tag without a release.
          ...releases.map(release => ({ ref: 'refs/tags/' + release.tag_name })),
        ]);
      }
      if (url.pathname.endsWith('/releases/tags/v10.0.0')) return new Response(null, { status: 404 });
      const release = releases.find(release => url.pathname.endsWith('/releases/tags/' + release.tag_name));
      if (!release) throw new Error(`Unexpected lookup ${url}`);
      return Response.json(release);
    }) as typeof fetch;
  }
  expect((await selectRelease(fixture(entries), false, now)).tag_name).toBe('v1.0.0');
  expect((await selectRelease(fixture(entries), true, now)).tag_name).toBe('v2.0.0');
  await expect(selectRelease(fixture([entries[1]]), false, now)).rejects.toThrow('No eligible');
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
