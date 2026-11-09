// Q&A thread inside the card (card 1.1.0): store rules and limits, CLI commands, the stderr notice, grill.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../scripts/lib/store';
import { BoardError, Conflict, type Entry } from '../../scripts/lib/types';

setDefaultTimeout(60000);

const CLI = join(import.meta.dir, '../../scripts/agentboard.ts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const original = { ...store.seams };
afterEach(() => Object.assign(store.seams, original));

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-thread-'));
  dirs.push(root);
  store.init(root);
  return root;
}

function cli(root: string | null, args: string[], env: Record<string, string | undefined> = {}) {
  const fullEnv: Record<string, string | undefined> = { ...process.env, AGENTBOARD_AUTHOR: undefined, ...env };
  const r = Bun.spawnSync(['bun', CLI, ...(root ? ['--root', root] : []), ...args], { stdout: 'pipe', stderr: 'pipe', env: fullEnv as any });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const json = (root: string, ...args: string[]) => {
  const r = cli(root, ['--json', ...args]);
  if (r.code !== 0) throw new Error(`${args.join(' ')} failed: ${r.err}`);
  return JSON.parse(r.out);
};

function entry(id: string, kind: Entry['kind'], replyTo: string | null = null): Entry {
  return { id, kind, author: null, body: 'b', replyTo, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}
const thId = (n: number) => 'TH-' + n.toString(16).toUpperCase().padStart(12, '0');

describe('thread in the store', () => {
  test('posting and editing entries are normal card writes (revision + 1, same timestamp)', () => {
    const root = project();
    const card = store.create(root, { title: 'Card' });
    const asked = store.addEntry(root, card.id, 1, { kind: 'question', body: 'Why?', author: 'agent' });
    expect(asked.revision).toBe(2);
    const q = asked.thread[0];
    expect(q).toMatchObject({ kind: 'question', body: 'Why?', author: 'agent', replyTo: null });
    expect(q.id).toMatch(/^TH-[0-9A-F]{12}$/);
    expect(q.createdAt).toBe(asked.updatedAt);
    expect(Object.keys(q)).toEqual(['id', 'kind', 'author', 'body', 'replyTo', 'createdAt', 'updatedAt']);
    expect(store.openQuestions(asked).map(e => e.id)).toEqual([q.id]);

    const answered = store.addEntry(root, card.id, null, { kind: 'answer', body: 'Because.', replyTo: q.id });
    expect(answered.revision).toBe(3);
    expect(answered.thread[1]).toMatchObject({ kind: 'answer', author: null, replyTo: q.id });
    expect(store.openQuestions(answered)).toEqual([]);

    store.seams.now = () => '2030-01-01T00:00:00.000Z';
    const edited = store.editEntry(root, card.id, q.id, 3, { body: 'Why, really?', author: 'someone' });
    expect(edited.revision).toBe(4);
    expect(edited.thread[0]).toMatchObject({ body: 'Why, really?', author: 'someone', createdAt: q.createdAt, updatedAt: '2030-01-01T00:00:00.000Z' });
    expect(edited.updatedAt).toBe('2030-01-01T00:00:00.000Z');
    expect(store.editEntry(root, card.id, q.id, null, { author: null }).thread[0].author).toBeNull();
    expect(store.get(root, card.id).thread).toHaveLength(2);
  });

  test('replyTo rules: questions reply to nothing, answers to a question, comments to any earlier entry', () => {
    const root = project();
    const id = store.create(root, { title: 'Card' }).id;
    const c = store.addEntry(root, id, null, { kind: 'comment', body: 'note' }).thread[0];
    const q = store.addEntry(root, id, null, { kind: 'question', body: 'q?' }).thread[1];
    expect(() => store.addEntry(root, id, null, { kind: 'question', body: 'x', replyTo: c.id })).toThrow('A question cannot reply to an entry');
    expect(() => store.addEntry(root, id, null, { kind: 'answer', body: 'x' })).toThrow('An answer must reply to a question on this card');
    expect(() => store.addEntry(root, id, null, { kind: 'answer', body: 'x', replyTo: c.id })).toThrow('An answer must reply to a question on this card');
    expect(() => store.addEntry(root, id, null, { kind: 'answer', body: 'x', replyTo: thId(999) })).toThrow('An answer must reply to a question');
    expect(() => store.addEntry(root, id, null, { kind: 'comment', body: 'x', replyTo: thId(999) })).toThrow('A comment can only reply to an existing entry');
    const a = store.addEntry(root, id, null, { kind: 'answer', body: 'yes', replyTo: q.id }).thread[2];
    expect(store.addEntry(root, id, null, { kind: 'comment', body: 'thanks', replyTo: a.id }).thread[3].replyTo).toBe(a.id);
    // A second card's question is not on this card.
    const other = store.create(root, { title: 'Other' }).id;
    expect(() => store.addEntry(root, other, null, { kind: 'answer', body: 'x', replyTo: q.id })).toThrow(BoardError);
    expect(store.get(root, id).revision).toBe(5);
  });

  test('author and body limits', () => {
    const root = project();
    const id = store.create(root, { title: 'Card' }).id;
    for (const author of ['', '   ', 'a'.repeat(121), 7 as any]) {
      expect(() => store.addEntry(root, id, null, { kind: 'comment', body: 'b', author }), String(author)).toThrow('Author must be 1–120 characters');
    }
    for (const body of ['', ' \n ', 'b'.repeat(20001), null as any]) {
      expect(() => store.addEntry(root, id, null, { kind: 'comment', body }), String(body).slice(0, 9)).toThrow('Entry body must be 1–20,000 characters');
    }
    expect(store.addEntry(root, id, null, { kind: 'comment', body: 'b'.repeat(20000), author: 'a'.repeat(120) }).thread).toHaveLength(1);
    expect(() => store.addEntry(root, id, null, { kind: 'note' as any, body: 'b' })).toThrow('Unknown thread entry kind');
    expect(() => store.addEntry(root, id, null, { kind: 'comment', body: 'b', extra: 1 } as any)).toThrow('Expected an entry with kind and body');
    expect(() => store.addEntry(root, id, null, { body: 'b' } as any)).toThrow('Expected an entry with kind and body');
    const e = store.get(root, id).thread[0];
    expect(() => store.editEntry(root, id, e.id, null, { body: '' })).toThrow('Entry body must be');
    expect(() => store.editEntry(root, id, e.id, null, {})).toThrow('Invalid or empty entry changes');
    expect(() => store.editEntry(root, id, e.id, null, { kind: 'question' } as any)).toThrow('Invalid or empty entry changes');
    expect(() => store.editEntry(root, id, thId(42), null, { body: 'x' })).toThrow(`No thread entry ${thId(42)} on ${id}`);
    expect(() => store.editEntry(root, id, 'TH-1', null, { body: 'x' })).toThrow('Invalid thread entry ID');
    expect(store.get(root, id).revision).toBe(2);
  });

  test('at most 500 entries per card', () => {
    const root = project();
    const card = store.create(root, { title: 'Full' });
    const path = store.itemPath(root, card.id);
    const full = { ...card, thread: Array.from({ length: 500 }, (_, i) => entry(thId(i + 1), 'comment')) };
    writeFileSync(path, JSON.stringify(full, null, 2) + '\n');
    expect(store.get(root, card.id).thread).toHaveLength(500);
    const bytes = readFileSync(path, 'utf8');
    expect(() => store.addEntry(root, card.id, null, { kind: 'comment', body: 'one more' })).toThrow('A thread holds at most 500 entries');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    writeFileSync(path, JSON.stringify({ ...full, thread: [...full.thread, entry(thId(501), 'comment')] }, null, 2) + '\n');
    expect(() => store.get(root, card.id)).toThrow('A thread holds at most 500 entries');
  });

  test('hand-written threads are validated strictly', () => {
    const root = project();
    const card = store.create(root, { title: 'Strict' });
    const path = store.itemPath(root, card.id);
    const write = (patch: object) => writeFileSync(path, JSON.stringify({ ...card, ...patch }, null, 2) + '\n');
    const cases: [object, string][] = [
      [{ thread: {} }, 'Invalid thread'],
      [{ thread: [{ ...entry(thId(1), 'comment'), extra: 1 }] }, 'Invalid thread entry structure'],
      [{ thread: [entry('TH-xyz', 'comment')] }, 'Invalid thread entry ID'],
      [{ thread: [entry(thId(1), 'comment'), entry(thId(1), 'comment')] }, 'Duplicate thread entry ID'],
      [{ thread: [{ ...entry(thId(1), 'comment'), createdAt: 'yesterday' }] }, 'Invalid entry createdAt'],
      [{ thread: [entry(thId(2), 'answer', thId(1)), entry(thId(1), 'question')] }, 'An answer must reply to a question'],
      [{ thread: [entry(thId(1), 'comment', thId(1))] }, 'A comment can only reply to an existing entry'],
      [{ feature: 'nope' }, 'Invalid feature'],
    ];
    for (const [patch, message] of cases) {
      write(patch);
      expect(() => store.get(root, card.id), message).toThrow(message);
    }
    write({ feature: 'FT-0123456789AB' });
    expect(store.get(root, card.id).feature).toBe('FT-0123456789AB');
  });

  test('stale revision and changed hash conflict like any edit', () => {
    const root = project();
    const id = store.create(root, { title: 'Card' }).id;
    store.addEntry(root, id, 1, { kind: 'question', body: 'q' });
    expect(() => store.addEntry(root, id, 1, { kind: 'comment', body: 'stale' })).toThrow(Conflict);
    const q = store.get(root, id).thread[0];
    expect(() => store.editEntry(root, id, q.id, 1, { body: 'stale' })).toThrow('Revision mismatch; current revision is 2');
    expect(() => store.addEntry(root, id, 2, { kind: 'comment', body: 'x' }, { expectedHash: '0'.repeat(64) })).toThrow('Item file changed since it was read');
    expect(store.get(root, id).thread).toHaveLength(1);
  });

  test('entry ids are collision-checked within the card', () => {
    const root = project();
    const id = store.create(root, { title: 'Card' }).id;
    const values = ['00000000000A', '00000000000A', '00000000000B'];
    store.seams.randomHex = () => values.shift() ?? '00000000000A';
    expect(store.addEntry(root, id, null, { kind: 'comment', body: '1' }).thread[0].id).toBe('TH-00000000000A');
    expect(store.addEntry(root, id, null, { kind: 'comment', body: '2' }).thread[1].id).toBe('TH-00000000000B');
    expect(() => store.addEntry(root, id, null, { kind: 'comment', body: '3' })).toThrow('ID collision; retry');
  });

  test('thread cannot be set through create or update', () => {
    const root = project();
    expect(() => store.create(root, { title: 'x', thread: [] } as any)).toThrow('Unknown item fields: thread');
    const id = store.create(root, { title: 'x' }).id;
    expect(() => store.update(root, id, null, { thread: [] } as any)).toThrow('Invalid or empty changes');
  });

  test('init creates board.json 1.1.0 with Needs grilling after Backlog and the default feature columns', () => {
    const root = project();
    const board = JSON.parse(readFileSync(store.boardPath(root), 'utf8'));
    expect(Object.keys(board)).toEqual(['version', 'name', 'columns', 'featureColumns']);
    expect(board.version).toBe('1.1.0');
    expect(board.columns.slice(0, 3)).toEqual([{ id: 'backlog', name: 'Backlog' }, { id: 'needs-grilling', name: 'Needs grilling' }, { id: 'todo', name: 'To do' }]);
    expect(board.featureColumns.map((c: any) => c.id)).toEqual(['planned', 'active', 'done']);
    expect(store.create(root, { title: 'x' }).status).toBe('backlog');
  });

  test('board.json featureColumns are validated like columns', () => {
    const root = project();
    const board = JSON.parse(readFileSync(store.boardPath(root), 'utf8'));
    for (const featureColumns of [[], [{ id: 'Bad', name: 'x' }], [{ id: 'a', name: ' ' }], [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }], undefined]) {
      writeFileSync(store.boardPath(root), JSON.stringify({ ...board, featureColumns }, null, 2) + '\n');
      expect(() => store.config(root), JSON.stringify(featureColumns)).toThrow(BoardError);
    }
  });
});

describe('thread CLI', () => {
  test('ask, comment, answer, edit-entry, thread and questions', () => {
    const root = project();
    const card = json(root, 'create', 'Card');
    const q = json(root, 'ask', card.id, 'Which DB?', '--author', 'agent-a').thread[0];
    expect(q).toMatchObject({ kind: 'question', author: 'agent-a', body: 'Which DB?' });
    const c = json(root, 'comment', card.id, 'Postgres is in use elsewhere.', '--reply-to', q.id, '--revision', '2').thread[1];
    expect(c).toMatchObject({ kind: 'comment', replyTo: q.id, author: null });
    expect(json(root, 'questions')).toEqual([{ item: card.id, title: 'Card', status: 'backlog', question: q }]);
    const answered = json(root, 'answer', card.id, q.id, 'Postgres.', '--author', 'human');
    expect(answered.thread[2]).toMatchObject({ kind: 'answer', replyTo: q.id, author: 'human' });
    expect(json(root, 'questions')).toEqual([]);
    const edited = json(root, 'edit-entry', card.id, c.id, '--body', 'Edited', '--author', 'agent-b', '--revision', '4');
    expect(edited.thread[1]).toMatchObject({ body: 'Edited', author: 'agent-b' });
    expect(json(root, 'thread', card.id)).toEqual(edited.thread);
    const pretty = cli(root, ['thread', card.id]);
    expect(pretty.out).toBe(JSON.stringify(edited.thread, null, 2) + '\n');
  });

  test('archived cards reject ask but allow other thread writes', () => {
    const root = project();
    const id = json(root, 'create', 'Archived').id;
    const q = json(root, 'ask', id, 'Question').thread[0];
    json(root, 'edit', id, '--archive');
    const rejected = cli(root, ['ask', id, 'Another question']);
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain('Unarchive the card first');
    json(root, 'answer', id, q.id, 'Answer');
    const comment = json(root, 'comment', id, 'Comment').thread.at(-1);
    expect(json(root, 'edit-entry', id, comment.id, '--body', 'Edited').thread.at(-1).body).toBe('Edited');
  });

  test('author falls back to AGENTBOARD_AUTHOR; --author wins; a body may start with "-" after --', () => {
    const root = project();
    const id = json(root, 'create', 'Card').id;
    const env = (value: string | undefined, ...args: string[]) => JSON.parse(cli(root, ['--json', ...args], { AGENTBOARD_AUTHOR: value }).out);
    expect(env('env-agent', 'ask', id, 'q1').thread.at(-1).author).toBe('env-agent');
    expect(env('env-agent', 'comment', id, 'c1', '--author', 'explicit').thread.at(-1).author).toBe('explicit');
    expect(env('', 'comment', id, 'c2').thread.at(-1).author).toBeNull();
    expect(env(undefined, 'comment', id, '--', '-5 degrees').thread.at(-1).body).toBe('-5 degrees');
  });

  test('error paths and exit codes', () => {
    const root = project();
    const id = json(root, 'create', 'Card').id;
    const q = json(root, 'ask', id, 'q').thread[0];
    const expectError = (args: string[], code: number, text: string) => {
      const r = cli(root, args);
      expect(r.code, args.join(' ')).toBe(code);
      expect(r.out).toBe('');
      expect(r.err).toContain(text);
    };
    expectError(['ask', id, 'stale', '--revision', '1'], 2, 'Error: Revision mismatch; current revision is 2');
    expectError(['answer', id, q.id, 'stale', '--revision', '1'], 2, 'Revision mismatch');
    expectError(['edit-entry', id, q.id, '--body', 'x', '--revision', '1'], 2, 'Revision mismatch');
    expectError(['ask', 'AB-000000000000', 'q'], 1, 'Error: Cannot read');
    expectError(['ask', 'bad', 'q'], 1, 'Error: Invalid item ID');
    expectError(['ask', id, ''], 1, 'Error: Entry body must be 1–20,000 characters');
    expectError(['answer', id, thId(7), 'a'], 1, 'Error: An answer must reply to a question on this card');
    expectError(['comment', id, 'c', '--reply-to', thId(7)], 1, 'A comment can only reply to an existing entry');
    expectError(['edit-entry', id, q.id], 1, 'Error: Nothing to change: pass --body and/or --author');
    expectError(['edit-entry', id, thId(7), '--body', 'x'], 1, `Error: No thread entry ${thId(7)} on ${id}`);
    expectError(['ask', id, 'q', '--author', ''], 1, 'Error: Author must be 1–120 characters');
    expectError(['thread', 'AB-000000000000'], 1, 'Error: Cannot read');
    expectError(['ask', id], 2, 'the following arguments are required: body');
    expectError(['answer', id, q.id], 2, 'the following arguments are required: body');
    expectError(['comment', id, 'x', '--revision', 'two'], 2, "invalid int value: 'two'");
    expectError(['questions', 'extra'], 2, 'unrecognized arguments: extra');
    expect(json(root, 'show', id).revision).toBe(2);
  });
});

describe('open-question notice on stderr', () => {
  test('present after any command while questions are open; stdout is byte-identical; --quiet suppresses', () => {
    const root = project();
    const a = json(root, 'create', 'A').id;
    const plain = cli(root, ['list']);
    expect(plain.err).toBe('');
    const q = json(root, 'ask', a, 'Open?').thread[0];
    const b = json(root, 'create', 'B').id;
    json(root, 'ask', b, 'Also open?');

    for (const args of [['list'], ['--json', 'show', a], ['questions'], ['create', 'C']]) {
      const loud = cli(root, args);
      const quiet = cli(root, ['--quiet', ...args]);
      expect(loud.code).toBe(0);
      expect(quiet.code).toBe(0);
      expect(quiet.err).toBe('');
      expect(loud.err).toBe(`2 open questions on ${[a, b].sort().join(', ')} — run "questions"\n`);
      if (args[0] !== 'create') expect(loud.out).toBe(quiet.out);
    }

    json(root, 'answer', a, q.id, 'Answered.');
    expect(cli(root, ['list']).err).toBe(`1 open question on ${b} — run "questions"\n`);
    json(root, 'edit', b, '--archive');   // archived cards do not count
    expect(cli(root, ['list']).err).toBe('');
  });

  test('never changes exit codes; absent for help, usage errors, a board that fails to load', () => {
    const root = project();
    const id = json(root, 'create', 'A').id;
    json(root, 'ask', id, 'Open?');
    const notice = `1 open question on ${id} — run "questions"\n`;

    const failed = cli(root, ['move', id, 'nowhere']);
    expect(failed.code).toBe(1);
    expect(failed.err).toBe(`Error: Unknown status\n${notice}`);
    const conflict = cli(root, ['edit', id, '--revision', '1', '--title', 'x']);
    expect(conflict.code).toBe(2);
    expect(conflict.err.endsWith(notice)).toBe(true);

    expect(cli(root, ['--help']).err).toBe('');
    expect(cli(root, ['list', '--bogus']).err).not.toContain('open question');

    writeFileSync(store.boardPath(root), '{broken');
    const broken = cli(root, ['list']);
    expect(broken.code).toBe(1);
    expect(broken.err.trim().split('\n')).toHaveLength(1);
    expect(broken.err).toStartWith('Error: Cannot read');
  });

  test('lists at most 10 card ids', () => {
    const root = project();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = store.create(root, { title: `Q${i}` }).id;
      store.addEntry(root, id, null, { kind: 'question', body: 'q' });
      ids.push(id);
    }
    ids.sort();
    expect(cli(root, ['--json', 'questions']).err).toBe(`12 open questions on ${ids.slice(0, 10).join(', ')} (+2 more) — run "questions"\n`);
  });
});

describe('grill', () => {
  test('brief for the Needs grilling column or one card; --json is structured', () => {
    const root = project();
    const card = json(root, 'create', 'Decide storage', '--description', 'Line 1\nLine 2', '--criterion', 'Chosen', '--priority', 'high');
    const other = json(root, 'create', 'Other');
    expect(cli(root, ['grill']).out).toBe('No cards in Needs grilling.\n');
    const q1 = json(root, 'ask', card.id, 'SQL or files?', '--author', 'agent-a').thread[0];
    const q2 = json(root, 'ask', card.id, 'Backups?\nHow often?').thread[1];
    json(root, 'answer', card.id, q1.id, 'Files.');
    const q3 = json(root, 'ask', card.id, 'Retention?').thread[3];
    json(root, 'move', card.id, 'needs-grilling');
    json(root, 'ask', other.id, 'Ignored: not in the column');

    const brief = cli(root, ['--quiet', 'grill']);
    expect(brief.code).toBe(0);
    expect(brief.err).toBe('');
    expect(brief.out).toBe([
      'Grilling brief: 1 card in Needs grilling',
      '',
      `## ${card.id}: Decide storage`,
      'Status: needs-grilling | Priority: high | Assignee: none',
      '',
      'Description:',
      '  Line 1',
      '  Line 2',
      '',
      'Acceptance criteria:',
      '  - [ ] Chosen',
      '',
      'Open questions (2):',
      `  - ${q2.id}:`,
      '      Backups?',
      '      How often?',
      `  - ${q3.id}:`,
      '      Retention?',
      '',
      'Answer each question with: answer CARD_ID QUESTION_ID "answer"',
      'When a card has no open questions left: move CARD_ID todo',
      '',
    ].join('\n'));

    const structured = json(root, 'grill');
    expect(structured).toHaveLength(1);
    expect(structured[0]).toMatchObject({ id: card.id, title: 'Decide storage', acceptanceCriteria: [{ text: 'Chosen', done: false }] });
    expect(structured[0].openQuestions.map((e: Entry) => e.id)).toEqual([q2.id, q3.id]);

    const single = cli(root, ['--quiet', 'grill', other.id]).out;
    expect(single.startsWith(`Grilling brief\n\n## ${other.id}: Other\n`)).toBe(true);
    expect(single).toContain('Ignored: not in the column');

    json(root, 'edit', card.id, '--archive');
    expect(cli(root, ['grill']).out).toBe('No cards in Needs grilling.\n');
  });

  test('a board without the column gives a clear error (a card ID still works)', () => {
    const root = project();
    const id = json(root, 'create', 'Card').id;
    const board = JSON.parse(readFileSync(store.boardPath(root), 'utf8'));
    board.columns = board.columns.filter((c: any) => c.id !== 'needs-grilling');
    writeFileSync(store.boardPath(root), JSON.stringify(board, null, 2) + '\n');
    const r = cli(root, ['grill']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Error: This board has no "needs-grilling" column');
    expect(cli(root, ['grill', id]).code).toBe(0);
  });
});
