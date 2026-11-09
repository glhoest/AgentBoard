import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { BoardError } from './types';
import { config, init } from './store';

// Development material of the skill repository itself; never vendored into target repositories.
// '.agents' and '.claude' hold the repository's own dogfood install and agent settings (vendoring '.agents' would nest copies).
const skipped = new Set(['tests', 'docs', '.github', '.git', 'node_modules', '.gitignore', '.gitattributes', 'AGENTS.md', 'CLAUDE.md', 'HANDOVER.md', 'CONTRIBUTING.md',
  '.agentboard', '.agentboard.lock', '.agents', '.claude']);
const begin = '<!-- agentboard:begin -->';
const end = '<!-- agentboard:end -->';
const guide = begin + '\n## AgentBoard\n' +
  'Project work is tracked on the repository AgentBoard in `.agentboard/` (commit it). Agents: follow `.agents/skills/agentboard/SKILL.md`; CLI `bun .agents/skills/agentboard/scripts/agentboard.ts --help`. Humans: run `bun .agents/skills/agentboard/scripts/agentboard.ts serve` and open the printed URL.\n' + end + '\n';

function files(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (skipped.has(name)) continue;
    const path = join(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) found.push(...files(path));
    else if (info.isFile()) found.push(path);
  }
  return found.sort();
}

export function setup(target: string, skillDirectory: string) {
  const root = resolve(target);
  const source = resolve(skillDirectory);
  const changed: string[] = [];
  if (!existsSync(join(source, 'SKILL.md')) || !existsSync(join(source, 'scripts', 'board.html'))) {
    throw new BoardError('Run setup from the skill bundle (<skill>/scripts/agentboard.ts next to board.html, below SKILL.md)');
  }
  if (!statSync(root).isDirectory()) throw new BoardError(`Not a directory: ${root}`);

  function put(path: string, bytes: Uint8Array) {
    if (existsSync(path) && Buffer.compare(readFileSync(path), bytes) === 0) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    changed.push(relative(root, path).split(sep).join('/'));
  }

  const destination = join(root, '.agents', 'skills', 'agentboard');
  if (source !== resolve(destination)) {
    for (const path of files(source)) {
      put(join(destination, relative(source, path)), readFileSync(path));
    }
  }
  const skillText = readFileSync(join(source, 'SKILL.md'), 'utf8');
  const description = skillText.match(/^description:\s*(.+)$/m)?.[1].trim() ?? 'Manage the repository AgentBoard.';
  const adapter = '---\nname: agentboard\ndescription: ' + description +
    '\n---\n\n# AgentBoard\n\nThe skill is shared with other agents at `.agents/skills/agentboard/`. Read `.agents/skills/agentboard/SKILL.md` from the repository root and follow it; there, `<skill-directory>` means `.agents/skills/agentboard`.\n';
  put(join(root, '.claude', 'skills', 'agentboard', 'SKILL.md'), Buffer.from(adapter));

  const board = join(root, '.agentboard', 'board.json');
  // An existing board is only checked here (older formats upgrade in memory); the CLI upgrades it on first use.
  if (existsSync(board) && statSync(board).isFile()) config(root, { persist: false });
  else {
    init(root);
    changed.push('.agentboard/');
  }

  const ignore = join(root, '.gitignore');
  const ignoreText = existsSync(ignore) ? readFileSync(ignore).toString('utf8') : '';
  if (!ignoreText.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).includes('/.agentboard.lock')) {
    put(ignore, Buffer.from(ignoreText + (ignoreText && !ignoreText.endsWith('\n') ? '\n' : '') + '/.agentboard.lock\n'));
  }

  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(root, name);
    if (name === 'CLAUDE.md' && !existsSync(path)) continue;
    const text = existsSync(path) ? readFileSync(path).toString('utf8') : '';
    if (name === 'CLAUDE.md' && text.includes('@AGENTS.md')) continue;
    let updated: string;
    if (text.includes(begin) && text.includes(end)) {
      updated = text.slice(0, text.indexOf(begin)) + guide.replace(/\n+$/, '') + text.slice(text.indexOf(end) + end.length);
    } else {
      updated = text + (text ? (text.endsWith('\n') ? '' : '\n') + '\n' : '') + guide;
    }
    put(path, Buffer.from(updated));
  }

  return {
    root,
    changed,
    notes: existsSync(join(root, '.git')) ? [] : ['No .git found here; setup belongs at the repository root.'],
    next: 'Review and commit the changes. Board UI: bun .agents/skills/agentboard/scripts/agentboard.ts serve',
  };
}
