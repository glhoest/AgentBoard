import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

async function fixtures({ noUpdate = false, override = {}, badDigest = false, moved = false } = {}) {
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
        number: 42, state: 'open', base: { ref: 'main', repo: { full_name: repository } },
        head: { sha: ++heads > 1 && moved ? otherHead : commit },
      });
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
    commit, pr, installed: null, source: `https://github.com/${repository}/pull/42/commits/${commit}`,
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
  await expect(experiment(pr, project, otherHead, false, fetcher)).rejects.toThrow('Inspect the new head');
  expect(requests).toHaveLength(1);
  await expect(experiment(pr, project, commit, false, (await fixtures({ moved: true })).fetcher)).rejects.toThrow('moved during verification');
  expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('old');
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
