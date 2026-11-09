import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const releaseUrl = 'https://api.github.com/repos/glhoest/AgentBoard/releases/latest';
const maxArchiveBytes = 20 * 1024 * 1024;
const maxExpandedBytes = 40 * 1024 * 1024;
const allowedRoots = new Set(['SKILL.md', 'README.md', 'LICENSE', '.agentboard-release.json', 'agents', 'assets', 'scripts']);
const required = ['SKILL.md', 'LICENSE', 'scripts/agentboard.ts', 'scripts/board.html', 'scripts/update.ts'];

type Asset = { name: string; browser_download_url: string; digest: string | null; size: number };
type Release = { tag_name: string; assets: Asset[] };

/** Download and validate the complete release before changing an installation. */
export async function fetchRelease(fetcher: typeof fetch = fetch): Promise<{ tag: string; files: Map<string, Uint8Array> }> {
  const response = await fetcher(releaseUrl, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentBoard' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Cannot fetch latest release (HTTP ${response.status})`);
  const release = await response.json() as Release;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name) || !Array.isArray(release.assets)) {
    throw new Error('Invalid release metadata');
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
export async function updateInstallation(destination: string, fetcher: typeof fetch = fetch): Promise<{ version: string; changed: boolean }> {
  const target = resolve(destination);
  if (!existsSync(join(target, 'SKILL.md')) || !existsSync(join(target, 'scripts', 'agentboard.ts'))) {
    throw new Error('AgentBoard is not installed at the destination');
  }
  const release = await fetchRelease(fetcher);
  const marker = join(target, '.agentboard-release.json');
  if (existsSync(marker)) {
    try {
      if (JSON.parse(readFileSync(marker, 'utf8')).version === release.tag) return { version: release.tag, changed: false };
    } catch { /* Replace an invalid marker with a verified release. */ }
  }
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
    renameSync(target, backup);
    moved = true;
    try {
      renameSync(staging, target);
    } catch (error) {
      renameSync(backup, target);
      moved = false;
      throw error;
    }
    moved = false;
    rmSync(backup, { recursive: true, force: true });
    return { version: release.tag, changed: true };
  } finally {
    if (!moved && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const skill = resolve(dirname(import.meta.path), '..');
  const expected = ['.agents', 'skills', 'agentboard'].join(sep);
  if (!skill.endsWith(sep + expected)) {
    console.error('Run this updater from an installed .agents/skills/agentboard copy.');
    process.exit(1);
  }
  try {
    const result = await updateInstallation(skill);
    console.log(result.changed ? `Updated AgentBoard to ${result.version}.` : `AgentBoard is already at ${result.version}.`);
  } catch (error) {
    console.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
