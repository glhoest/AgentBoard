import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../scripts/lib/store';
import * as issues from '../../scripts/lib/issues';
import { Conflict } from '../../scripts/lib/types';
import { main } from '../../scripts/agentboard';
import { startBridge } from '../../scripts/lib/serve';

test('triage promotion, shared work lifecycle and evidence reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issues-'));
  try {
    store.init(root);
    const first = issues.createIssue(root, { title: 'Defect' });
    expect(() => issues.promoteIssue(root, first.id, 1)).toThrow('Promotion requires');
    const ready = issues.updateIssue(root, first.id, 1, {
      observed: 'crash',
      expected: 'success',
      reproduction: 'steps unavailable',
      criteria: ['No crash'],
    });
    const promoted = issues.promoteIssue(root, first.id, ready.revision);
    const other = issues.createIssue(root, {
      title: 'Related',
      observed: 'crash',
      expected: 'success',
      reproduction: 'steps',
    });
    const otherReady = issues.updateIssue(root, other.id, other.revision, { criteria: ['No crash'] });
    issues.promoteIssue(root, other.id, otherReady.revision, promoted.workItem);
    store.update(root, promoted.workItem!, null, { status: 'done' });
    expect(issues.getIssue(root, first.id).status).toBe('closed');
    expect(issues.getIssue(root, other.id).status).toBe('closed');
    issues.addEvidence(root, first.id, null, 'Still happens');
    store.update(root, promoted.workItem!, null, { status: 'done' });
    expect(issues.getIssue(root, first.id).status).toBe('new');
    store.update(root, promoted.workItem!, null, { status: 'todo' });
    expect(issues.getIssue(root, other.id).status).toBe('new');
    store.update(root, promoted.workItem!, null, { status: 'done' });
    expect(issues.getIssue(root, first.id).status).toBe('new');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('issue revisions, hashes, validation and CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issues-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root, { title: 'Defect' });
    const hash = issues.hashIssue(root, issue.id);
    writeFileSync(
      issues.issuePath(root, issue.id),
      readFileSync(issues.issuePath(root, issue.id), 'utf8') + ' ',
    );
    expect(() => issues.addEvidence(root, issue.id, 1, 'evidence', { expectedHash: hash })).toThrow(Conflict);
    issues.addEvidence(root, issue.id, 1, 'evidence');
    expect(() => issues.updateIssue(root, issue.id, 1, { title: 'stale' })).toThrow(Conflict);
    expect(() => issues.updateIssue(root, issue.id, null, { status: 'closed' })).toThrow('reason');
    const closed = issues.updateIssue(root, issue.id, null, {
      status: 'closed',
      closureReason: 'Not a defect',
    });
    expect(issues.addEvidence(root, issue.id, closed.revision, 'new evidence').status).toBe('new');
    const output: string[] = [];
    expect(
      main(['--quiet', '--root', root, 'issues'], {
        out: (s) => output.push(s),
        err: (s) => output.push(s),
        env: {},
      }),
    ).toBe(0);
    expect(JSON.parse(output[0])[0].id).toBe(issue.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent evidence writes reject stale revisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-race-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root, { title: 'Race' });
    const cli = join(import.meta.dir, '../../scripts/agentboard.ts');
    const processes = ['one', 'two'].map((body) =>
      Bun.spawn(
        [
          process.execPath,
          cli,
          '--quiet',
          '--root',
          root,
          'issue-evidence',
          issue.id,
          body,
          '--revision',
          '1',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      ),
    );
    const codes = await Promise.all(processes.map((p) => p.exited));
    expect(codes.sort()).toEqual([0, 2]);
    expect(issues.getIssue(root, issue.id).evidence).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retains previous work and flags unavailable links; sync failures can be retried', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-sync-'));
  try {
    store.init(root);
    const created = issues.createIssue(root, {
      title: 'Defect',
      observed: 'bad',
      expected: 'good',
      reproduction: 'steps',
    });
    const ready = issues.updateIssue(root, created.id, 1, { criteria: ['fixed'] });
    const first = issues.promoteIssue(root, created.id, ready.revision);
    issues.issueSeams.beforeSyncWrite = () => {
      throw new Error('injected write failure');
    };
    expect(() => store.update(root, first.workItem!, null, { status: 'done' })).toThrow('was saved');
    expect(issues.getIssue(root, first.id).status).toBe('ready-for-work');
    issues.issueSeams.beforeSyncWrite = () => {};
    store.update(root, first.workItem!, null, { status: 'done' });
    expect(issues.getIssue(root, first.id).status).toBe('closed');
    issues.addEvidence(root, first.id, null, 'still broken');
    const followup = issues.promoteIssue(root, first.id, null);
    expect(followup.workHistory).toEqual([first.workItem]);
    store.update(root, first.workItem!, null, { archived: true });
    expect(issues.issueSummary(root, followup).unavailableWorkItems).toEqual([first.workItem]);
    store.update(root, followup.workItem!, null, { status: 'done' });
    store.update(root, followup.workItem!, null, { status: 'todo' });
    expect(issues.getIssue(root, first.id).status).toBe('new');
    store.update(root, followup.workItem!, null, { status: 'done' });
    expect(issues.getIssue(root, first.id).status).toBe('closed');
  } finally {
    issues.issueSeams.beforeSyncWrite = () => {};
    rmSync(root, { recursive: true, force: true });
  }
});

test('work following is explicit and survives triage changes, but manual closures stay closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-follow-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root, {
      title: 'Defect',
      observed: 'bad',
      expected: 'good',
      reproduction: 'steps',
    });
    const ready = issues.updateIssue(root, issue.id, 1, { criteria: ['fixed'] });
    const promoted = issues.promoteIssue(root, issue.id, ready.revision);
    issues.updateIssue(root, issue.id, null, { status: 'gathering-data' });
    store.update(root, promoted.workItem!, null, { status: 'done' });
    expect(issues.getIssue(root, issue.id).closureKind).toBe('work');
    store.update(root, promoted.workItem!, null, { status: 'todo' });
    issues.updateIssue(root, issue.id, null, { status: 'closed', closureReason: 'Linked work completed' });
    store.update(root, promoted.workItem!, null, { status: 'done' });
    store.update(root, promoted.workItem!, null, { status: 'todo' });
    expect(issues.getIssue(root, issue.id).closureKind).toBe('manual');
    expect(issues.getIssue(root, issue.id).status).toBe('closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed issue blocks status changes before saving but not unrelated card edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-corrupt-'));
  try {
    store.init(root);
    const card = store.create(root, { title: 'Work' });
    const issue = issues.createIssue(root, { title: 'Defect' });
    writeFileSync(issues.issuePath(root, issue.id), '{broken');
    expect(store.update(root, card.id, null, { title: 'Renamed' }).title).toBe('Renamed');
    expect(() => store.update(root, card.id, null, { status: 'done' })).toThrow('Cannot read');
    expect(store.get(root, card.id).status).toBe(card.status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI clears mistaken links while retaining previous work history', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-clear-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root, {
      title: 'Defect',
      observed: 'bad',
      expected: 'good',
      reproduction: 'steps',
    });
    const duplicate = issues.createIssue(root, { title: 'Other' });
    const ready = issues.updateIssue(root, issue.id, null, { criteria: ['fixed'] });
    const promoted = issues.promoteIssue(root, issue.id, ready.revision);
    issues.updateIssue(root, issue.id, null, { duplicateOf: duplicate.id, status: 'closed', closureReason: 'Duplicate' });
    const output: string[] = [];
    const code = main(
      ['--quiet', '--root', root, 'issue-edit', issue.id, '--clear-work-item', '--clear-duplicate-of'],
      {
        out: (text) => output.push(text),
        err: (text) => output.push(text),
        env: {},
      },
    );
    expect(code).toBe(0);
    const updated = issues.getIssue(root, issue.id);
    expect(updated.workItem).toBeNull();
    expect(updated.duplicateOf).toBeNull();
    expect(updated.workHistory).toEqual([promoted.workItem]);
    expect(updated.followWork).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bridge reports a saved work item and recovery on issue sync failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-http-'));
  store.init(root);
  const issue = issues.createIssue(root, {
    title: 'Defect',
    observed: 'bad',
    expected: 'good',
    reproduction: 'steps',
  });
  const ready = issues.updateIssue(root, issue.id, null, { criteria: ['fixed'] });
  const promoted = issues.promoteIssue(root, issue.id, ready.revision);
  const ui = join(root, 'ui.html');
  writeFileSync(ui, 'ui');
  const bridge = startBridge(root, 0, ui, () => {});
  try {
    const item = store.get(root, promoted.workItem!);
    issues.issueSeams.beforeSyncWrite = () => {
      throw new Error('injected failure');
    };
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/items/${item.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: item.revision,
        hash: store.hashItem(root, item.id),
        changes: { status: 'done' },
      }),
    });
    const body = (await response.json()) as { code: string; itemId: string; error: string };
    expect(response.status).toBe(500);
    expect(body.code).toBe('issue_sync_failed');
    expect(body.itemId).toBe(item.id);
    expect(body.error).toContain('reapply its saved status');
    expect(store.get(root, item.id).status).toBe('done');
  } finally {
    issues.issueSeams.beforeSyncWrite = () => {};
    bridge.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent promotion creates only one work item', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-promote-race-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root, {
      title: 'Race',
      observed: 'bad',
      expected: 'good',
      reproduction: 'steps',
    });
    const ready = issues.updateIssue(root, issue.id, null, { criteria: ['fixed'] });
    const cli = join(import.meta.dir, '../../scripts/agentboard.ts');
    const processes = [0, 1].map(() =>
      Bun.spawn(
        [
          process.execPath,
          cli,
          '--quiet',
          '--root',
          root,
          'issue-promote',
          issue.id,
          '--revision',
          String(ready.revision),
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      ),
    );
    const codes = await Promise.all(processes.map((process) => process.exited));
    expect(codes.sort()).toEqual([0, 2]);
    expect(store.snapshot(root).items).toHaveLength(1);
    expect(issues.getIssue(root, issue.id).workItem).toBe(store.snapshot(root).items[0].id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restoring done work synchronizes linked issues', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-triage-'));
  try {
    store.init(root);
    const make = () => {
      const issue = issues.createIssue(root, { title: 'Defect', observed: 'bad', expected: 'good', reproduction: 'steps' });
      const ready = issues.updateIssue(root, issue.id, null, { criteria: ['fixed'] });
      return issues.promoteIssue(root, issue.id, ready.revision);
    };
    const restored = make();
    store.update(root, restored.workItem!, null, { archived: true });
    store.update(root, restored.workItem!, null, { status: 'done' });
    store.update(root, restored.workItem!, null, { archived: false });
    expect(issues.getIssue(root, restored.id).status).toBe('closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manually reopening an issue clears its closure reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-reopen-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root, { title: 'Defect' });
    const original = issues.createIssue(root, { title: 'Original' });
    issues.updateIssue(root, issue.id, null, { status: 'closed', closureReason: 'Duplicate', duplicateOf: original.id });
    expect(() => issues.updateIssue(root, issue.id, null, { status: 'new', closureReason: 'reason' })).toThrow();
    expect(() => issues.updateIssue(root, issue.id, null, { status: 'new', duplicateOf: original.id })).toThrow();
    const evidenced = issues.addEvidence(root, issue.id, null, 'Another reproduction');
    expect(evidenced.duplicateOf).toBeNull();
    issues.updateIssue(root, issue.id, null, { status: 'closed', closureReason: 'Duplicate', duplicateOf: original.id });
    const reopened = issues.updateIssue(root, issue.id, null, { status: 'gathering-data' });
    expect(reopened.closureReason).toBe('');
    expect(reopened.duplicateOf).toBeNull();
    expect(reopened.closureKind).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual resolution and reopening do not follow already completed work', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-manual-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root, { title: 'Defect', observed: 'bad', expected: 'good', reproduction: 'steps' });
    const original = issues.createIssue(root, { title: 'Original' });
    const ready = issues.updateIssue(root, issue.id, null, { criteria: ['fixed'] });
    const promoted = issues.promoteIssue(root, issue.id, ready.revision);
    store.update(root, promoted.workItem!, null, { status: 'done' });
    issues.updateIssue(root, issue.id, null, { closureReason: 'Duplicate', duplicateOf: original.id });
    store.update(root, promoted.workItem!, null, { status: 'todo' });
    expect(issues.getIssue(root, issue.id).status).toBe('closed');
    store.update(root, promoted.workItem!, null, { status: 'done' });
    issues.updateIssue(root, issue.id, null, { status: 'new' });
    store.update(root, promoted.workItem!, null, { status: 'done' });
    expect(issues.getIssue(root, issue.id).status).toBe('new');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('closure fields require closure and relinking does not implicitly follow new work', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-relink-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root, { title: 'Defect', observed: 'bad', expected: 'good', reproduction: 'steps' });
    const duplicate = issues.createIssue(root, { title: 'Other' });
    expect(() => issues.updateIssue(root, issue.id, null, { closureReason: 'Invalid' })).toThrow();
    expect(() => issues.updateIssue(root, issue.id, null, { duplicateOf: duplicate.id })).toThrow();
    const ready = issues.updateIssue(root, issue.id, null, { criteria: ['fixed'] });
    const promoted = issues.promoteIssue(root, issue.id, ready.revision);
    issues.updateIssue(root, issue.id, null, { status: 'gathering-data' });
    const other = store.create(root, { title: 'Other work' });
    issues.updateIssue(root, issue.id, null, { workItem: other.id });
    store.update(root, other.id, null, { status: 'done' });
    expect(issues.getIssue(root, issue.id).status).toBe('gathering-data');
    expect(issues.getIssue(root, issue.id).workHistory).toContain(promoted.workItem);
    const next = store.create(root, { title: 'Ready work' });
    issues.updateIssue(root, issue.id, null, { workItem: next.id, status: 'ready-for-work' });
    const replacement = store.create(root, { title: 'Replacement work' });
    issues.updateIssue(root, issue.id, null, { workItem: replacement.id });
    store.update(root, replacement.id, null, { status: 'done' });
    expect(issues.getIssue(root, issue.id).status).toBe('closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
