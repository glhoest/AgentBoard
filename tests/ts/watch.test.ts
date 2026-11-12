import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { init, create, update, addEntry, snapshot, createFeature, updateFeature } from '../../scripts/lib/store';
import { changes } from '../../scripts/lib/watch-events';
import { createIssue, listIssues, updateIssue } from '../../scripts/lib/issues';

const watcher = resolve(import.meta.dir, '../../scripts/watch.ts');
const cli = resolve(import.meta.dir, '../../scripts/agentboard.ts');
const bun = process.execPath;

test('issue events report creation, field changes, status and removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-events-'));
  try {
    init(root);
    const read = () => ({ ...snapshot(root), issues: listIssues(root) });
    const empty = read();
    const issue = createIssue(root, { title: 'Defect' });
    const created = read();
    expect(changes(empty, created)).toEqual([{ type: 'issue.created', id: issue.id }]);
    updateIssue(root, issue.id, issue.revision, { status: 'smoking-rack' });
    const updated = read();
    expect(changes(created, updated).map(event => event.type)).toEqual(['issue.updated', 'issue.status']);
    expect(changes(updated, empty)).toEqual([{ type: 'issue.removed', id: issue.id }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('watcher dispatches issue changes through the issue filter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-watch-issue-'));
  const action = join(root, 'action.ts');
  const output = join(root, 'events.json');
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    init(root);
    writeFileSync(action, 'await Bun.write(process.argv[2], await new Response(Bun.stdin.stream()).text());');
    running = await start(['--root', root, '--interval', '150', '--on', 'issue.created', '--', bun, action, output]);
    const issue = createIssue(root, { title: 'Defect' });
    await until(() => existsSync(output));
    expect(JSON.parse(readFileSync(output, 'utf8')).events).toEqual([{ type: 'issue.created', id: issue.id }]);
  } finally {
    running?.proc.kill();
    if (running) await running.proc.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

async function until(check: () => boolean, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for watcher');
    await Bun.sleep(25);
  }
}

async function start(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([bun, watcher, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const reader = proc.stderr.getReader();
  let output = '';
  const reading = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      output += new TextDecoder().decode(chunk.value);
    }
  })();
  await until(() => output.includes('watcher ready') || proc.exitCode !== null);
  if (!output.includes('watcher ready')) throw new Error(output);
  return { proc, reading, output: () => output };
}

test('events compare content and open-question state, including archive and revert', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-events-'));
  try {
    init(root);
    const empty = snapshot(root);
    const card = create(root, { title: 'A' });
    addEntry(root, card.id, null, { kind: 'question', body: 'Why?' });
    const open = snapshot(root);
    expect(changes(empty, open).map(event => event.type)).toEqual(['card.created', 'question.opened']);
    update(root, card.id, null, { status: 'todo', assignee: 'alice', archived: true });
    const archived = snapshot(root);
    expect(changes(open, archived).map(event => event.type)).toEqual(['card.updated', 'card.status', 'card.assignee', 'question.closed']);
    expect(changes(archived, open).map(event => event.type)).toContain('question.opened');
    const sameRevision = structuredClone(open);
    sameRevision.items[0].title = 'Changed without a revision';
    expect(changes(open, sameRevision)[0].fields).toEqual(['title']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('events include answered questions, feature changes, board changes and removals', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-events-more-'));
  try {
    init(root);
    const card = create(root, { title: 'Card' });
    const asked = addEntry(root, card.id, null, { kind: 'question', body: 'Why?' });
    const base = snapshot(root);
    addEntry(root, card.id, null, { kind: 'answer', body: 'Because', replyTo: asked.thread[0].id });
    const feature = createFeature(root, { title: 'Feature' });
    const next = snapshot(root);
    expect(changes(base, next).map(event => event.type)).toEqual(['card.updated', 'question.closed', 'feature.created']);
    updateFeature(root, feature.id, null, { title: 'Renamed' });
    const edited = snapshot(root);
    edited.config.name = 'Renamed board';
    expect(changes(next, edited).map(event => event.type)).toEqual(['board.updated', 'feature.updated']);
    edited.items = [];
    edited.features = [];
    expect(changes(next, edited).map(event => event.type)).toEqual(['board.updated', 'card.removed', 'feature.removed']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('process action sees filtered events and can write to the board without deadlocking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-watch-'));
  const action = join(root, 'action.ts');
  const output = join(root, 'events.json');
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    init(root);
    writeFileSync(action, `const input = await new Response(Bun.stdin.stream()).text();\nconst batch = JSON.parse(input);\nawait Bun.write(process.argv[2], input);\nconst child = Bun.spawnSync([process.execPath, process.argv[3], '--quiet', 'comment', batch.events[0].id, 'action ran']);\nif (child.exitCode !== 0) process.exit(child.exitCode);\n`);
    running = await start(['--root', root, '--interval', '150', '--on', 'card.created', '--', bun, action, output, cli]);
    await Bun.sleep(300);
    expect(existsSync(output)).toBe(false);
    const card = create(root, { title: 'Trigger' });
    await until(() => snapshot(root, { persist: false }).items.find(item => item.id === card.id)?.thread.length === 1);
    const batch = JSON.parse(readFileSync(output, 'utf8'));
    expect(batch.schema).toBe(1);
    expect(batch.events).toEqual([{ type: 'card.created', id: card.id }]);
    expect(snapshot(root).items[0].thread[0].body).toBe('action ran');
  } finally {
    running?.proc.kill();
    if (running) await running.proc.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('webhook posts a filtered batch with authorization to a local receiver', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-webhook-'));
  let received: { auth: string | null; body: any } | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { auth: request.headers.get('authorization'), body: await request.json() };
    return new Response('ok');
  } });
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    init(root);
    running = await start(['--root', root, '--interval', '150', '--on', 'question.opened', '--webhook'], {
      AGENTBOARD_WEBHOOK_URL: `http://127.0.0.1:${server.port}/hook`, AGENTBOARD_WEBHOOK_AUTHORIZATION: 'Bearer test-secret',
    });
    const card = create(root, { title: 'Question' });
    addEntry(root, card.id, null, { kind: 'question', body: 'Ready?' });
    await until(() => received !== undefined);
    expect(received!.auth).toBe('Bearer test-secret');
    expect(received!.body.events[0]).toMatchObject({ type: 'question.opened', id: card.id });
    expect(running.output()).not.toContain('test-secret');
  } finally {
    running?.proc.kill();
    if (running) await running.proc.exited;
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('invalid snapshots retry from the last good baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-watch-retry-'));
  const output = join(root, 'event.json');
  const action = join(root, 'action.ts');
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    init(root);
    const card = create(root, { title: 'Original' });
    const path = join(root, '.agentboard', 'items', `${card.id}.json`);
    const original = readFileSync(path, 'utf8');
    writeFileSync(action, 'await Bun.write(process.argv[2], await new Response(Bun.stdin.stream()).text());');
    running = await start(['--root', root, '--interval', '150', '--on', 'card.updated', '--', bun, action, output]);
    writeFileSync(path, '<<<<<<< broken');
    await until(() => running!.output().includes('snapshot failed'));
    const changed = JSON.parse(original);
    changed.title = 'Restored with an edit';
    writeFileSync(path, JSON.stringify(changed));
    await until(() => existsSync(output));
    expect(JSON.parse(readFileSync(output, 'utf8')).events[0]).toMatchObject({ type: 'card.updated', id: card.id, fields: ['title'] });
    expect(running.output()).toContain('board readable again');
  } finally {
    running?.proc.kill();
    if (running) await running.proc.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('a hung process is killed and the watcher fails visibly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-watch-timeout-'));
  const action = join(root, 'hang.ts');
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    init(root);
    writeFileSync(action, 'await Bun.sleep(30000);');
    running = await start(['--root', root, '--interval', '150', '--timeout', '300', '--', bun, action]);
    create(root, { title: 'Trigger' });
    expect(await running.proc.exited).toBe(1);
    await running.reading;
    expect(running.output()).toContain('Action timed out');
  } finally {
    running?.proc.kill();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('webhook rejects redirects without disclosing URL or authorization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-watch-redirect-'));
  let redirected = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/target') { redirected = true; return new Response('ok'); }
    return Response.redirect(`http://127.0.0.1:${server.port}/target`, 302);
  } });
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    init(root);
    running = await start(['--root', root, '--interval', '150', '--webhook'], {
      AGENTBOARD_WEBHOOK_URL: `http://127.0.0.1:${server.port}/secret-path`, AGENTBOARD_WEBHOOK_AUTHORIZATION: 'Bearer secret-value',
    });
    create(root, { title: 'Trigger' });
    expect(await running.proc.exited).toBe(1);
    await running.reading;
    expect(redirected).toBe(false);
    expect(running.output()).toContain('Webhook request failed');
    expect(running.output()).not.toContain('secret');
  } finally {
    running?.proc.kill();
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('process actions do not receive webhook secrets and may ignore stdin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-watch-env-'));
  const output = join(root, 'env.json');
  const action = join(root, 'action.ts');
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    init(root);
    writeFileSync(action, 'await Bun.write(process.argv[2], JSON.stringify({url: process.env.AGENTBOARD_WEBHOOK_URL, auth: process.env.AGENTBOARD_WEBHOOK_AUTHORIZATION}));');
    running = await start(['--root', root, '--interval', '150', '--', bun, action, output], {
      AGENTBOARD_WEBHOOK_URL: 'secret-url', AGENTBOARD_WEBHOOK_AUTHORIZATION: 'secret-auth',
    });
    create(root, { title: 'Trigger' });
    await until(() => existsSync(output));
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({});
    await Bun.sleep(250);
    expect(running.proc.exitCode).toBeNull();
  } finally {
    running?.proc.kill();
    if (running) await running.proc.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('argument and URL errors fail before watching without exposing secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-watch-args-'));
  try {
    init(root);
    const run = (args: string[], url = '') => Bun.spawnSync([bun, watcher, '--root', root, ...args], {
      env: { ...process.env, AGENTBOARD_WEBHOOK_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    for (const args of [[], ['--on', 'unknown', '--', bun], ['--interval', '1', '--', bun], ['--webhook', '--', bun], ['--', 'no-such-agentboard-action-123']]) {
      expect(run(args).exitCode).toBe(1);
    }
    for (const url of ['not-a-url-secret', 'http://example.com/secret', 'https://user:secret@example.com/']) {
      const result = run(['--webhook'], url);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).not.toContain('secret');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('newer board format stops rather than retrying', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-watch-newer-'));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    init(root);
    const card = create(root, { title: 'Card' });
    running = await start(['--root', root, '--interval', '150', '--', bun, '-e', '']);
    const path = join(root, '.agentboard', 'items', `${card.id}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.version = '99.0.0';
    writeFileSync(path, JSON.stringify(raw));
    expect(await running.proc.exited).toBe(1);
    await running.reading;
    expect(running.output()).toContain('written by a newer AgentBoard');
  } finally {
    running?.proc.kill();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
