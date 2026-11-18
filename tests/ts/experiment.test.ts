import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTag, generatedFiles, noUpdatePath, noticePath, repository, sourceFiles } from '../../scripts/lib/distribution';
import { experiment } from '../../scripts/lib/experiment';

const commit = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const otherHead = 'c'.repeat(40);
const pr = '42';
const source = {
  'SKILL.md': 'skill',
  'README.md': 'readme',
  LICENSE: 'license',
  'scripts/agentboard.ts': 'cli',
  'scripts/board.html': 'board',
  'scripts/lib/update.ts': 'updater',
  'scripts/lib/experiment.ts': 'experiment',
  [noticePath]: 'notice',
};
const tree = Object.entries(source).map(([path, body]) => ({
  path, mode: '100644', type: 'blob',
  sha: createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex'),
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installation() {
  const project = mkdtempSync(join(tmpdir(), 'agentboard-experiment-'));
  roots.push(project);
  const skill = join(project, '.agents', 'skills', 'agentboard');
  const board = join(project, '.agentboard', 'board.json');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  mkdirSync(join(project, '.agentboard'));
  writeFileSync(board, 'board bytes');
  writeFileSync(join(skill, 'SKILL.md'), 'old');
  writeFileSync(join(skill, 'scripts', 'agentboard.ts'), 'old cli');
  return { project, skill, board };
}

async function fixtures({ noUpdate = false, override = {}, badDigest = false, moved = false, pending = false } = {}) {
  const build = { commit, pr, noUpdate };
  const tag = buildTag(build);
  const name = noUpdate ? 'agentboard-no-update.tar.gz' : 'agentboard.tar.gz';
  const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
  const files = Object.fromEntries([...sourceFiles(tree, noUpdate).keys()].map(path => [path, source[path as keyof typeof source]]));
  Object.assign(files, Object.fromEntries(generatedFiles(build)), override);
  const bytes = await new Bun.Archive(files, { compress: 'gzip' }).bytes();
  const digest = createHash('sha256').update(bytes).digest('hex');
  let heads = 0;
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const request = String(input);
    requests.push(request);
    const prefix = `https://api.github.com/repos/${repository}`;
    if (request === prefix + '/pulls/42') {
      return Response.json({
        number: 42, state: 'open', base: { ref: 'main', sha: treeSha, repo: { full_name: repository } },
        head: { sha: (++heads > 1 && moved) || pending ? otherHead : commit },
      });
    }
    if (request === prefix + '/releases/tags/' + buildTag({ ...build, commit: otherHead })) {
      return new Response(null, { status: 404 });
    }
    if (request === prefix + `/compare/${treeSha}...${pending ? otherHead : commit}?per_page=100&page=1`) {
      return Response.json({ commits: (pending ? [commit, otherHead] : [commit]).map(sha => ({ sha })) });
    }
    if (request === prefix + '/releases/tags/' + tag) {
      return Response.json({ tag_name: tag, draft: false, prerelease: true, assets: [{
        name, browser_download_url: url, size: bytes.length, digest: `sha256:${badDigest ? '0'.repeat(64) : digest}`,
      }] });
    }
    if (request === prefix + '/git/commits/' + commit) return Response.json({ sha: commit, tree: { sha: treeSha } });
    if (request === prefix + '/git/trees/' + treeSha + '?recursive=1') {
      return Response.json({ sha: treeSha, truncated: false, tree });
    }
    if (request === url) return new Response(bytes);
    throw new Error(`Unexpected request ${request}`);
  }) as typeof fetch;
  return { fetcher, requests };
}

test('inspection reports the exact head and does not fetch executable files', async () => {
  const { fetcher, requests } = await fixtures();
  expect(await experiment(pr, null, null, false, fetcher)).toMatchObject({
    commit, head: commit, pr, installed: null, source: `https://github.com/${repository}/pull/42/commits/${commit}`,
  });
  expect(requests).toHaveLength(2);
});

test('explicit installation replaces only the skill and pins its provenance', async () => {
  const { project, skill, board } = installation();
  const { fetcher } = await fixtures();
  expect(await experiment(pr, project, commit, false, fetcher)).toMatchObject({ commit, installed: skill });
  expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe(source['SKILL.md']);
  expect(readFileSync(board, 'utf8')).toBe('board bytes');
  expect(JSON.parse(readFileSync(join(skill, '.agentboard-build.json'), 'utf8'))).toMatchObject({ commit, pr, channel: 'experiment' });
});

test('a no-update target can only receive the no-update variant', async () => {
  const { project, skill } = installation();
  writeFileSync(join(skill, noUpdatePath), '');
  await expect(experiment(pr, project, commit, false, (await fixtures()).fetcher)).rejects.toThrow('Target uses the no-update build');
  await experiment(pr, project, commit, true, (await fixtures({ noUpdate: true })).fetcher);
  expect(existsSync(join(skill, noUpdatePath))).toBe(true);
  expect(existsSync(join(skill, 'scripts/lib/update.ts'))).toBe(false);
  expect(existsSync(join(skill, 'scripts/lib/experiment.ts'))).toBe(false);
  expect(readFileSync(join(skill, noticePath), 'utf8')).toBe('export async function updateNotice() { return null; }\n');
});

test('stale acceptance stops before release lookup and a moving head stops before replacement', async () => {
  const { project, skill } = installation();
  const { fetcher, requests } = await fixtures({ moved: true });
  await expect(experiment(pr, project, otherHead, false, fetcher)).rejects.toThrow('outside the current history');
  expect(requests).toHaveLength(2);
  await expect(experiment(pr, project, commit, false, (await fixtures({ moved: true })).fetcher)).rejects.toThrow('moved during verification');
  expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('old');
});

test('pending head falls back to a published PR commit and installs only the explicitly accepted SHA', async () => {
  const { project, skill } = installation();
  const { fetcher, requests } = await fixtures({ pending: true });
  expect(await experiment(pr, null, null, false, fetcher)).toMatchObject({
    commit, head: otherHead, installed: null,
  });
  expect(requests.some(url => url.includes('/releases/download/'))).toBe(false);
  await expect(experiment(pr, project, null, false, fetcher)).rejects.toThrow('FULL_SHA');
  await expect(experiment(pr, project, otherHead, false, fetcher)).rejects.toThrow('No published experiment');
  expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('old');
  expect(await experiment(pr, project, commit, false, fetcher)).toMatchObject({
    commit, head: otherHead, installed: skill,
  });
  expect(JSON.parse(readFileSync(join(skill, '.agentboard-build.json'), 'utf8'))).toMatchObject({ commit, pr });
});

test('release digests, canonical source bytes and generated provenance are all required', async () => {
  const { project, skill } = installation();
  for (const [options, error] of [
    [{ badDigest: true }, 'SHA-256'],
    [{ override: { 'SKILL.md': 'different code' } }, 'differs from canonical PR source'],
    [{ override: { '.agentboard-build.json': '{}' } }, 'differs from canonical PR source'],
    [{ override: { '../escape': 'extra' } }, 'file list differs'],
  ] as const) {
    await expect(experiment(pr, project, commit, false, (await fixtures(options)).fetcher)).rejects.toThrow(error);
  }
  expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('old');
});

test('distribution rejects symlinks, submodules, device names and case collisions', () => {
  for (const unsafe of [
    { path: 'scripts/link', mode: '120000', type: 'blob' },
    { path: 'scripts/module', mode: '160000', type: 'commit' },
    { path: 'scripts/con.txt', mode: '100644', type: 'blob' },
    { path: 'scripts/BOARD.HTML', mode: '100644', type: 'blob' },
  ]) {
    expect(() => sourceFiles([...tree, { ...unsafe, sha: commit }], false)).toThrow();
  }
});

test('experiment CLI requires both installation options and a full SHA', () => {
  const cli = join(import.meta.dir, '../../scripts/agentboard.ts');
  for (const flags of [
    ['--target', '.'],
    ['--accept-head', commit],
    ['--target', '.', '--accept-head', 'short'],
  ]) {
    const result = Bun.spawnSync([process.execPath, cli, 'experiment', pr, ...flags]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('--target PROJECT and --accept-head FULL_SHA');
  }
});

test('workflow packager produces both Git-backed variants and their installed CLIs work', async () => {
  const cwd = join(import.meta.dir, '../..');
  const root = mkdtempSync(join(tmpdir(), 'agentboard-source-build-'));
  roots.push(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  const sha = git('rev-parse', 'HEAD');
  const treeId = git('rev-parse', 'HEAD^{tree}');
  const entries = git('ls-tree', '-rtz', sha).split('\0').filter(Boolean).map(entry => {
    const [fields, path] = entry.split('\t');
    const [mode, type, sha] = fields.split(' ');
    return { path, mode, type, sha };
  });
  const cli = join(cwd, 'scripts/agentboard.ts');
  const packager = join(cwd, '.github/scripts/package-distribution.ts');
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, ...args], { cwd });
  const tag = buildTag({ commit: sha, pr, noUpdate: false });
  const output = join(root, tag);

  const packaged = run(packager, sha, pr, output);
  expect(packaged.stderr.toString()).toBe('');
  expect(packaged.exitCode).toBe(0);
  expect(readdirSync(output).sort()).toEqual(['agentboard-no-update.tar.gz', 'agentboard.tar.gz']);
  const failedOutput = join(root, 'incomplete');
  expect(run(packager, '0'.repeat(40), pr, failedOutput).exitCode).toBe(1);
  expect(existsSync(failedOutput)).toBe(false);

  const base = 'e'.repeat(40);
  const assets = readdirSync(output).map(name => {
    const bytes = readFileSync(join(output, name));
    return {
      name, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
    };
  });
  const responses = {
    ['/pulls/' + pr]: {
      number: Number(pr), state: 'open', head: { sha },
      base: { sha: base, ref: 'main', repo: { full_name: repository } },
    },
    ['/releases/tags/' + tag]: { tag_name: tag, draft: false, prerelease: true, assets },
    ['/git/commits/' + sha]: { sha, tree: { sha: treeId } },
    ['/git/trees/' + treeId + '?recursive=1']: { sha: treeId, truncated: false, tree: entries },
  };
  const preload = join(root, 'fetch.ts');
  writeFileSync(preload, `
    const responses = ${JSON.stringify(responses)};
    const downloads = ${JSON.stringify(Object.fromEntries(assets.map(asset => [asset.browser_download_url, join(output, asset.name)])))};
    globalThis.fetch = async input => {
      const url = String(input);
      if (Object.hasOwn(downloads, url)) return new Response(Bun.file(downloads[url]));
      const key = url.replace(${JSON.stringify(`https://api.github.com/repos/${repository}`)}, '');
      if (Object.hasOwn(responses, key)) return Response.json(responses[key]);
      throw new Error('Unexpected request ' + url);
    };
  `);
  for (const noUpdate of [false, true]) {
    const project = join(root, noUpdate ? 'offline' : 'regular');
    mkdirSync(project);
    const setup = run(cli, '--quiet', 'setup', project);
    expect(setup.stderr.toString()).toBe('');
    expect(setup.exitCode).toBe(0);
    const board = join(project, '.agentboard', 'board.json');
    const before = readFileSync(board);
    const args = noUpdate ? ['--no-update'] : [];
    const installed = run('--preload', preload, cli, '--json', 'experiment', pr,
      '--target', project, '--accept-head', sha, ...args);
    expect(installed.stderr.toString()).toBe('');
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.stdout.toString())).toMatchObject({ commit: sha, head: sha, noUpdate });
    expect(readFileSync(board)).toEqual(before);
    const skill = join(project, '.agents', 'skills', 'agentboard');
    expect(JSON.parse(readFileSync(join(skill, '.agentboard-build.json'), 'utf8'))).toMatchObject({
      channel: 'experiment', commit: sha, pr, noUpdate,
    });
    expect(existsSync(join(skill, noUpdatePath))).toBe(noUpdate);
    expect(existsSync(join(skill, 'scripts/lib/update.ts'))).toBe(!noUpdate);
    const installedCli = join(skill, 'scripts/agentboard.ts');
    const created = run(installedCli, '--quiet', '--root', project, 'create', 'Packaged CLI works');
    expect(created.stderr.toString()).toBe('');
    expect(created.exitCode).toBe(0);
    const list = run(installedCli, '--quiet', '--root', project, 'list');
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain('Packaged CLI works');
    const update = run(installedCli, 'update', '--force');
    expect(update.exitCode).toBe(1);
    expect(update.stderr.toString()).toContain(noUpdate ? 'does not support updates' : 'This is a source build');
    if (noUpdate) {
      const experiment = run(installedCli, 'experiment', pr);
      expect(experiment.exitCode).toBe(1);
      expect(experiment.stderr.toString()).toContain('does not support updates');
    }

    const extra = join(skill, 'scripts', 'experiment-only');
    const beta = join(root, noUpdate ? 'beta-offline' : 'beta-regular');
    cpSync(skill, beta, { recursive: true });
    cpSync(join(import.meta.dir, '../../scripts/lib/setup.ts'), join(beta, 'scripts/lib/setup.ts'));
    writeFileSync(join(beta, '.agentboard-build.json'), JSON.stringify({ channel: 'beta' }));
    mkdirSync(extra);
    writeFileSync(join(extra, 'extra.ts'), 'experiment code');
    symlinkSync(join(project, '.agentboard'), join(extra, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const betaSetup = run(join(beta, 'scripts/agentboard.ts'), '--quiet', 'setup', project);
    expect(betaSetup.exitCode).toBe(0);
    expect(existsSync(extra)).toBe(false);
    expect(readFileSync(board)).toEqual(before);
    const restored = run(cli, '--quiet', 'setup', project);
    expect(restored.stderr.toString()).toBe('');
    expect(restored.exitCode).toBe(0);
    expect(existsSync(extra)).toBe(false);
    expect(existsSync(join(skill, '.agentboard-build.json'))).toBe(false);
    expect(existsSync(join(skill, noUpdatePath))).toBe(false);
    expect(existsSync(join(skill, 'scripts/lib/update.ts'))).toBe(true);
    expect(readFileSync(board)).toEqual(before);
    expect(run(installedCli, '--quiet', '--root', project, 'list').stdout.toString()).toContain('Packaged CLI works');
  }
}, 30000);

test('the stable release uses the shared packager and retains its stable update marker', async () => {
  const cwd = join(import.meta.dir, '../..');
  const root = mkdtempSync(join(tmpdir(), 'agentboard-stable-build-'));
  roots.push(root);
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.toString().trim();
  const output = join(root, 'release');
  const result = Bun.spawnSync([process.execPath, '.github/scripts/package-distribution.ts',
    head, '--stable', output, 'v1.2.3'], { cwd });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  for (const noUpdate of [false, true]) {
    const name = noUpdate ? 'agentboard-no-update.tar.gz' : 'agentboard.tar.gz';
    const files = await new Bun.Archive(await Bun.file(join(output, name)).arrayBuffer()).files();
    expect(await files.get('.agentboard-release.json')?.text()).toBe('{"version":"v1.2.3"}\n');
    expect(files.has('.agentboard-build.json')).toBe(false);
    expect(files.has(noUpdatePath)).toBe(noUpdate);
    expect(files.has('scripts/lib/update.ts')).toBe(!noUpdate);
    expect(files.has('scripts/lib/experiment.ts')).toBe(!noUpdate);
  }
}, 30000);
