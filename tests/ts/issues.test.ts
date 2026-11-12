import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../scripts/lib/store';
import * as issues from '../../scripts/lib/issues';
import { Conflict } from '../../scripts/lib/types';
import { main } from '../../scripts/agentboard';

test('triage promotion, shared work lifecycle and evidence reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issues-'));
  try {
    store.init(root);
    const first = issues.createIssue(root, {title:'Defect'});
    expect(() => issues.promoteIssue(root,first.id,1)).toThrow('Promotion requires');
    const ready = issues.updateIssue(root,first.id,1,{observed:'crash',expected:'success',reproduction:'steps unavailable',criteria:['No crash']});
    const promoted = issues.promoteIssue(root,first.id,ready.revision);
    const other = issues.createIssue(root,{title:'Related',observed:'crash',expected:'success',reproduction:'steps',});
    const otherReady = issues.updateIssue(root,other.id,other.revision,{criteria:['No crash']});
    issues.promoteIssue(root,other.id,otherReady.revision,promoted.workItem);
    store.update(root,promoted.workItem!,null,{status:'done'});
    expect(issues.getIssue(root,first.id).status).toBe('closed');
    expect(issues.getIssue(root,other.id).status).toBe('closed');
    issues.addEvidence(root,first.id,null,'Still happens');
    store.update(root,promoted.workItem!,null,{status:'done'});
    expect(issues.getIssue(root,first.id).status).toBe('new');
    store.update(root,promoted.workItem!,null,{status:'todo'});
    expect(issues.getIssue(root,other.id).status).toBe('ready-for-work');
    store.update(root,promoted.workItem!,null,{status:'done'});
    expect(issues.getIssue(root,first.id).status).toBe('new');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('issue revisions, hashes, validation and CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issues-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root,{title:'Defect'});
    const hash = issues.hashIssue(root,issue.id);
    writeFileSync(issues.issuePath(root,issue.id),readFileSync(issues.issuePath(root,issue.id),'utf8')+' ');
    expect(() => issues.addEvidence(root,issue.id,1,'evidence',{expectedHash:hash})).toThrow(Conflict);
    issues.addEvidence(root,issue.id,1,'evidence');
    expect(() => issues.updateIssue(root,issue.id,1,{title:'stale'})).toThrow(Conflict);
    expect(() => issues.updateIssue(root,issue.id,null,{status:'closed'})).toThrow('reason');
    const closed = issues.updateIssue(root,issue.id,null,{status:'closed',closureReason:'Not a defect'});
    expect(issues.addEvidence(root,issue.id,closed.revision,'new evidence').status).toBe('new');
    const output: string[] = [];
    expect(main(['--quiet','--root',root,'issues'],{out:s=>output.push(s),err:s=>output.push(s),env:{}})).toBe(0);
    expect(JSON.parse(output[0])[0].id).toBe(issue.id);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('concurrent evidence writes reject stale revisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-race-'));
  try {
    store.init(root);
    const issue = issues.createIssue(root,{title:'Race'});
    const cli = join(import.meta.dir,'../../scripts/agentboard.ts');
    const processes = ['one','two'].map(body => Bun.spawn([process.execPath,cli,'--quiet','--root',root,'issue-evidence',issue.id,body,'--revision','1'], {stdout:'ignore',stderr:'ignore'}));
    const codes = await Promise.all(processes.map(p => p.exited));
    expect(codes.sort()).toEqual([0,2]);
    expect(issues.getIssue(root,issue.id).evidence).toHaveLength(1);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('retains previous work and flags unavailable links; sync failures can be retried', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-issue-sync-'));
  try {
    store.init(root);
    const created = issues.createIssue(root,{title:'Defect',observed:'bad',expected:'good',reproduction:'steps'});
    const ready = issues.updateIssue(root,created.id,1,{criteria:['fixed']});
    const first = issues.promoteIssue(root,created.id,ready.revision);
    issues.issueSeams.beforeSyncWrite = () => { throw new Error('injected write failure'); };
    expect(() => store.update(root,first.workItem!,null,{status:'done'})).toThrow('was saved');
    expect(issues.getIssue(root,first.id).status).toBe('ready-for-work');
    issues.issueSeams.beforeSyncWrite = () => {};
    store.update(root,first.workItem!,null,{status:'done'});
    expect(issues.getIssue(root,first.id).status).toBe('closed');
    issues.addEvidence(root,first.id,null,'still broken');
    const followup = issues.promoteIssue(root,first.id,null);
    expect(followup.workHistory).toEqual([first.workItem]);
    store.update(root,first.workItem!,null,{archived:true});
    expect(issues.issueSummary(root,followup).unavailableWorkItems).toEqual([first.workItem]);
    store.update(root,followup.workItem!,null,{status:'done'});
    store.update(root,followup.workItem!,null,{status:'todo'});
    expect(issues.getIssue(root,first.id).status).toBe('ready-for-work');
    store.update(root,followup.workItem!,null,{status:'done'});
    expect(issues.getIssue(root,first.id).status).toBe('closed');
  } finally { issues.issueSeams.beforeSyncWrite = () => {}; rmSync(root,{recursive:true,force:true}); }
});
