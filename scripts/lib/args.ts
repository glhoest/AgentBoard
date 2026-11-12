import { PRIORITIES, type Priority } from './types';

export type Common = { root: string | null; json: boolean; quiet: boolean };
export type Command =
  | { cmd: 'init' | 'setup'; path: string }
  | { cmd: 'list'; all: boolean; status: string | null; assignee: string | null; feature: string | null }
  | { cmd: 'show'; id: string }
  | { cmd: 'create'; title: string; status: string | null; priority: Priority | null; assignee: string | null; description: string | null; label: string[] | null; criterion: string[] | null; feature: string | null }
  | { cmd: 'edit'; id: string; revision: number | null; title: string | null; status: string | null; priority: Priority | null; assignee: string | null; unassign: boolean; description: string | null; notes: string | null; labelsJson: string | null; criteriaJson: string | null; archive: boolean; unarchive: boolean; feature: string | null; clearFeature: boolean }
  | { cmd: 'feature-create'; title: string; status: string | null; description: string | null }
  | { cmd: 'feature-edit'; id: string; revision: number | null; title: string | null; status: string | null; description: string | null; archive: boolean; unarchive: boolean }
  | { cmd: 'feature-move'; id: string; status: string; revision: number | null }
  | { cmd: 'feature-show'; id: string }
  | { cmd: 'features'; includeArchived: boolean }
  | { cmd: 'move'; id: string; status: string; revision: number | null }
  | { cmd: 'claim'; id: string; assignee: string; revision: number | null }
  | { cmd: 'ask'; id: string; body: string; author: string | null; revision: number | null }
  | { cmd: 'answer'; id: string; question: string; body: string; author: string | null; revision: number | null }
  | { cmd: 'comment'; id: string; body: string; author: string | null; replyTo: string | null; revision: number | null }
  | { cmd: 'edit-entry'; id: string; entry: string; body: string | null; author: string | null; revision: number | null }
  | { cmd: 'thread'; id: string }
  | { cmd: 'questions' }
  | { cmd: 'grill'; id: string | null }
  | { cmd: 'update'; force: boolean }
  | { cmd: 'issues' }
  | { cmd: 'issue-show'; id: string }
  | { cmd: 'issue-create'; title: string; observed: string | null; expected: string | null; reproduction: string | null }
  | { cmd: 'issue-edit'; id: string; revision: number | null; title: string | null; status: string | null; observed: string | null; expected: string | null; reproduction: string | null; criteriaJson: string | null; workItem: string | null; closureReason: string | null; duplicateOf: string | null }
  | { cmd: 'issue-evidence'; id: string; body: string; revision: number | null }
  | { cmd: 'issue-promote'; id: string; revision: number | null; workItem: string | null }
  | { cmd: 'serve'; port: number; ui: string | null };
export type ParseResult = { kind: 'ok'; args: Common & Command } | { kind: 'help'; text: string } | { kind: 'error'; text: string };

// Argument types: 'pos' positional, 'str' option with a value, 'int', 'priority' (choice), 'bool' flag,
// 'append' repeatable option collected into an array. Dashed names become camelCase keys (--reply-to -> replyTo).
const specs: Record<string, [string, string][]> = {
  issues: [],
  'issue-show': [['id', 'pos']],
  'issue-create': [['title', 'pos'], ['observed', 'str'], ['expected', 'str'], ['reproduction', 'str']],
  'issue-edit': [['id', 'pos'], ['revision', 'int'], ['title', 'str'], ['status', 'str'], ['observed', 'str'], ['expected', 'str'], ['reproduction', 'str'], ['criteria-json', 'str'], ['work-item', 'str'], ['closure-reason', 'str'], ['duplicate-of', 'str']],
  'issue-evidence': [['id', 'pos'], ['body', 'pos'], ['revision', 'int']],
  'issue-promote': [['id', 'pos'], ['revision', 'int'], ['work-item', 'str']],
  init: [['path', 'pos']],
  setup: [['path', 'pos']],
  list: [['all', 'bool'], ['status', 'str'], ['assignee', 'str'], ['feature', 'str']],
  show: [['id', 'pos']],
  create: [['title', 'pos'], ['status', 'str'], ['priority', 'priority'], ['assignee', 'str'], ['description', 'str'], ['label', 'append'], ['criterion', 'append'], ['feature', 'str']],
  edit: [['id', 'pos'], ['revision', 'int'], ['title', 'str'], ['status', 'str'], ['priority', 'priority'], ['assignee', 'str'], ['unassign', 'bool'], ['description', 'str'], ['notes', 'str'], ['labels-json', 'str'], ['criteria-json', 'str'], ['archive', 'bool'], ['unarchive', 'bool'], ['feature', 'str'], ['clear-feature', 'bool']],
  'feature-create': [['title', 'pos'], ['status', 'str'], ['description', 'str']],
  'feature-edit': [['id', 'pos'], ['revision', 'int'], ['title', 'str'], ['status', 'str'], ['description', 'str'], ['archive', 'bool'], ['unarchive', 'bool']],
  'feature-move': [['id', 'pos'], ['status', 'pos'], ['revision', 'int']],
  'feature-show': [['id', 'pos']],
  features: [['include-archived', 'bool']],
  move: [['id', 'pos'], ['status', 'pos'], ['revision', 'int']],
  claim: [['id', 'pos'], ['assignee', 'pos'], ['revision', 'int']],
  ask: [['id', 'pos'], ['body', 'pos'], ['author', 'str'], ['revision', 'int']],
  answer: [['id', 'pos'], ['question', 'pos'], ['body', 'pos'], ['author', 'str'], ['revision', 'int']],
  comment: [['id', 'pos'], ['body', 'pos'], ['author', 'str'], ['reply-to', 'str'], ['revision', 'int']],
  'edit-entry': [['id', 'pos'], ['entry', 'pos'], ['body', 'str'], ['author', 'str'], ['revision', 'int']],
  thread: [['id', 'pos']],
  questions: [],
  grill: [['id', 'pos']],
  update: [['force', 'bool']],
  serve: [['port', 'int'], ['ui', 'str']],
};
// Commands whose positional is optional: init/setup default to '.', grill to all cards in Needs grilling.
const optionalPositional = new Set(['init', 'setup', 'grill']);
const commands = Object.keys(specs);
const usage = 'usage: agentboard [-h] [--root ROOT] [--json] [--quiet] {' + commands.join(', ') + '} ...';

const summaries: Record<string, string> = {
  setup: 'Install the skill and board into a repository\n                        (idempotent)',
  ask: 'Post a question on a card (stays open until answered)',
  answer: 'Answer a question on a card',
  comment: 'Post a comment on a card',
  'edit-entry': 'Edit the body or author of a thread entry',
  thread: 'Print the thread of a card',
  questions: 'List open questions on non-archived cards',
  grill: 'Print a grilling brief for cards in Needs grilling',
};

// Split at the first '=' only (String.split's limit would drop the rest of the value).
function splitEq(token: string): [string, string | undefined] {
  const at = token.indexOf('=');
  return at < 0 ? [token, undefined] : [token.slice(0, at), token.slice(at + 1)];
}

function camel(key: string): string {
  return key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function helpText(command?: string): string {
  if (!command) {
    const lines = Object.entries(summaries).map(([name, text]) => `    ${name.padEnd(20)}${text}`);
    return `${usage}\n\nFile-backed agent board. Bun runtime.\n\npositional arguments:\n  {${commands.join(',')}}\n${lines.join('\n')}\n\n` +
      'options:\n  -h, --help            show this help message and exit\n  --root ROOT           Project root (otherwise discover upward)\n' +
      '  --json                Machine-readable output\n  --quiet               Suppress notices and automatic update checks';
  }
  const args = specs[command];
  const positional = args.filter(([, type]) => type === 'pos').map(([key]) => optionalPositional.has(command) ? `[${key}]` : key);
  const options = args.filter(([, type]) => type !== 'pos');
  const synopsis = options.map(([key, type]) => type === 'bool' ? `[--${key}]` : `[--${key} ${key.toUpperCase()}]`).join(' ');
  const positionalHelp = positional.length ? `positional arguments:\n${positional.map(key => `  ${key}`).join('\n')}\n\n` : '';
  const optionHelp = options.map(([key, type]) => `\n  --${key}${type === 'bool' ? '' : ` ${key.toUpperCase()}`}`).join('');
  return `usage: agentboard ${command} [-h]${synopsis ? ` ${synopsis}` : ''}${positional.map(key => ` ${key}`).join('')}\n\n` +
    `${positionalHelp}options:\n  -h, --help  show this help message and exit${optionHelp}`;
}

export function parseArgs(argv: string[]): ParseResult {
  let root: string | null = null, json = false, quiet = false, i = 0;
  const error = (message: string, u = usage): ParseResult => ({ kind: 'error', text: `${u}\nagentboard: error: ${message}` });
  while (i < argv.length && argv[i].startsWith('-')) {
    const token = argv[i++], [name, inline] = splitEq(token);
    if (name === '-h' || name === '--help') return { kind: 'help', text: helpText() };
    if (name === '--json' && inline === undefined) { json = true; continue; }
    if (name === '--quiet' && inline === undefined) { quiet = true; continue; }
    if (name === '--root') { const value = inline ?? argv[i++]; if (value === undefined) return error('argument --root: expected one argument'); root = value; continue; }
    return error(`unrecognized arguments: ${token}`);
  }
  const cmd = argv[i++];
  if (!cmd) return error('the following arguments are required: cmd');
  if (!specs[cmd]) return error(`argument cmd: invalid choice: '${cmd}' (choose from ${commands.join(', ')})`);
  const entries = specs[cmd], positionals = entries.filter(([, type]) => type === 'pos').map(([key]) => key);
  const values: Record<string, any> = {};
  for (const [key, type] of entries) values[key] = type === 'bool' ? false : null;
  let p = 0, onlyPositionals = false;
  while (i < argv.length) {
    const token = argv[i++];
    // '--' ends the options: everything after it is positional (e.g. a body that starts with '-').
    if (token === '--' && !onlyPositionals) { onlyPositionals = true; continue; }
    if (!onlyPositionals && (token === '-h' || token === '--help')) return { kind: 'help', text: helpText(cmd) };
    if (onlyPositionals || !token.startsWith('-')) { if (p >= positionals.length) return error(`unrecognized arguments: ${token}`); values[positionals[p++]] = token; continue; }
    const [name, inline] = splitEq(token);
    const matches = entries.filter(([key, type]) => type !== 'pos' && `--${key}`.startsWith(name));
    if (!matches.length) return error(`unrecognized arguments: ${token}`);
    if (matches.length > 1) return error(`ambiguous option: ${name} could match ${matches.map(([key]) => `--${key}`).join(', ')}`);
    const [key, type] = matches[0];
    if (type === 'bool') { if (inline !== undefined) return error(`argument --${key}: ignored explicit argument`); values[key] = true; continue; }
    const value = inline ?? argv[i++];
    if (value === undefined) return error(`argument --${key}: expected one argument`);
    if (type === 'int') { if (!/^\s*[+-]?\d+\s*$/.test(value)) return error(`argument --${key}: invalid int value: '${value}'`); values[key] = Number(value); }
    else if (type === 'priority') { if (!PRIORITIES.includes(value as Priority)) return error(`argument --${key}: invalid choice: '${value}' (choose from ${PRIORITIES.join(', ')})`); values[key] = value; }
    else if (type === 'append') (values[key] ??= []).push(value);
    else values[key] = value;
  }
  const required = optionalPositional.has(cmd) ? [] : positionals;
  if (p < required.length) return error(`the following arguments are required: ${required.slice(p).join(', ')}`);
  if (cmd === 'edit' && values.feature !== null && values['clear-feature']) return error('argument --clear-feature: not allowed with --feature');
  if (cmd === 'init' || cmd === 'setup') values.path ??= '.';
  if (cmd === 'serve') { values.port ??= 0; values.ui ??= null; }
  const named: Record<string, any> = {};
  for (const [key, value] of Object.entries(values)) named[camel(key)] = value;
  return { kind: 'ok', args: { root, json, quiet, cmd, ...named } as Common & Command };
}
