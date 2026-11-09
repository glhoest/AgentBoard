import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withLock } from './lock';

const releaseUrl = 'https://api.github.com/repos/glhoest/AgentBoard/releases?per_page=100';
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

type Asset = { name: string; browser_download_url: string; digest: string | null; size: number };
type Release = { tag_name: string; assets: Asset[]; published_at: string; draft: boolean; prerelease: boolean };

export async function selectRelease(fetcher: typeof fetch, force = false, now = Date.now()): Promise<Release> {
  const releases: Release[] = [];
  for (let page = 1; ; page++) {
    const response = await fetcher(`${releaseUrl}&page=${page}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentBoard' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Cannot fetch releases (HTTP ${response.status})`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('Invalid release metadata');
    releases.push(...batch);
    if (batch.length < 100) break;
    if (page >= 100) throw new Error('Too many release pages');
  }
  const eligible = releases.filter(r => r && !r.draft && !r.prerelease && typeof r.tag_name === 'string' && stable.test(r.tag_name) && Array.isArray(r.assets) && r.assets.some(a => a.name === 'agentboard.tar.gz') && Number.isFinite(Date.parse(r.published_at)) && Date.parse(r.published_at) <= now && (force || now - Date.parse(r.published_at) >= age));
  eligible.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  if (!eligible.length) throw new Error('No eligible stable AgentBoard release');
  return eligible[0];
}

/** Download and validate the complete release before changing an installation. */
export async function fetchRelease(fetcher: typeof fetch = fetch, force = false, now = Date.now(), installed: string | null = null): Promise<{ tag: string; files: Map<string, Uint8Array> } | { tag: string; files: null }> {
  const release = await selectRelease(fetcher, force, now);
  if (installed && compareVersions(release.tag_name, installed) <= 0) return { tag: installed, files: null };
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
export async function updateInstallation(destination: string, fetcher: typeof fetch = fetch, force = false, now = Date.now()): Promise<{ version: string; changed: boolean }> {
  const target = resolve(destination);
  if (!existsSync(join(target, 'SKILL.md')) || !existsSync(join(target, 'scripts', 'agentboard.ts'))) {
    throw new Error('AgentBoard is not installed at the destination');
  }
  const marker = join(target, '.agentboard-release.json');
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
  const release = await fetchRelease(fetcher, force, now, installed);
  if (!release.files) return { version: release.tag, changed: false };
  const parent = dirname(target);
  const staging = mkdtempSync(join(parent, '.agentboard-update-'));
  const backup = join(parent, `.agentboard-backup-${randomUUID()}`);
  let moved = false;
  try {
    for (const [name, bytes] of release.files) {
      const output = join(staging, ...name.split('/'));
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes);
    }
    writeFileSync(join(staging, '.agentboard-release.json'), JSON.stringify({ version: release.tag }) + '\n');
    return withLock(parent, () => {
      // Another updater may have installed a newer release while this download ran.
      const current = JSON.parse(readFileSync(marker, 'utf8'));
      if (typeof current.version !== 'string' || !stable.test(current.version)) throw new Error('Invalid installed version marker');
      if (compareVersions(release.tag, current.version) <= 0) return { version: current.version, changed: false };
      renameSync(target, backup);
      moved = true;
      try {
        renameSync(staging, target);
      } catch (error) {
        try { renameSync(backup, target); moved = false; }
        catch { throw new Error(`Installation failed; restore the backup at ${backup}`); }
        throw error;
      }
      moved = false;
      try { rmSync(backup, { recursive: true, force: true }); } catch { /* The new installation is already active; leave the backup for manual cleanup. */ }
      return { version: release.tag, changed: true };
    });
  } finally {
    if (!moved && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

