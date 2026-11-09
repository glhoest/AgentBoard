import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const latestReleaseUrl = 'https://api.github.com/repos/glhoest/AgentBoard/releases/latest';
const day = 24 * 60 * 60 * 1000;
const failureRetry = 60 * 60 * 1000;
const stableVersion = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type CheckCache = { checkedAt: number; latest: string | null };

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
  const path = resolve(skill);
  const key = createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
  return join(tmpdir(), `agentboard-update-check-${key}.json`);
}

/** A failed or offline check never stops a board command. */
export async function updateNotice(skill: string, cachePath = updateCachePath(skill), fetcher: typeof fetch = fetch, now = Date.now()): Promise<string | null> {
  let installed: string | null = null;
  try {
    const marker = JSON.parse(readFileSync(join(skill, '.agentboard-release.json'), 'utf8'));
    if (versionParts(marker.version)) installed = marker.version;
  } catch { /* A source installation has no release version. */ }

  let cache: CheckCache | null = null;
  try {
    if (existsSync(cachePath)) {
      const value = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) && value.checkedAt <= now &&
          (value.latest === null || versionParts(value.latest))) cache = value;
    }
  } catch { /* Ignore a damaged cache. */ }

  if (!cache || now - cache.checkedAt >= (cache.latest === null ? failureRetry : day)) {
    let latest: string | null = null;
    try {
      const response = await fetcher(latestReleaseUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentBoard' },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const release = await response.json() as { tag_name?: unknown; assets?: { name?: unknown }[] };
        if (versionParts(release.tag_name) && Array.isArray(release.assets) &&
            release.assets.some(asset => asset.name === 'agentboard.tar.gz')) latest = release.tag_name as string;
      }
    } catch { /* Network failures are non-fatal. */ }
    cache = { checkedAt: now, latest };
    try { writeFileSync(cachePath, JSON.stringify(cache)); } catch { /* Cache is optional. */ }
  }
  if (!cache.latest) return null;
  if (installed === null) return `Latest AgentBoard release: ${cache.latest} (installed version unknown); from the project root, run bun .agents/skills/agentboard/scripts/update.ts to update.`;
  if (!newer(cache.latest, installed)) return null;
  return `AgentBoard ${cache.latest} is available (installed ${installed}); from the project root, run bun .agents/skills/agentboard/scripts/update.ts to update.`;
}
