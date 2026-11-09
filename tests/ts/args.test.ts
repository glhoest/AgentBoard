import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../scripts/lib/args';

// Parser behavior: exit-code categories are help (0) and usage error (2).
const ok = (...argv: string[]) => {
  const r = parseArgs(argv);
  if (r.kind !== 'ok') throw new Error(`expected ok for ${argv.join(' ')}: ${r.kind} ${r.text}`);
  return r.args as any;
};
const kind = (...argv: string[]) => parseArgs(argv).kind;

describe('parseArgs commands', () => {
  test('init/setup: optional path defaults to "."', () => {
    expect(ok('init')).toMatchObject({ cmd: 'init', path: '.', root: null, json: false });
    expect(ok('init', 'p').path).toBe('p');
    expect(ok('setup')).toMatchObject({ cmd: 'setup', path: '.' });
    expect(ok('setup', 'r').path).toBe('r');
  });
  test('list: all options', () => {
    expect(ok('list')).toMatchObject({ cmd: 'list', all: false, status: null, assignee: null });
    expect(ok('list', '--all', '--status', 'todo', '--assignee', 'bob')).toMatchObject({ all: true, status: 'todo', assignee: 'bob' });
  });
  test('show/move/claim positionals and revision', () => {
    expect(ok('show', 'AB-1')).toMatchObject({ cmd: 'show', id: 'AB-1' });
    expect(ok('move', 'AB-1', 'done')).toMatchObject({ cmd: 'move', id: 'AB-1', status: 'done', revision: null });
    expect(ok('move', 'AB-1', 'done', '--revision', '4').revision).toBe(4);
    expect(ok('claim', 'AB-1', 'me')).toMatchObject({ cmd: 'claim', id: 'AB-1', assignee: 'me', revision: null });
    expect(ok('claim', 'AB-1', 'me', '--revision', '2').revision).toBe(2);
  });
  test('create: every option, repeated label/criterion', () => {
    expect(ok('create', 'T')).toMatchObject({ cmd: 'create', title: 'T', status: null, priority: null, assignee: null, description: null, label: null, criterion: null });
    expect(ok('create', 'T', '--status', 'todo', '--priority', 'high', '--assignee', 'a', '--description', 'd', '--label', 'x', '--label', 'y', '--criterion', 'c1', '--criterion', 'c2')).toMatchObject({
      status: 'todo', priority: 'high', assignee: 'a', description: 'd', label: ['x', 'y'], criterion: ['c1', 'c2'],
    });
  });
  test('edit: every option', () => {
    expect(ok('edit', 'AB-1')).toMatchObject({ cmd: 'edit', id: 'AB-1', revision: null, title: null, status: null, priority: null, assignee: null, unassign: false, description: null, notes: null, labelsJson: null, criteriaJson: null, archive: false, unarchive: false });
    expect(ok('edit', 'AB-1', '--revision', '3', '--title', 't', '--status', 's', '--priority', 'low', '--assignee', 'a', '--unassign', '--description', 'd', '--notes', 'n', '--labels-json', '["a"]', '--criteria-json', '[]', '--archive', '--unarchive')).toMatchObject({
      revision: 3, title: 't', status: 's', priority: 'low', assignee: 'a', unassign: true, description: 'd', notes: 'n', labelsJson: '["a"]', criteriaJson: '[]', archive: true, unarchive: true,
    });
  });
  test('serve: port and ui', () => {
    expect(ok('serve')).toMatchObject({ cmd: 'serve', port: 0, ui: null });
    expect(ok('serve', '--port', '8080', '--ui', 'x.html')).toMatchObject({ port: 8080, ui: 'x.html' });
  });
  test('thread commands: ask/answer/comment/edit-entry/thread/questions', () => {
    expect(ok('ask', 'AB-1', 'Why?')).toMatchObject({ cmd: 'ask', id: 'AB-1', body: 'Why?', author: null, revision: null });
    expect(ok('ask', 'AB-1', 'Why?', '--author', 'me', '--revision', '3')).toMatchObject({ author: 'me', revision: 3 });
    expect(ok('answer', 'AB-1', 'TH-1', 'Yes')).toMatchObject({ cmd: 'answer', id: 'AB-1', question: 'TH-1', body: 'Yes', author: null, revision: null });
    expect(ok('answer', 'AB-1', 'TH-1', 'Yes', '--au=me', '--rev', '2')).toMatchObject({ author: 'me', revision: 2 });
    expect(ok('comment', 'AB-1', 'Note')).toMatchObject({ cmd: 'comment', id: 'AB-1', body: 'Note', author: null, replyTo: null, revision: null });
    expect(ok('comment', 'AB-1', 'Note', '--reply-to', 'TH-2', '--author', 'a', '--revision=4')).toMatchObject({ replyTo: 'TH-2', author: 'a', revision: 4 });
    expect(ok('comment', 'AB-1', 'Note', '--rep', 'TH-2').replyTo).toBe('TH-2');
    expect(ok('edit-entry', 'AB-1', 'TH-1')).toMatchObject({ cmd: 'edit-entry', id: 'AB-1', entry: 'TH-1', body: null, author: null, revision: null });
    expect(ok('edit-entry', 'AB-1', 'TH-1', '--body', 'b', '--author', 'a', '--revision', '5')).toMatchObject({ body: 'b', author: 'a', revision: 5 });
    expect(ok('thread', 'AB-1')).toMatchObject({ cmd: 'thread', id: 'AB-1' });
    expect(ok('questions')).toMatchObject({ cmd: 'questions', root: null, json: false, quiet: false });
  });
  test('grill: optional card id', () => {
    expect(ok('grill')).toMatchObject({ cmd: 'grill', id: null });
    expect(ok('grill', 'AB-1').id).toBe('AB-1');
    expect(kind('grill', 'a', 'b')).toBe('error');
  });
  test('-- ends options: a body may start with a dash', () => {
    expect(ok('ask', 'AB-1', '--', '-5 degrees?').body).toBe('-5 degrees?');
    expect(ok('comment', 'AB-1', '--author', 'a', '--', '--help')).toMatchObject({ body: '--help', author: 'a' });
    expect(ok('create', '--', '--title').title).toBe('--title');
    expect(kind('ask', 'AB-1', '--', 'a', 'b')).toBe('error');
  });
  test('global --root/--json/--quiet before the subcommand', () => {
    expect(ok('--quiet', 'list').quiet).toBe(true);
    expect(ok('list').quiet).toBe(false);
    expect(kind('--quiet=1', 'list')).toBe('error');
    expect(kind('list', '--quiet')).toBe('error');
    expect(ok('--root', 'r', '--json', 'list')).toMatchObject({ root: 'r', json: true });
    expect(ok('--root=r2', 'list').root).toBe('r2');
  });
});

describe('parseArgs option syntax', () => {
  test('--opt=value', () => {
    expect(ok('create', 'T', '--status=todo').status).toBe('todo');
    expect(ok('create', 'T', '--label=a=b').label).toEqual(['a=b']);
    expect(ok('edit', 'X', '--revision=7').revision).toBe(7);
    expect(ok('serve', '--port=9').port).toBe(9);
  });
  test('unique prefix abbreviations of options', () => {
    expect(ok('list', '--al').all).toBe(true);
    expect(ok('list', '--st', 'x').status).toBe('x');
    expect(ok('create', 'T', '--pri', 'high').priority).toBe('high');
    expect(ok('edit', 'X', '--la', '[]').labelsJson).toBe('[]');
    expect(ok('edit', 'X', '--cr', '[]').criteriaJson).toBe('[]');
    expect(ok('edit', 'X', '--ar').archive).toBe(true);
  });
  test('ambiguous prefixes are errors', () => {
    expect(kind('list', '--a')).toBe('error');        // --all / --assignee
    expect(kind('edit', 'X', '--un')).toBe('error');  // --unassign / --unarchive
  });
  test('--priority choices', () => {
    for (const p of ['low', 'medium', 'high', 'urgent']) {
      expect(ok('create', 'T', '--priority', p).priority).toBe(p);
      expect(ok('edit', 'X', '--priority', p).priority).toBe(p);
    }
    expect(kind('create', 'T', '--priority', 'bogus')).toBe('error');
    expect(kind('edit', 'X', '--priority', 'bogus')).toBe('error');
  });
  test('non-int --revision/--port are errors', () => {
    for (const bad of ['abc', '1.5', '']) {
      expect(kind('edit', 'X', '--revision', bad)).toBe('error');
      expect(kind('move', 'X', 's', '--revision', bad)).toBe('error');
      expect(kind('claim', 'X', 'a', '--revision', bad)).toBe('error');
      expect(kind('serve', '--port', bad)).toBe('error');
    }
    expect(ok('edit', 'X', '--revision', ' 3').revision).toBe(3);   // surrounding whitespace is tolerated
  });
  test('missing option value, bool with value, unknown option', () => {
    expect(kind('list', '--status')).toBe('error');
    expect(kind('list', '--all=1')).toBe('error');
    expect(kind('list', '--nope')).toBe('error');
  });
});

describe('parseArgs errors and help', () => {
  test('global --root/--json after the subcommand are errors', () => {
    expect(kind('list', '--root', 'x')).toBe('error');
    expect(kind('list', '--json')).toBe('error');
    expect(kind('show', 'X', '--json')).toBe('error');
  });
  test('help at top level and per command', () => {
    expect(kind('-h')).toBe('help');
    expect(kind('--help')).toBe('help');
    expect(kind('--json', '-h')).toBe('help');
    for (const c of ['init', 'setup', 'list', 'show', 'create', 'edit', 'move', 'claim', 'ask', 'answer', 'comment', 'edit-entry', 'thread', 'questions', 'grill', 'serve']) {
      for (const flag of ['-h', '--help']) {
        const r = parseArgs([c, flag]);
        expect(r.kind).toBe('help');
        expect((r as any).text).toContain(`usage: agentboard ${c}`);
      }
    }
    expect((parseArgs(['setup', '-h']) as any).text).toContain('[path]');
    expect((parseArgs(['grill', '-h']) as any).text).toContain('[id]');
    const top = (parseArgs(['-h']) as any).text;
    for (const c of ['ask', 'answer', 'comment', 'edit-entry', 'thread', 'questions', 'grill', '--quiet']) expect(top).toContain(c);
  });
  test('unknown command, no command, no subcommand abbreviation', () => {
    expect(kind('bogus')).toBe('error');
    expect(kind()).toBe('error');
    expect(kind('--json')).toBe('error');
    expect(kind('--root')).toBe('error');
    expect(kind('li')).toBe('error');   // subcommands cannot be abbreviated
  });
  test('missing/extra positionals', () => {
    expect(kind('show')).toBe('error');
    expect(kind('create')).toBe('error');
    expect(kind('edit')).toBe('error');
    expect(kind('move', 'X')).toBe('error');
    expect(kind('claim', 'X')).toBe('error');
    expect(kind('thread')).toBe('error');
    expect(kind('edit-entry', 'X')).toBe('error');
    expect(kind('answer', 'X', 'Q')).toBe('error');
    expect(kind('show', 'a', 'b')).toBe('error');
    expect(kind('init', 'a', 'b')).toBe('error');
  });
});
