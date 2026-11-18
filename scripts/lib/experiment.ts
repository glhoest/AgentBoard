import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildTag, generatedFiles, maxDownload, maxSource, repository, sourceFiles, validCommit, validPr,
  type Build,
} from './distribution';
import { replaceSkill } from './install';

const api = `https://api.github.com/repos/${repository}`;
const github = `https://github.com/${repository}`;
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentBoard' };

async function metadata(fetcher: typeof fetch, path: string, label: string, allowMissing = false) {
  const response = await fetcher(api + path, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`${label} (HTTP ${response.status})`);
  return response.json();
}

async function currentPull(fetcher: typeof fetch, pr: string): Promise<{ head: string; base: string }> {
  const pull = await metadata(fetcher, `/pulls/${pr}`, 'Cannot find PR');
  if (pull?.number !== Number(pr) || pull?.state !== 'open' || pull?.base?.ref !== 'main' ||
      pull?.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !validCommit(pull?.head?.sha) || !validCommit(pull?.base?.sha)) {
    throw new Error('The experiment requires an open PR to canonical main with a valid head');
  }
  return { head: pull.head.sha, base: pull.base.sha };
}

async function previousCommits(fetcher: typeof fetch, base: string, head: string) {
  const commits: string[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    const comparison = await metadata(fetcher, `/compare/${base}...${head}?per_page=100&page=${page}`, 'Cannot verify current PR history');
    const batch = comparison?.commits;
    if (!Array.isArray(batch) || batch.length > 100) throw new Error('Invalid PR commit history');
    for (const entry of batch) {
      if (!validCommit(entry?.sha) || seen.has(entry.sha)) throw new Error('Invalid PR commit history');
      seen.add(entry.sha);
      commits.push(entry.sha);
    }
    if (batch.length < 100) break;
  }
  if (commits.pop() !== head) throw new Error('Current PR head is missing from its commit history');
  return commits.reverse();
}

async function publishedBuild(fetcher: typeof fetch, build: Build) {
  const tag = buildTag(build);
  const name = build.noUpdate ? 'agentboard-no-update.tar.gz' : 'agentboard.tar.gz';
  const release = await metadata(fetcher, `/releases/tags/${tag}`, 'Cannot look up experiment release', true);
  if (release === null || release?.draft === true) return null;
  if (release?.tag_name !== tag || release?.draft !== false || release?.prerelease !== true || !Array.isArray(release.assets)) {
    throw new Error('Invalid experiment release metadata');
  }
  const matches = release.assets.filter(item => item?.name === name);
  const [asset] = matches;
  const url = `${github}/releases/download/${tag}/${name}`;
  if (matches.length !== 1 || asset.browser_download_url !== url ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxDownload ||
      typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('Invalid experiment asset URL, size or SHA-256');
  }
  return { tag, asset: { url, digest: asset.digest as string, size: asset.size as number } };
}

async function boundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) throw new Error('Artifact has no body');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error('Artifact exceeds its size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function verifiedFiles(fetcher: typeof fetch, build: Build, asset: { url: string; digest: string; size: number }) {
  const commit = await metadata(fetcher, `/git/commits/${build.commit}`, 'Cannot verify PR head commit');
  if (commit?.sha !== build.commit || !validCommit(commit?.tree?.sha)) throw new Error('Invalid canonical commit metadata');
  const tree = await metadata(fetcher, `/git/trees/${commit.tree.sha}?recursive=1`, 'Cannot verify PR source tree');
  if (tree?.sha !== commit.tree.sha || tree?.truncated !== false || !Array.isArray(tree?.tree)) {
    throw new Error('Canonical source tree is incomplete or invalid');
  }
  const source = sourceFiles(tree.tree, build.noUpdate);
  const generated = generatedFiles(build);

  const download = await fetcher(asset.url, { signal: AbortSignal.timeout(60000) });
  if (!download.ok) throw new Error(`Cannot download experiment (HTTP ${download.status})`);
  const compressed = await boundedBytes(download.body, asset.size);
  if (compressed.length !== asset.size || `sha256:${createHash('sha256').update(compressed).digest('hex')}` !== asset.digest) {
    throw new Error('Experiment does not match the published size and SHA-256');
  }
  const expanded = await boundedBytes(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
    maxSource + 1024 * 1024,
  );
  const archive = await new Bun.Archive(expanded).files();
  const names = new Set([...source.keys(), ...generated.keys()]);
  if (archive.size !== names.size) throw new Error('Experiment file list differs from canonical PR source');

  const files = new Map<string, Uint8Array>();
  for (const path of names) {
    const entry = archive.get(path);
    if (!entry) throw new Error(`Experiment is missing ${path}`);
    const bytes = Buffer.from(await entry.arrayBuffer());
    const expected = generated.get(path);
    const matches = expected === undefined
      ? createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === source.get(path)
      : bytes.equals(Buffer.from(expected));
    if (!matches) throw new Error(`Experiment file differs from canonical PR source: ${path}`);
    files.set(path, bytes);
  }
  return files;
}

function installedSkill(project: string) {
  const root = realpathSync(project);
  let directory = root;
  for (const part of ['.agents', 'skills', 'agentboard']) {
    directory = join(directory, part);
    if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('Target must have a local AgentBoard install in .agents/skills/agentboard. Run trusted setup first.');
    }
  }
  if (!lstatSync(join(directory, 'scripts'), { throwIfNoEntry: false })?.isDirectory() ||
      !lstatSync(join(directory, 'scripts', 'agentboard.ts'), { throwIfNoEntry: false })?.isFile() ||
      !lstatSync(join(directory, 'SKILL.md'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Target does not contain a complete AgentBoard install. Run trusted setup first.');
  }
  return directory;
}

export async function experiment(
  pr: string, project: string | null, acceptHead: string | null, noUpdate: boolean, fetcher: typeof fetch = fetch,
) {
  if (!validPr(pr)) throw new Error('Enter a positive PR number');
  if ((project === null) !== (acceptHead === null) || (acceptHead !== null && !validCommit(acceptHead))) {
    throw new Error('Installation requires --target PROJECT and --accept-head FULL_SHA');
  }
  if (project !== null && typeof Bun.Archive !== 'function') {
    throw new Error('Experiment installation requires Bun with Archive support. Install Bun 1.4 or newer from https://bun.sh/ and retry.');
  }

  const { head, base } = await currentPull(fetcher, pr);
  const build = { commit: acceptHead ?? head, pr, noUpdate };
  if (acceptHead !== null && acceptHead !== head &&
      !(await previousCommits(fetcher, base, head)).includes(acceptHead)) {
    throw new Error(`Accepted SHA is outside the current history of PR #${pr}. Current head is ${head}.`);
  }
  let published = await publishedBuild(fetcher, build);
  if (!published && acceptHead === null) {
    for (const commit of await previousCommits(fetcher, base, head)) {
      build.commit = commit;
      published = await publishedBuild(fetcher, build);
      if (published) break;
    }
  }
  if (!published) {
    const selection = acceptHead === null ? 'its current history' : acceptHead;
    throw new Error(`No published experiment found for PR #${pr} at ${selection}. Current head is ${head}. Check the Source builds workflow.`);
  }
  const { tag, asset } = published;
  const info = {
    ...build,
    head,
    source: `${github}/pull/${pr}/commits/${build.commit}`,
    release: `${github}/releases/tag/${tag}`,
    digest: asset.digest,
  };
  if (project === null) return { ...info, installed: null };

  const target = installedSkill(project);
  const checkVariant = () => {
    if (!noUpdate && existsSync(join(target, '.agentboard-no-update'))) {
      throw new Error('Target uses the no-update build. Inspect and install the --no-update variant.');
    }
  };
  checkVariant();
  const files = await verifiedFiles(fetcher, build, asset);
  const current = await currentPull(fetcher, pr);
  if (current.head !== head || (build.commit !== head && current.base !== base &&
      !(await previousCommits(fetcher, current.base, head)).includes(build.commit))) {
    throw new Error('PR history moved during verification. Inspect the experiment again.');
  }
  replaceSkill(target, files, () => {
    if (installedSkill(project) !== target) throw new Error('Installation path changed during verification');
    checkVariant();
    return null;
  });
  return { ...info, installed: target };
}
