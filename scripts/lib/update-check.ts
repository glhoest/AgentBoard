import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tryWithLock } from './lock';

const latestReleaseUrl = 'https://api.github.com/repos/glhoest/AgentBoard/releases/latest';
const day = 24 * 60 * 60 * 1000;
const stableVersion = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type CheckCache = { checkedAt: number; latest: string | null; publishedAt?: number | null };

export const updateLockRoot = join(homedir(), '.cache', 'agentboard', 'update-check');

function versionParts(version: unknown): number[] | null {
  if (typeof version !== 'string') return null;
  const match = stableVersion.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function newer(latest: string, installed: string): boolean {
  const a = versionParts(latest), b = versionParts(installed);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function updateCachePath(skill: string): string {
  let path = resolve(skill);
  try { path = realpathSync.native(path); } catch { /* Fall back if the installation is unavailable. */ }
  const key = createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
  return join(tmpdir(), `agentboard-update-check-${key}.json`);
}

/** A failed or offline check never stops a board command. */
export async function updateNotice(skill: string, cachePath = updateCachePath(skill), fetcher: typeof fetch = fetch, now = Date.now(), lockRoot = updateLockRoot): Promise<string | null> {
  let installed: string | null = null;
  try {
    const marker = JSON.parse(readFileSync(join(skill, '.agentboard-release.json'), 'utf8'));
    if (versionParts(marker.version)) installed = marker.version;
  } catch { /* A source installation has no release version. */ }

  let cache: CheckCache | null = null;
  let shouldCheck = false;
  try {
    mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
    // Reserve the check before networking, so concurrent processes and failures share the limit.
    tryWithLock(lockRoot, () => {
      try {
        if (existsSync(cachePath)) {
          const value = JSON.parse(readFileSync(cachePath, 'utf8'));
          if (typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) && value.checkedAt <= now &&
              (value.latest === null || versionParts(value.latest))) cache = value;
        }
      } catch { /* Treat damaged cache as missing. */ }
      if (!cache || now - cache.checkedAt >= day) {
        cache = { checkedAt: now, latest: null };
        writeFileSync(cachePath, JSON.stringify(cache));
        shouldCheck = true;
      }
    });
  } catch { return null; } // Without durable reservation, do not make a network request.

  if (shouldCheck) {
    let latest: string | null = null;
    let publishedAt: number | null = null;
    try {
      const response = await fetcher(latestReleaseUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentBoard' },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const release = await response.json() as { tag_name?: unknown; published_at?: unknown; assets?: { name?: unknown }[] };
        if (versionParts(release.tag_name) && Array.isArray(release.assets) &&
            release.assets.some(asset => asset.name === 'agentboard.tar.gz')) {
          latest = release.tag_name as string;
          const time = typeof release.published_at === 'string' ? Date.parse(release.published_at) : NaN;
          if (Number.isFinite(time) && time <= now) publishedAt = time;
        }
      }
    } catch { /* Network failures are non-fatal. */ }
    cache = { checkedAt: now, latest, publishedAt };
    try { tryWithLock(lockRoot, () => writeFileSync(cachePath, JSON.stringify(cache))); } catch { /* The reservation remains valid. */ }
  }
  if (!cache?.latest) return null;
  if (installed === null) return `Latest AgentBoard release: ${cache.latest} (installed version unknown); use setup from a known source to update.`;
  if (!newer(cache.latest, installed)) return null;
  const ageNotice = typeof cache.publishedAt === 'number' && cache.publishedAt <= now && now - cache.publishedAt < 7 * day
    ? ' This release is less than seven days old; the default update waits until it reaches seven days.' : '';
  return `AgentBoard ${cache.latest} is published (installed ${installed}).${ageNotice} Run bun .agents/skills/agentboard/scripts/agentboard.ts update to update.`;
}
