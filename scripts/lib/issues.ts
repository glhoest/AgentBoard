import { isVersion, compareVersions } from './versions';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withLock } from './lock';
import { BoardError, Conflict, type Item } from './types';
import * as store from './store';

export const ISSUE_STATUSES = ['new', 'smoking-rack', 'gathering-data', 'ready-for-work', 'closed'] as const;
export type Issue = {
  version: string;
  id: string;
  revision: number;
  title: string;
  status: typeof ISSUE_STATUSES[number];
  observed: string;
  expected: string;
  reproduction: string;
  criteria: string[];
  evidence: string[];
  workItem: string | null;
  workHistory: string[];
  closureReason: string;
  duplicateOf: string | null;
  createdAt: string;
  updatedAt: string;
};
export type IssueChanges = Partial<Pick<Issue, 'title' | 'status' | 'observed' | 'expected' | 'reproduction' | 'criteria' | 'workItem' | 'closureReason' | 'duplicateOf'>>;
const idPattern = /^IS-[0-9A-F]{12}$/;
const keys = ['version','id','revision','title','status','observed','expected','reproduction','criteria','evidence','workItem','workHistory','closureReason','duplicateOf','createdAt','updatedAt'];
export function issuePath(root: string, id: string): string {
  if (!idPattern.test(id)) throw new BoardError('Invalid issue ID');
  return join(root, '.agentboard', 'issues', `${id}.json`);
}
function validate(x: any): Issue {
  if (x && isVersion(x.version) && compareVersions(x.version, '1.0.0') > 0) throw new BoardError('Issue was written by a newer AgentBoard; update this copy');
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join() !== [...keys].sort().join() || x.version !== '1.0.0' || !idPattern.test(x.id) || !Number.isInteger(x.revision) || x.revision < 1 || !ISSUE_STATUSES.includes(x.status)) throw new BoardError('Invalid issue structure or version');
  for (const key of ['title','observed','expected','reproduction','closureReason','createdAt','updatedAt']) if (typeof x[key] !== 'string' || x[key].length > 100000) throw new BoardError(`Invalid issue ${key}`);
  if (!x.title.trim() || x.title.length > 300 || !Array.isArray(x.criteria) || !Array.isArray(x.evidence) || [...x.criteria,...x.evidence].some(v => typeof v !== 'string' || !v.trim() || v.length > 20000)) throw new BoardError('Invalid issue content');
  if (x.workItem !== null && !/^AB-[0-9A-F]{12}$/.test(x.workItem)) throw new BoardError('Invalid work item ID');
  if (!Array.isArray(x.workHistory) || x.workHistory.some((id: unknown) => typeof id !== 'string' || !/^AB-[0-9A-F]{12}$/.test(id)) || new Set(x.workHistory).size !== x.workHistory.length || (x.workItem && x.workHistory.includes(x.workItem))) throw new BoardError('Invalid work history');
  if (x.duplicateOf !== null && (!idPattern.test(x.duplicateOf) || x.duplicateOf === x.id)) throw new BoardError('Invalid duplicate issue ID');
  return x;
}
export function getIssue(root: string, id: string): Issue {
  const x = validate(store.readJson(issuePath(root,id)));
  if (x.id !== id) throw new BoardError('Issue ID does not match filename');
  return x;
}
export function listIssues(root: string): Issue[] {
  const dir = join(root,'.agentboard','issues');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.json') && !n.startsWith('.tmp-')).sort().map(n => getIssue(root,n.slice(0,-5)));
}
export function hashIssue(root: string, id: string): string { return createHash('sha256').update(readFileSync(issuePath(root,id))).digest('hex'); }
export const issueSeams = { beforeSyncWrite: (_issue: Issue): void => {} };
type Options = { expectedHash?: string | null };
function check(root: string, id: string, revision: number | null, opts: Options): Issue {
  const x = getIssue(root,id);
  if (revision !== null && revision !== x.revision) throw new Conflict(`Revision mismatch; current revision is ${x.revision}`);
  if (opts.expectedHash != null && opts.expectedHash !== hashIssue(root,id)) throw new Conflict('Issue file changed since it was read');
  return x;
}
function save(root: string, x: Issue): Issue {
  x.revision++;
  x.updatedAt = store.now();
  validate(x);
  store.atomicWrite(issuePath(root, x.id), x);
  return x;
}
export function createIssue(root: string, values: {title: string; observed?: string; expected?: string; reproduction?: string}): Issue {
  if (!values || Object.keys(values).some(k => !['title','observed','expected','reproduction'].includes(k))) throw new BoardError('Invalid issue fields');
  return withLock(root, () => {
    const id = 'IS-' + store.seams.randomHex(6), stamp = store.now();
    if (existsSync(issuePath(root,id))) throw new Conflict('ID collision; retry');
    const x: Issue = {version:'1.0.0',id,revision:1,title:values.title,status:'new',observed:values.observed ?? '',expected:values.expected ?? '',reproduction:values.reproduction ?? '',criteria:[],evidence:[],workItem:null,workHistory:[],closureReason:'',duplicateOf:null,createdAt:stamp,updatedAt:stamp};
    validate(x);
    store.atomicWrite(issuePath(root, id), x);
    return x;
  });
}
export function updateIssue(root: string, id: string, revision: number | null, changes: IssueChanges, opts: Options = {}): Issue {
  if (!changes || !Object.keys(changes).length || Object.keys(changes).some(k => !['title','status','observed','expected','reproduction','criteria','workItem','closureReason','duplicateOf'].includes(k))) throw new BoardError('Invalid issue changes');
  return withLock(root, () => {
    const x = check(root,id,revision,opts);
    if ('workItem' in changes && changes.workItem !== x.workItem) {
      if (x.workItem && !x.workHistory.includes(x.workItem)) x.workHistory.push(x.workItem);
      x.workHistory = x.workHistory.filter(id => id !== changes.workItem);
    }
    Object.assign(x, changes);
    validate(x);
    if (x.status === 'ready-for-work' && (!x.workItem || !x.observed.trim() || !x.expected.trim() || !x.reproduction.trim() || !x.criteria.length)) throw new BoardError('Ready for work requires a linked work item and completed triage');
    if (x.status === 'closed' && !x.closureReason.trim()) throw new BoardError('Closing requires a reason');
    if (x.duplicateOf && !existsSync(issuePath(root,x.duplicateOf))) throw new BoardError('Duplicate issue does not exist');
    if (x.status === 'ready-for-work' && x.workItem && ('workItem' in changes || 'status' in changes)) { const item = store.get(root,x.workItem); if (item.archived) throw new BoardError('Work item is archived'); if (item.status === store.config(root).columns.at(-1)?.id) throw new BoardError('Work item is already done; link follow-up work'); }
    return save(root,x);
  });
}
export function addEvidence(root: string, id: string, revision: number | null, body: string, opts: Options = {}): Issue {
  return withLock(root, () => {
    const x = check(root, id, revision, opts);
    x.evidence.push(body);
    if (x.status === 'closed') {
      x.status = 'new';
      x.closureReason = '';
    }
    return save(root, x);
  });
}
export function promoteIssue(root: string, id: string, revision: number | null, workItem?: string | null): Issue {
  const x = getIssue(root,id);
  if (revision !== null && revision !== x.revision) throw new Conflict(`Revision mismatch; current revision is ${x.revision}`);
  if (!x.observed.trim() || !x.expected.trim() || !x.reproduction.trim() || !x.criteria.length) throw new BoardError('Promotion requires observed and expected behavior, reproduction steps or reason unavailable, and acceptance criteria');
  const item = workItem ? store.get(root,workItem) : store.create(root,{title:x.title,description:`Observed: ${x.observed}\n\nExpected: ${x.expected}\n\nReproduction: ${x.reproduction}`, acceptanceCriteria:x.criteria.map(text => ({text,done:false}))});
  if (item.archived) throw new BoardError('Work item is archived');
  if (item.status === store.config(root).columns.at(-1)?.id) throw new BoardError('Work item is already done; link follow-up work');
  try { return updateIssue(root,id,x.revision,{workItem:item.id,status:'ready-for-work',closureReason:'',duplicateOf:null}); }
  catch (error) { if (!workItem) throw new BoardError(`Created work item ${item.id}, but failed to link issue: ${error instanceof Error ? error.message : String(error)}. Link it manually; do not repeat promotion.`); throw error; }
}
/** Called under the board lock after a work item changes. */
export function syncWorkItem(root: string, before: Item, after: Item, lastStatus: string): void {
  if (after.archived) return;
  for (const x of listIssues(root)) {
    if (x.workItem !== after.id) continue;
    if (after.status === lastStatus && x.status === 'ready-for-work') {
      x.status = 'closed';
      x.closureReason = 'Linked work completed';
    } else if (after.status !== lastStatus && x.status === 'closed' && x.closureReason === 'Linked work completed') {
      x.status = 'ready-for-work';
      x.closureReason = '';
    } else {
      continue;
    }
    issueSeams.beforeSyncWrite(x);
    save(root, x);
  }
}

/** Present unavailable current and historical links without discarding them. */
export function issueSummary(root: string, issue: Issue) {
  const unavailableWorkItems = [issue.workItem, ...issue.workHistory].filter((id): id is string => {
    if (!id) return false;
    if (!existsSync(store.itemPath(root, id))) return true;
    return store.get(root, id).archived;
  });
  return { ...issue, unavailableWorkItems };
}
