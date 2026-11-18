import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  generatedFiles, maxDownload, maxSource, sourceFiles, validCommit, validPr,
} from '../../scripts/lib/distribution';

const [commit, channel, directory, version] = process.argv.slice(2);
const stable = channel === '--stable';
const pr = channel === '-' || stable ? null : channel;
if (!validCommit(commit) || (pr !== null && !validPr(pr)) || !directory ||
    (stable ? !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') : version !== undefined)) {
  throw new Error('Invalid build inputs');
}

function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`Git failed: ${args[0]}`);
  return result.stdout;
}

// Read Git objects directly. No checkout, attributes, hooks, or PR scripts are used.
const entries = git('ls-tree', '-rtz', `${commit}^{commit}`).toString().split('\0').filter(Boolean).map(entry => {
  const tab = entry.indexOf('\t');
  const [mode, type, sha] = entry.slice(0, tab).split(' ');
  return { path: entry.slice(tab + 1), mode, type, sha };
});
async function packageVariant(staging: string, noUpdate: boolean) {
  const build = { commit, pr, noUpdate };
  const generated = generatedFiles(build);
  if (stable) {
    generated.delete('.agentboard-build.json');
    generated.set('.agentboard-release.json', JSON.stringify({ version }) + '\n');
  }
  const files = new Map<string, string | Uint8Array>(generated);
  let expanded = 0;
  for (const [path, sha] of sourceFiles(entries, noUpdate)) {
    if (generated.has(path)) continue;
    const size = Number(git('cat-file', '-s', sha).toString());
    expanded += size;
    if (!Number.isSafeInteger(size) || size < 0 || expanded > maxSource) throw new Error('Source is too large');
    const bytes = git('cat-file', 'blob', sha);
    if (stable && noUpdate && path === 'README.md') {
      files.set(path, '> **No-update build:** self-update and automatic network checks are unavailable.\n' + bytes.toString());
    } else if (stable && noUpdate && path === 'SKILL.md') {
      files.set(path, bytes.toString().replace(/^# AgentBoard$/m,
        '$&\nThis is the no-update build: self-update and automatic network checks are unavailable.'));
    } else {
      files.set(path, bytes);
    }
  }
  const asset = noUpdate ? 'agentboard-no-update.tar.gz' : 'agentboard.tar.gz';
  const bytes = await new Bun.Archive(Object.fromEntries(files), { compress: 'gzip' }).bytes();
  if (bytes.length > maxDownload) throw new Error('Archive is too large');
  await Bun.write(join(staging, asset), bytes);
}

// Expose the build to artifact upload only after both variants succeed.
const parent = dirname(directory);
mkdirSync(parent, { recursive: true });
const staging = mkdtempSync(join(parent, '.package-'));
try {
  await packageVariant(staging, false);
  await packageVariant(staging, true);
  renameSync(staging, directory);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
