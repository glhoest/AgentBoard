import { syncWorkItem } from './issues';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { withLock } from './lock';
import {
  BoardError, Conflict, FeatureSyncError, BOARD_KEYS, ENTRY_ID_RE, ENTRY_KEYS, ENTRY_KINDS, FEATURE_ID_RE, FEATURE_KEYS, FEATURE_WRITABLE, ID_RE, ITEM_KEYS, LIMITS,
  PRIORITIES, SLUG_RE, TIMESTAMP_RE, WRITABLE,
  type Board, type Feature, type FeatureChanges, type Changes, type Column, type Entry, type EntryChanges, type Item, type NewEntry, type Snapshot,
} from './types';
import { CURRENT, DEFAULT_FEATURE_COLUMNS, NEEDS_GRILLING, upgrade, type FileKind } from './versions';

/**
 * Sources of time and randomness, and an observer for upgrade-on-read writes. Production code never
 * changes these; tests replace them to get deterministic files (tests/ts/format.test.ts) or to count
 * upgrades (tests/ts/fixtures/upgrade-reader.ts).
 */
export const seams = {
  now: (): string => new Date().toISOString(),
  randomHex: (bytes: number): string => randomBytes(bytes).toString('hex').toUpperCase(),
  beforeFeatureWrite: (_feature: Feature): void => {},
  onUpgrade: (_path: string, _from: string, _to: string): void => {},
};

/** Read options. `persist: false` upgrades older files in memory only: no lock, no write. */
export type ReadOptions = { persist?: boolean };

export function now(): string {
  return seams.now();
}

export function encode(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function renameWithRetry(source: string, target: string, platform = process.platform,
  rename: typeof renameSync = renameSync, sleep: (ms: number) => void = Bun.sleepSync): void {
  let original: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rename(source, target);
      return;
    } catch (error) {
      original ??= error;
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt === 9) {
        throw original;
      }
      sleep(20);
    }
  }
}

export function atomicWrite(path: string, value: unknown): void {
  const data = encode(value);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx');
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameWithRetry(tmp, path);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    throw e;
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new BoardError(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function locate(start: string): string {
  let p = resolve(start);
  while (true) {
    if (existsSync(join(p, '.agentboard', 'board.json'))) return p;
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  throw new BoardError('No board found. Run init in the project root, or use --root.');
}

export function boardPath(root: string): string {
  return join(root, '.agentboard', 'board.json');
}

export function itemPath(root: string, id: string): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new BoardError('Invalid item ID');
  return join(root, '.agentboard', 'items', `${id}.json`);
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isObject = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const sameKeys = (x: object, keys: readonly string[]) => Object.keys(x).sort().join('\0') === [...keys].sort().join('\0');

// ---- Validation (current format only; older files are upgraded first, see versions.ts) ----

function validateColumns(columns: unknown, what: string): Column[] {
  if (!Array.isArray(columns) || !columns.length) throw new BoardError(`Invalid ${what}`);
  const ids: string[] = [];
  for (const column of columns) {
    if (!isObject(column) || typeof column.id !== 'string' || !SLUG_RE.test(column.id)
      || typeof column.name !== 'string' || !column.name.trim()) {
      throw new BoardError(what === 'columns' ? 'Invalid column' : `Invalid ${what}`);
    }
    ids.push(column.id);
  }
  if (new Set(ids).size !== ids.length) throw new BoardError(`Duplicate ${what === 'columns' ? 'column' : what} ids`);
  return columns;
}

export function validateBoard(value: unknown): Board {
  if (!isObject(value) || value.version !== CURRENT.board) throw new BoardError('Invalid or unsupported board configuration');
  const unknown = Object.keys(value).filter(key => !(BOARD_KEYS as readonly string[]).includes(key));
  if (unknown.length) throw new BoardError(`Unknown keys in board.json: ${unknown.sort().join(', ')}`);
  if (typeof value.name !== 'string') throw new BoardError('Invalid board name');
  validateColumns(value.columns, 'columns');
  validateColumns(value.featureColumns, 'featureColumns');
  return value as Board;
}

function validateThread(thread: unknown): Entry[] {
  if (!Array.isArray(thread)) throw new BoardError('Invalid thread');
  if (thread.length > LIMITS.entries) throw new BoardError(`A thread holds at most ${LIMITS.entries} entries`);
  const kinds = new Map<string, string>();
  for (const entry of thread) {
    if (!isObject(entry) || !sameKeys(entry, ENTRY_KEYS)) throw new BoardError('Invalid thread entry structure');
    if (typeof entry.id !== 'string' || !ENTRY_ID_RE.test(entry.id)) throw new BoardError('Invalid thread entry ID');
    if (kinds.has(entry.id)) throw new BoardError(`Duplicate thread entry ID ${entry.id}`);
    if (!(ENTRY_KINDS as readonly unknown[]).includes(entry.kind)) throw new BoardError('Unknown thread entry kind');
    if (entry.author !== null && (typeof entry.author !== 'string' || !entry.author.trim() || entry.author.length > LIMITS.author)) {
      throw new BoardError(`Author must be 1–${LIMITS.author} characters`);
    }
    if (typeof entry.body !== 'string' || !entry.body.trim() || entry.body.length > LIMITS.body) {
      throw new BoardError(`Entry body must be 1–${LIMITS.body.toLocaleString('en-US')} characters`);
    }
    // replyTo points at an earlier entry of the same card (entries are only ever appended).
    if (entry.kind === 'question' && entry.replyTo !== null) throw new BoardError('A question cannot reply to an entry');
    if (entry.kind === 'answer' && kinds.get(entry.replyTo) !== 'question') {
      throw new BoardError('An answer must reply to a question on this card');
    }
    if (entry.kind === 'comment' && entry.replyTo !== null && !kinds.has(entry.replyTo)) {
      throw new BoardError('A comment can only reply to an existing entry on this card');
    }
    for (const key of ['createdAt', 'updatedAt']) {
      if (typeof entry[key] !== 'string' || !TIMESTAMP_RE.test(entry[key])) throw new BoardError(`Invalid entry ${key}`);
    }
    kinds.set(entry.id, entry.kind);
  }
  return thread as Entry[];
}

export function validate(value: unknown, cfg: Board): Item {
  const x = value as any;
  if (!isObject(x) || !sameKeys(x, ITEM_KEYS) || x.version !== CURRENT.item) throw new BoardError('Invalid item structure or version');
  if (typeof x.id !== 'string' || !ID_RE.test(x.id)) throw new BoardError('Invalid item ID');
  if (!isInt(x.revision) || x.revision < 1) throw new BoardError('Invalid revision');
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 300) throw new BoardError('Title must be 1–300 characters');
  if (!cfg.columns.some(c => c.id === x.status)) throw new BoardError('Unknown status');
  if (!(PRIORITIES as readonly unknown[]).includes(x.priority)) throw new BoardError('Unknown priority');
  if (x.assignee !== null && (typeof x.assignee !== 'string' || !x.assignee.trim() || x.assignee.length > 120)) throw new BoardError('Invalid assignee');
  for (const k of ['description', 'notes']) {
    if (typeof x[k] !== 'string' || x[k].length > 100000) throw new BoardError(`Invalid ${k}`);
  }
  if (!Array.isArray(x.labels) || x.labels.length > 50
    || x.labels.some((v: unknown) => typeof v !== 'string' || !v.trim() || v.length > 80)
    || new Set(x.labels).size !== x.labels.length) {
    throw new BoardError('Invalid labels');
  }
  if (!Array.isArray(x.acceptanceCriteria) || x.acceptanceCriteria.length > 200
    || x.acceptanceCriteria.some((v: any) => !isObject(v) || !sameKeys(v, ['done', 'text'])
      || typeof v.text !== 'string' || !v.text.trim() || v.text.length > 1000 || typeof v.done !== 'boolean')) {
    throw new BoardError('Invalid acceptance criteria');
  }
  if (typeof x.archived !== 'boolean') throw new BoardError('Invalid archived flag');
  for (const k of ['createdAt', 'updatedAt']) {
    if (typeof x[k] !== 'string' || !TIMESTAMP_RE.test(x[k])) throw new BoardError(`Invalid ${k}`);
  }
  if (x.feature !== null && (typeof x.feature !== 'string' || !FEATURE_ID_RE.test(x.feature))) throw new BoardError('Invalid feature');
  validateThread(x.thread);
  return x;
}

// ---- Upgrade-on-read ----

/**
 * Reads one board file in the current format. An older file is upgraded in memory and validated; with
 * `persist` (the default) it is then rewritten on disk right away, under the lock, re-reading it there
 * because another process may have upgraded it meanwhile. Files already current are read without the lock.
 * A pure format upgrade keeps `revision` and `updatedAt`.
 */
function load<T>(root: string, path: string, kind: FileKind, check: (value: unknown) => T, options: ReadOptions): T {
  const read = () => {
    const result = upgrade(kind, readJson(path));
    return { ...result, value: check(result.value) };
  };
  const first = read();
  if (!first.upgraded || options.persist === false) return first.value;
  return withLock(root, () => {
    const again = read();
    if (again.upgraded) {
      atomicWrite(path, again.value);
      seams.onUpgrade(path, again.from, CURRENT[kind]);
    }
    return again.value;
  });
}

export function config(root: string, options: ReadOptions = {}): Board {
  return load(root, boardPath(root), 'board', validateBoard, options);
}

export function get(root: string, id: string, cfg?: Board, options: ReadOptions = {}): Item {
  const path = itemPath(root, id);
  const c = cfg ?? config(root, options);
  return load(root, path, 'item', value => {
    const x = validate(value, c);
    if (x.id !== id) throw new BoardError('Item ID does not match filename');
    return x;
  }, options);
}

export function snapshot(root: string, options: ReadOptions = {}): Snapshot {
  const c = config(root, options);
  const dir = join(root, '.agentboard', 'items');
  const names = readdirSync(dir).filter(n => n.endsWith('.json')).sort();
  const items: Item[] = [];
  for (const name of names) {
    const stem = name.slice(0, -5);
    if (!ID_RE.test(stem)) throw new BoardError(`Invalid item filename: ${name}`);
    items.push(get(root, stem, c, options));
  }
  const featureDir = join(root, '.agentboard', 'features');
  const features: Feature[] = [];
  if (existsSync(featureDir)) {
    for (const name of readdirSync(featureDir).filter(n => !n.startsWith('.tmp-') && n.endsWith('.json')).sort()) {
      const id = name.slice(0, -5);
      if (!FEATURE_ID_RE.test(id)) throw new BoardError(`Invalid feature filename: ${name}`);
      features.push(getFeature(root, id, c, options));
    }
  }
  return { config: c, items, features };
}

export function hashItem(root: string, id: string): string {
  return createHash('sha256').update(readFileSync(itemPath(root, id))).digest('hex');
}

// ---- Writes ----

const allowed = new Set<string>(WRITABLE);

export function create(root: string, values: Changes): Item {
  const extra = Object.keys(values as any).filter(k => !allowed.has(k)).sort();
  if (extra.length) throw new BoardError('Unknown item fields: ' + extra.join(', '));
  return withLock(root, () => {
    const c = config(root);
    const stamp = now();
    const id = 'AB-' + seams.randomHex(6);
    const x: any = {
      version: CURRENT.item, id, revision: 1, title: '', status: c.columns[0].id, priority: 'medium', assignee: null,
      labels: [], description: '', acceptanceCriteria: [], notes: '', createdAt: stamp, updatedAt: stamp, archived: false,
      feature: null, thread: [],
    };
    Object.assign(x, values);
    validate(x, c);
    if (x.feature !== null) checkFeatureLink(root, x.feature, c);
    const p = itemPath(root, id);
    if (existsSync(p)) throw new Conflict('ID collision; retry');
    const updates = x.archived ? [] : planFeatures(root, c, null, x);
    atomicWrite(p, x);
    writeFeatureUpdates(root, x.id, updates);
    return x;
  });
}

type WriteOptions = { expectedHash?: string | null };

/**
 * The one write path for existing items: under the lock, reads (upgrading if needed), checks the
 * expected hash and revision, applies `change`, bumps revision and updatedAt, validates, writes atomically.
 */
function mutate(root: string, id: string, revision: number | null, opts: WriteOptions & { recalculate?: boolean }, change: (x: Item, stamp: string) => void): Item {
  return withLock(root, () => {
    const c = config(root);
    const x = get(root, id, c);
    if (opts.expectedHash != null && hashItem(root, id) !== opts.expectedHash) throw new Conflict('Item file changed since it was read');
    if (revision !== null && (!isInt(revision) || revision !== x.revision)) throw new Conflict(`Revision mismatch; current revision is ${x.revision}`);
    const before = { ...x };
    const stamp = now();
    change(x, stamp);
    x.revision++;
    x.updatedAt = stamp;
    validate(x, c);
    const updates = (!before.archived || !x.archived) && (before.feature !== x.feature || before.status !== x.status || before.archived !== x.archived || opts.recalculate)
      ? planFeatures(root, c, before, x) : [];
    atomicWrite(itemPath(root, id), x);
    writeFeatureUpdates(root, x.id, updates);
    syncWorkItem(root, before, x, c.columns[c.columns.length - 1].id);
    return x;
  });
}

export function update(root: string, id: string, revision: number | null, changes: Changes, opts: WriteOptions & { claim?: boolean } = {}): Item {
  if (!isObject(changes) || Object.keys(changes).some(k => !allowed.has(k)) || !Object.keys(changes).length) {
    throw new BoardError('Invalid or empty changes');
  }
  return mutate(root, id, revision, {...opts, recalculate: 'status' in changes}, x => {
    if (opts.claim && x.assignee !== null && x.assignee !== changes.assignee) throw new Conflict(`Already claimed by ${x.assignee}`);
    if ('feature' in changes && changes.feature !== null) checkFeatureLink(root, changes.feature, config(root));
    Object.assign(x, changes);
  });
}

function newEntryId(thread: Entry[]): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = 'TH-' + seams.randomHex(6);
    if (!thread.some(entry => entry.id === id)) return id;
  }
  throw new Conflict('ID collision; retry');
}

/** Appends a comment, question or answer to the card's thread (a normal card write: revision + 1). */
export function addEntry(root: string, id: string, revision: number | null, entry: NewEntry, opts: WriteOptions = {}): Item {
  if (!isObject(entry) || Object.keys(entry).some(k => !['kind', 'body', 'author', 'replyTo'].includes(k))
    || !('kind' in entry) || !('body' in entry)) {
    throw new BoardError('Expected an entry with kind and body (author and replyTo optional)');
  }
  return mutate(root, id, revision, opts, (x, stamp) => {
    if (x.archived && entry.kind === 'question') throw new BoardError('Unarchive the card first before asking a question');
    if (x.thread.length >= LIMITS.entries) throw new BoardError(`A thread holds at most ${LIMITS.entries} entries`);
    x.thread.push({
      id: newEntryId(x.thread),
      kind: entry.kind,
      author: entry.author ?? null,
      body: entry.body,
      replyTo: entry.replyTo ?? null,
      createdAt: stamp,
      updatedAt: stamp,
    });
  });
}

/** Changes the body and/or author of an existing entry. Entries are never deleted. */
export function editEntry(root: string, id: string, entryId: string, revision: number | null, changes: EntryChanges, opts: WriteOptions = {}): Item {
  if (typeof entryId !== 'string' || !ENTRY_ID_RE.test(entryId)) throw new BoardError('Invalid thread entry ID');
  if (!isObject(changes) || !Object.keys(changes).length || Object.keys(changes).some(k => k !== 'body' && k !== 'author')) {
    throw new BoardError('Invalid or empty entry changes (body, author)');
  }
  return mutate(root, id, revision, opts, (x, stamp) => {
    const target = x.thread.find(entry => entry.id === entryId);
    if (!target) throw new BoardError(`No thread entry ${entryId} on ${id}`);
    if ('body' in changes) target.body = changes.body as string;
    if ('author' in changes) target.author = changes.author ?? null;
    target.updatedAt = stamp;
  });
}

/** Questions on this card that no answer replies to yet. */
export function openQuestions(item: Item): Entry[] {
  const answered = new Set(item.thread.filter(entry => entry.kind === 'answer').map(entry => entry.replyTo));
  return item.thread.filter(entry => entry.kind === 'question' && !answered.has(entry.id));
}

export function init(path: string): { root: string; board: string } {
  const root = resolve(path);
  const board = join(root, '.agentboard');
  mkdirSync(root, { recursive: true });
  withLock(root, () => {
    if (existsSync(join(board, 'board.json'))) throw new BoardError('Board already exists');
    mkdirSync(join(board, 'items'), { recursive: true });
    atomicWrite(join(board, 'board.json'), {
      version: CURRENT.board,
      name: basename(root),
      columns: [
        { id: 'backlog', name: 'Backlog' },
        { ...NEEDS_GRILLING },
        { id: 'todo', name: 'To do' },
        { id: 'in-progress', name: 'In progress' },
        { id: 'blocked', name: 'Blocked' },
        { id: 'done', name: 'Done' },
      ],
      featureColumns: DEFAULT_FEATURE_COLUMNS.map(column => ({ ...column })),
    });
    const ex = join(root, '.git', 'info', 'exclude');
    if (existsSync(dirname(ex))) appendFileSync(ex, '\n/.agentboard.lock\n', 'utf8');
  });
  return { root, board };
}


export function featurePath(root: string, id: string): string {
  if (typeof id !== 'string' || !FEATURE_ID_RE.test(id)) throw new BoardError('Invalid feature ID');
  return join(root, '.agentboard', 'features', `${id}.json`);
}

export function validateFeature(value: unknown, cfg: Board): Feature {
  if (!isObject(value) || !sameKeys(value, FEATURE_KEYS) || value.version !== CURRENT.feature) throw new BoardError('Invalid feature structure or version');
  if (typeof value.id !== 'string' || !FEATURE_ID_RE.test(value.id)) throw new BoardError('Invalid feature ID');
  if (!isInt(value.revision) || value.revision < 1) throw new BoardError('Invalid revision');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 300) throw new BoardError('Title must be 1–300 characters');
  if (!cfg.featureColumns.some(column => column.id === value.status)) throw new BoardError(`Feature ${value.id} has unknown status: ${String(value.status)}`);
  if (typeof value.description !== 'string' || value.description.length > 100000) throw new BoardError('Invalid description');
  if (typeof value.archived !== 'boolean') throw new BoardError('Invalid archived flag');
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof value[key] !== 'string' || !TIMESTAMP_RE.test(value[key])) throw new BoardError(`Invalid ${key}`);
  }
  return value as Feature;
}

export function getFeature(root: string, id: string, cfg?: Board, options: ReadOptions = {}): Feature {
  const path = featurePath(root, id);
  const c = cfg ?? config(root, options);
  return load(root, path, 'feature', value => {
    const feature = validateFeature(value, c);
    if (feature.id !== id) throw new BoardError('Feature ID does not match filename');
    return feature;
  }, options);
}

export function hashFeature(root: string, id: string): string {
  return createHash('sha256').update(readFileSync(featurePath(root, id))).digest('hex');
}

function checkFeatureLink(root: string, id: unknown, cfg: Board): void {
  if (typeof id !== 'string' || !FEATURE_ID_RE.test(id)) throw new BoardError('Invalid feature ID');
  if (!existsSync(featurePath(root, id))) throw new BoardError(`Feature ${id} does not exist`);
  if (getFeature(root, id, cfg).archived) throw new BoardError(`Feature ${id} is archived`);
}

export function createFeature(root: string, values: FeatureChanges): Feature {
  if (!isObject(values) || Object.keys(values).some(key => !['title', 'status', 'description'].includes(key))) {
    throw new BoardError('Invalid feature fields');
  }
  return withLock(root, () => {
    const cfg = config(root);
    const stamp = now();
    let id = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      id = 'FT-' + seams.randomHex(6);
      if (!existsSync(featurePath(root, id))) break;
      id = '';
    }
    if (!id) throw new Conflict('ID collision; retry');
    const feature: Feature = { version: CURRENT.feature, id, revision: 1, title: '', status: cfg.featureColumns[0].id,
      description: '', createdAt: stamp, updatedAt: stamp, archived: false };
    Object.assign(feature, values);
    validateFeature(feature, cfg);
    atomicWrite(featurePath(root, id), feature);
    return feature;
  });
}

export function updateFeature(root: string, id: string, revision: number | null, changes: FeatureChanges, opts: WriteOptions = {}): Feature {
  if (!isObject(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !FEATURE_WRITABLE.includes(key))) {
    throw new BoardError('Invalid or empty feature changes');
  }
  return withLock(root, () => {
    const cfg = config(root);
    const feature = getFeature(root, id, cfg);
    if (opts.expectedHash != null && hashFeature(root, id) !== opts.expectedHash) throw new Conflict('Feature file changed since it was read');
    if (revision !== null && (!isInt(revision) || revision !== feature.revision)) throw new Conflict(`Revision mismatch; current revision is ${feature.revision}`);
    Object.assign(feature, changes);
    feature.revision++;
    feature.updatedAt = now();
    validateFeature(feature, cfg);
    atomicWrite(featurePath(root, id), feature);
    return feature;
  });
}

// Preflight all reads before committing the card. Older unrelated cards are upgraded in memory only.
function planFeatures(root: string, cfg: Board, before: Item | null, after: Item): Feature[] {
  const ids = [...new Set([before?.feature, after.feature].filter((id): id is string => !!id))];
  if (!ids.length) return [];
  const features: Feature[] = [];
  for (const id of ids) {
    if (!existsSync(featurePath(root, id))) continue;
    try {
      const feature = getFeature(root, id, cfg, {persist: false});
      if (!feature.archived) features.push(feature);
    } catch (error) {
      // A broken old link must not prevent removing or replacing it.
      if (id !== before?.feature || id === after.feature || !(error instanceof BoardError)) throw error;
    }
  }
  if (!features.length) return [];
  const dir = join(root, '.agentboard', 'items');
  const items: Item[] = [];
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json') && !name.startsWith('.tmp-'))) {
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) throw new BoardError(`Invalid item filename: ${name}`);
    if (id !== after.id) items.push(get(root, id, cfg, {persist: false}));
  }
  items.push(after);
  const updates: Feature[] = [];
  for (const feature of features) {
    const linked = items.filter(item => item.feature === feature.id && !item.archived);
    if (!linked.length) continue;
    const last = cfg.columns.length - 1;
    const unfinished = linked.map(item => cfg.columns.findIndex(column => column.id === item.status)).filter(index => index !== last);
    let index = unfinished.length
      ? Math.floor(Math.max(...unfinished) * (cfg.featureColumns.length - 1) / last)
      : cfg.featureColumns.length - 1;
    const inProgress = cfg.columns.findIndex(column => column.id === 'in-progress');
    const active = cfg.featureColumns.findIndex(column => column.id === 'active');
    if (unfinished.length && inProgress >= 0 && active > 0 && active < cfg.featureColumns.length - 1) {
      index = Math.max(...unfinished) >= inProgress ? Math.max(index, active) : Math.min(index, active - 1);
    }
    const status = cfg.featureColumns[index].id;
    if (feature.status === status) continue;
    feature.status = status;
    feature.revision++;
    feature.updatedAt = now();
    updates.push(feature);
  }
  return updates;
}

function writeFeatureUpdates(root: string, itemId: string, updates: Feature[]): void {
  try {
    for (const feature of updates) {
      seams.beforeFeatureWrite(feature);
      atomicWrite(featurePath(root, feature.id), feature);
    }
  } catch (error) {
    throw new FeatureSyncError(itemId, updates.map(feature => feature.id), error instanceof Error ? error.message : String(error));
  }
}

export function featureSummary(feature: Feature, items: Item[], columns: Column[]) {
  const linked = items.filter(item => item.feature === feature.id && !item.archived);
  const counts = Object.fromEntries(columns.map(column => [column.id, 0]));
  for (const item of linked) counts[item.status]++;
  return { id: feature.id, title: feature.title, status: feature.status, archived: feature.archived,
    progress: { done: counts[columns[columns.length - 1].id] ?? 0, total: linked.length }, counts };
}
