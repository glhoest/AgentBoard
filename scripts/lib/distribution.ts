export const repository = 'glhoest/AgentBoard';
export const provenancePath = '.agentboard-build.json';
export const noUpdatePath = '.agentboard-no-update';
export const noticePath = 'scripts/lib/update-check.ts';
export const disabledNotice = 'export async function updateNotice() { return null; }\n';
export const removedUpdaters = new Set(['scripts/update.ts', 'scripts/lib/update.ts', 'scripts/lib/experiment.ts']);
export const maxDownload = 20 * 1024 * 1024;
export const maxSource = 40 * 1024 * 1024;

export type Build = { commit: string; pr: string | null; noUpdate: boolean };

export function validCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

export function validPr(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value);
}

export function buildTag({ pr, commit }: Build) {
  return pr === null ? `beta-${commit}` : `experiment-${pr}-${commit}`;
}

export function provenance(build: Build) {
  return JSON.stringify({
    schema: 1,
    repository,
    channel: build.pr === null ? 'beta' : 'experiment',
    ...build,
  }) + '\n';
}

export function inDistribution(path: string) {
  return ['SKILL.md', 'README.md', 'LICENSE'].includes(path) || /^(agents|assets|scripts)(\/|$)/.test(path);
}

export type SourceEntry = { path: string; mode: string; type: string; sha: string };

export function sourceFiles(entries: SourceEntry[], noUpdate: boolean) {
  const files = new Map<string, string>();
  const paths = new Set<string>();
  for (const { path, mode, type, sha } of entries) {
    if (!inDistribution(path)) continue;
    for (const part of path.split('/')) {
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) || part.endsWith('.') ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part)) {
        throw new Error(`Unsafe source path: ${JSON.stringify(path)}`);
      }
    }
    const folded = path.toLowerCase();
    if (paths.has(folded)) throw new Error(`Conflicting source path: ${path}`);
    paths.add(folded);
    if (type === 'tree' && ['agents', 'assets', 'scripts'].includes(path.split('/')[0])) continue;
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || !validCommit(sha) || ['agents', 'assets', 'scripts'].includes(path)) {
      throw new Error(`Expected regular source file: ${path}`);
    }
    if (noUpdate && removedUpdaters.has(path)) continue;
    files.set(path, sha);
  }
  for (const required of ['SKILL.md', 'README.md', 'LICENSE', 'scripts/agentboard.ts', 'scripts/board.html', noticePath]) {
    if (!files.has(required)) throw new Error(`Source is missing ${required}`);
  }
  return files;
}

/** Generated files are derived from trusted inputs, never from the archive's claims. */
export function generatedFiles(build: Build) {
  const files = new Map([[provenancePath, provenance(build)]]);
  if (build.noUpdate) {
    files.set(noUpdatePath, '');
    files.set(noticePath, disabledNotice);
  }
  return files;
}
