import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateCachePath, updateNotice } from '../../scripts/lib/update-check';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(version?: string) {
  const root = mkdtempSync(join(tmpdir(), 'agentboard-check-test-'));
  roots.push(root);
  const skill = join(root, 'skill');
  mkdirSync(skill);
  if (version) writeFileSync(join(skill, '.agentboard-release.json'), JSON.stringify({ version }));
  return { skill, cache: join(root, 'cache.json') };
}

function latest(version: string, includeAsset = true) {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json({ tag_name: version, assets: includeAsset ? [{ name: 'agentboard.tar.gz' }] : [] });
  }) as typeof fetch;
  return { fetcher, calls: () => calls };
}

test('a newer published artifact produces a notice, cached for one day', async () => {
  const { skill, cache } = fixture('v1.2.3');
  const mock = latest('v1.3.0');
  expect(await updateNotice(skill, cache, mock.fetcher, 1000)).toContain('v1.3.0');
  expect(await updateNotice(skill, cache, mock.fetcher, 2000)).toContain('update.ts');
  expect(mock.calls()).toBe(1);
  expect(await updateNotice(skill, cache, mock.fetcher, 1000 + 86400000)).toContain('v1.3.0');
  expect(mock.calls()).toBe(2);
});

test('the same or an older release produces no notice', async () => {
  for (const latestTag of ['v2.0.0', 'v1.99.99']) {
    const { skill, cache } = fixture('v2.0.0');
    expect(await updateNotice(skill, cache, latest(latestTag).fetcher, 1000)).toBeNull();
  }
});

test('source installs without a version report the latest release without claiming it is newer', async () => {
  const { skill, cache } = fixture();
  const mock = latest('v1.0.0');
  expect(await updateNotice(skill, cache, mock.fetcher, 1000)).toContain('installed version unknown');
  expect(mock.calls()).toBe(1);
});

test('offline failures and releases without artifacts are silent and retried later', async () => {
  const { skill, cache } = fixture('v1.0.0');
  let calls = 0;
  const offline = (async () => { calls++; throw new Error('offline'); }) as typeof fetch;
  expect(await updateNotice(skill, cache, offline, 1000)).toBeNull();
  expect(await updateNotice(skill, cache, offline, 2000)).toBeNull();
  expect(calls).toBe(1);
  const missing = latest('v2.0.0', false);
  expect(await updateNotice(skill, cache, missing.fetcher, 1000 + 3600000)).toBeNull();
  expect(missing.calls()).toBe(1);
});

test('installed CLI keeps JSON output intact and quiet suppresses update notices', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentboard-check-cli-'));
  roots.push(root);
  mkdirSync(join(root, '.git'));
  const setup = Bun.spawnSync(['bun', join(import.meta.dir, '../../scripts/agentboard.ts'), '--quiet', 'setup', root]);
  expect(setup.exitCode).toBe(0);
  const skill = join(root, '.agents', 'skills', 'agentboard');
  const cli = join(skill, 'scripts', 'agentboard.ts');
  const cache = updateCachePath(skill);
  try {
    writeFileSync(join(skill, '.agentboard-release.json'), JSON.stringify({ version: 'v1.0.0' }));
    writeFileSync(cache, JSON.stringify({ checkedAt: Date.now(), latest: 'v2.0.0' }));
    const normal = Bun.spawnSync(['bun', cli, '--root', root, '--json', 'list']);
    const quiet = Bun.spawnSync(['bun', cli, '--root', root, '--json', '--quiet', 'list']);
    expect(normal.exitCode).toBe(0);
    expect(normal.stdout.toString()).toBe(quiet.stdout.toString());
    expect(JSON.parse(normal.stdout.toString())).toEqual([]);
    expect(normal.stderr.toString()).toContain('v2.0.0');
    expect(quiet.stderr.toString()).toBe('');
  } finally {
    rmSync(cache, { force: true });
  }
});