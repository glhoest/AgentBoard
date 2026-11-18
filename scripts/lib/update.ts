import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { replaceSkill } from './install';
import { publishedBuild, verifiedFiles } from './experiment';
import { noUpdatePath } from './distribution';

const api = 'https://api.github.com/repos/glhoest/AgentBoard';
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentBoard' };
const age = 7 * 24 * 60 * 60 * 1000;
const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareVersions(a: string, b: string): number {
  const x = stable.exec(a), y = stable.exec(b);
  if (!x || !y) throw new Error('Invalid installed or release version');
  for (let i = 1; i <= 3; i++) {
    const left = BigInt(x[i]), right = BigInt(y[i]);
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}
const maxArchiveBytes = 20 * 1024 * 1024;
const maxExpandedBytes = 40 * 1024 * 1024;
const allowedRoots = new Set(['SKILL.md', 'README.md', 'LICENSE', '.agentboard-release.json', 'agents', 'assets', 'scripts']);
const required = ['SKILL.md', 'LICENSE', 'scripts/agentboard.ts', 'scripts/board.html', 'scripts/lib/update.ts'];

async function updateBeta(target: string, fetcher: typeof fetch, force: boolean, now: number, selector: string) {
  const get = (path: string) => fetcher(api + path, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  const explicit = selector !== 'beta' ? selector.slice(5) : null;
  let selected: { commit: string; asset: { url: string; digest: string; size: number } } | null = null;
  for (let page = 1; page <= 100 && selected === null; page++) {
    const response = await get(`/commits?sha=main&per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`Cannot inspect main history (HTTP ${response.status})`);
    const commits = await response.json();
    if (!Array.isArray(commits)) throw new Error('Invalid main history');
    for (const entry of commits) {
      if (typeof entry?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(entry.sha)) throw new Error('Invalid main commit');
      if (explicit && entry.sha !== explicit) continue;
      const tag = `beta-${entry.sha}`;
      const releaseResponse = await get(`/releases/tags/${tag}`);
      if (releaseResponse.status === 404) continue;
      if (!releaseResponse.ok) throw new Error(`Cannot inspect beta release (HTTP ${releaseResponse.status})`);
      const release = await releaseResponse.json();
      const published = Date.parse(release?.published_at);
      if (release?.tag_name !== tag || release?.draft !== false || release?.prerelease !== true ||
          !Number.isFinite(published) || published > now || (!force && now - published < 3 * 86400000)) continue;
      const build = { commit: entry.sha, pr: null, noUpdate: false };
      const result = await publishedBuild(fetcher, build, release);
      if (result) selected = { commit: entry.sha, asset: result.asset };
      if (selected || explicit) break;
    }
    if (commits.length < 100 || (explicit && selected)) break;
  }
  if (!selected) throw new Error('No eligible beta on main; use --force for a recent beta');
  const marker = join(target, '.agentboard-build.json');
  const stableMarker = join(target, '.agentboard-release.json');
  const before = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
  const stableBefore = existsSync(stableMarker) ? readFileSync(stableMarker, 'utf8') : null;
  if (before) {
    const current = JSON.parse(before);
    if (current.channel === 'beta' && current.commit === selected.commit) return { version: `beta-${selected.commit}`, changed: false };
    if (current.channel === 'beta' && /^[a-f0-9]{40}$/.test(current.commit) && !(force && explicit)) {
      const comparison = await get(`/compare/${selected.commit}...${current.commit}`);
      if (!comparison.ok) throw new Error(`Cannot compare beta versions (HTTP ${comparison.status})`);
      const relation = await comparison.json();
      if (relation?.status !== 'behind') throw new Error('Beta downgrade or unrelated version requires --force');
    }
  }
  const files = await verifiedFiles(fetcher, { commit: selected.commit, pr: null, noUpdate: false }, selected.asset);
  replaceSkill(target, files, () => {
    if (existsSync(join(target, noUpdatePath))) throw new Error('This AgentBoard build does not support updates');
    const current = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
    const stableCurrent = existsSync(stableMarker) ? readFileSync(stableMarker, 'utf8') : null;
    if (current !== before || stableCurrent !== stableBefore) throw new Error('Installation changed during update; retry');
    return null;
  });
  return { version: `beta-${selected.commit}`, changed: true };
}

type Asset = { name: string; browser_download_url: string; digest: string | null; size: number };
type Release = { tag_name: string; assets: Asset[]; published_at: string; draft: boolean; prerelease: boolean };

export async function selectRelease(fetcher: typeof fetch, force = false, now = Date.now(), exact: string | null = null): Promise<Release> {
  const get = (path: string) => fetcher(api + path, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (exact !== null) {
    if (!stable.test(exact)) throw new Error('Invalid stable version');
    const response = await get(`/releases/tags/${exact}`);
    if (!response.ok) throw new Error(`Cannot fetch release ${exact} (HTTP ${response.status})`);
    const release = await response.json();
    const published = Date.parse(release?.published_at);
    if (release?.tag_name !== exact || release.draft !== false || release.prerelease !== false ||
        !Array.isArray(release.assets) || !release.assets.some(asset => asset?.name === 'agentboard.tar.gz') ||
        !Number.isFinite(published) || published > now || (!force && now - published < age)) {
      throw new Error('Requested stable release is unavailable or too recent');
    }
    return release;
  }
  // Source builds have beta-/experiment- tags and never enter this lookup.
  const refs = await get('/git/matching-refs/tags/v');
  if (!refs.ok) throw new Error(`Cannot fetch release tags (HTTP ${refs.status})`);
  const entries = await refs.json();
  if (!Array.isArray(entries)) throw new Error('Invalid release tag metadata');
  const prefix = 'refs/tags/';
  const tags = new Set<string>();
  for (const entry of entries) {
    if (typeof entry?.ref !== 'string' || !entry.ref.startsWith(prefix)) continue;
    const tag = entry.ref.slice(prefix.length);
    if (stable.test(tag)) tags.add(tag);
  }
  for (const tag of [...tags].sort((a, b) => compareVersions(b, a))) {
    const response = await get(`/releases/tags/${tag}`);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Cannot fetch release ${tag} (HTTP ${response.status})`);
    const release = await response.json();
    if (release?.tag_name !== tag) throw new Error('Invalid release metadata');
    const published = Date.parse(release.published_at);
    if (release.draft === false && release.prerelease === false &&
        Array.isArray(release.assets) && release.assets.some(asset => asset?.name === 'agentboard.tar.gz') &&
        Number.isFinite(published) && published <= now && (force || now - published >= age)) {
      return release;
    }
  }
  throw new Error('No eligible stable AgentBoard release');
}

/** Download and validate the complete release before changing an installation. */
export async function fetchRelease(fetcher: typeof fetch = fetch, force = false, now = Date.now(), installed: string | null = null, exact: string | null = null): Promise<{ tag: string; files: Map<string, Uint8Array> } | { tag: string; files: null }> {
  const release = await selectRelease(fetcher, force, now, exact);
  if (installed) {
    const order = compareVersions(release.tag_name, installed);
    if (order === 0) return { tag: installed, files: null };
    if (order < 0 && exact !== null && !force) throw new Error('Downgrade requires --force');
    if (order < 0 && exact === null) return { tag: installed, files: null };
  }
  const assets = release.assets.filter(asset => asset.name === 'agentboard.tar.gz');
  if (assets.length !== 1) throw new Error('Latest release does not contain one AgentBoard artifact');
  const asset = assets[0];
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/glhoest/AgentBoard/releases/download/')) {
    throw new Error('Invalid artifact URL');
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxArchiveBytes || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
    throw new Error('Artifact size or SHA-256 digest is missing or invalid');
  }
  const download = await fetcher(url, { signal: AbortSignal.timeout(60000) });
  if (!download.ok) throw new Error(`Cannot download artifact (HTTP ${download.status})`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.length !== asset.size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) {
    throw new Error('Artifact size or SHA-256 digest does not match the release');
  }
  const entries = await new Bun.Archive(bytes).files();
  const files = new Map<string, Uint8Array>();
  let expanded = 0;
  for (const [raw, file] of entries) {
    const name = raw.replace(/^\.\//, '');
    const parts = name.split('/');
    if (!name || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes(':')) || !allowedRoots.has(parts[0])) {
      throw new Error(`Invalid artifact path: ${raw}`);
    }
    if (files.has(name)) throw new Error(`Duplicate artifact path: ${name}`);
    expanded += file.size;
    if (expanded > maxExpandedBytes) throw new Error('Artifact is too large');
    files.set(name, new Uint8Array(await file.arrayBuffer()));
  }
  if (required.some(name => !files.has(name))) throw new Error('Artifact is missing required files');
  return { tag: release.tag_name, files };
}

/** Replace only the vendored skill; restore the old directory if installation fails. */
export async function updateInstallation(destination: string, fetcher: typeof fetch = fetch, force = false, now = Date.now(), selector: string | null = null): Promise<{ version: string; changed: boolean }> {
  const target = resolve(destination);
  if (existsSync(join(target, noUpdatePath))) throw new Error('This AgentBoard build does not support updates');
  if (!existsSync(join(target, 'SKILL.md')) || !existsSync(join(target, 'scripts', 'agentboard.ts'))) {
    throw new Error('AgentBoard is not installed at the destination');
  }
  if (selector === 'beta' || /^beta-[a-f0-9]{40}$/.test(selector ?? '')) {
    return updateBeta(target, fetcher, force, now, selector);
  }
  const exact = selector === null || selector === 'latest' ? null :
    (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(selector) ? `v${selector}` : selector);
  if (exact !== null && !stable.test(exact)) throw new Error('Invalid version; use latest, beta, vMAJOR.MINOR.PATCH, or beta-FULL_SHA');
  const marker = join(target, '.agentboard-release.json');
  const sourceMarker = join(target, '.agentboard-build.json');
  const sourceBefore = existsSync(sourceMarker) ? readFileSync(sourceMarker, 'utf8') : null;
  if (sourceBefore !== null) {
    const source = JSON.parse(sourceBefore);
    if (source.channel !== 'beta' || !/^[a-f0-9]{40}$/.test(source.commit) || source.noUpdate !== false) {
      throw new Error('Return from an experiment using a trusted installation');
    }
    const release = await fetchRelease(fetcher, force, now, null, exact);
    if (!release.files) throw new Error('Stable release has no files');
    release.files.set('.agentboard-release.json', Buffer.from(JSON.stringify({ version: release.tag }) + '\n'));
    replaceSkill(target, release.files, () => {
      if (existsSync(join(target, noUpdatePath))) throw new Error('This AgentBoard build does not support updates');
      if (!existsSync(sourceMarker) || readFileSync(sourceMarker, 'utf8') !== sourceBefore) throw new Error('Installation changed during update; retry');
      return null;
    });
    return { version: release.tag, changed: true };
  }
  let installed: string | null = null;
  if (existsSync(marker)) {
    let data: { version?: unknown };
    try { data = JSON.parse(readFileSync(marker, 'utf8')); } catch { throw new Error('Invalid installed version marker'); }
    if (typeof data.version !== 'string' || !stable.test(data.version)) throw new Error('Invalid installed version marker');
    installed = data.version;
  }
  if (installed === null) {
    await selectRelease(fetcher, force, now);
    throw new Error('Installed version is unknown; use setup from a known source instead of risking a downgrade');
  }
  const release = await fetchRelease(fetcher, force, now, installed, exact);
  if (!release.files) return { version: release.tag, changed: false };
  const files = release.files;
  files.set('.agentboard-release.json', Buffer.from(JSON.stringify({ version: release.tag }) + '\n'));
  return replaceSkill(target, files, () => {
    if (existsSync(join(target, noUpdatePath))) throw new Error('This AgentBoard build does not support updates');
    // Another updater may have installed a newer release while this download ran.
    const current = JSON.parse(readFileSync(marker, 'utf8'));
    if (typeof current.version !== 'string' || !stable.test(current.version)) throw new Error('Invalid installed version marker');
    if (current.version !== installed) throw new Error('Installation changed during update; retry');
    return null;
  }) ?? { version: release.tag, changed: true };
}
