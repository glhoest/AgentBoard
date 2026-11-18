import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  generatedFiles, maxDownload, maxSource, sourceFiles, validCommit, validPr,
} from '../../scripts/lib/distribution';

const [commit, prArg, directory] = process.argv.slice(2);
const pr = prArg === '-' ? null : prArg;
if (!validCommit(commit) || (pr !== null && !validPr(pr)) || !directory) throw new Error('Invalid build inputs');

function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`Git failed: ${args[0]}`);
  return result.stdout;
}

// Read Git objects directly. No checkout, attributes, hooks, or PR scripts are used.
const entries = git('ls-tree', '-rtz', commit).toString().split('\0').filter(Boolean).map(entry => {
  const tab = entry.indexOf('\t');
  const [mode, type, sha] = entry.slice(0, tab).split(' ');
  return { path: entry.slice(tab + 1), mode, type, sha };
});
mkdirSync(directory, { recursive: true });
for (const noUpdate of [false, true]) {
  const build = { commit, pr, noUpdate };
  const generated = generatedFiles(build);
  const files = new Map<string, string | Uint8Array>(generated);
  let expanded = 0;
  for (const [path, sha] of sourceFiles(entries, noUpdate)) {
    if (generated.has(path)) continue;
    const size = Number(git('cat-file', '-s', sha).toString());
    expanded += size;
    if (!Number.isSafeInteger(size) || size < 0 || expanded > maxSource) throw new Error('Source is too large');
    files.set(path, git('cat-file', 'blob', sha));
  }
  const asset = noUpdate ? 'agentboard-no-update.tar.gz' : 'agentboard.tar.gz';
  const bytes = await new Bun.Archive(Object.fromEntries(files), { compress: 'gzip' }).bytes();
  if (bytes.length > maxDownload) throw new Error('Archive is too large');
  await Bun.write(join(directory, asset), bytes);
}
