// File format versions and the upgrade pipeline (the rules are described in README.md, "Versioning").
//
// Every board file carries a semver string in its `version` field. A missing version or the integer 1
// (the original format) reads as 1.0.0. Readers are strict: a version newer than CURRENT is rejected,
// even a newer minor. Older versions are upgraded step by step through PIPELINES; each step turns a
// file of version `from` into a file of version `to`. Minor/patch steps only fill defaults; a future
// major step transforms existing data.
import { BoardError } from './types';

export type FileKind = 'item' | 'board' | 'feature';

/** The version this code writes for each kind of file. */
export const CURRENT: Record<FileKind, string> = {
  item: '1.1.0',
  board: '1.1.0',
  feature: '1.0.0',
};

const LABELS: Record<FileKind, string> = {
  item: 'Card',
  board: 'board.json',
  feature: 'Feature',
};

const SEMVER_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

type Json = Record<string, unknown>;

export type UpgradeStep = {
  from: string;
  to: string;
  upgrade(value: Json): Json;
};

export const NEEDS_GRILLING = { id: 'needs-grilling', name: 'Needs grilling' } as const;

export const DEFAULT_FEATURE_COLUMNS = [
  { id: 'planned', name: 'Planned' },
  { id: 'active', name: 'Active' },
  { id: 'done', name: 'Done' },
];

/** Card 1.0.0 -> 1.1.0: adds `feature` (null) and `thread` ([]) at the end; the 14 original keys keep their order. */
function itemTo110(value: Json): Json {
  if ('thread' in value || 'feature' in value) {
    throw new BoardError('Invalid item structure or version');
  }
  const { version: _old, ...rest } = value;
  return { version: '1.1.0', ...rest, feature: null, thread: [] };
}

/**
 * board.json 1.0.0 -> 1.1.0: inserts the Needs grilling column after `backlog` (first if there is no
 * backlog) unless a column with that id exists, and adds the default feature columns. This runs once
 * per board: the version records it, so a column the user removes later is not added again.
 */
function boardTo110(value: Json): Json {
  const { version: _old, ...rest } = value;
  let columns = value.columns;
  if (Array.isArray(columns) && !columns.some(column => isColumnWithId(column, NEEDS_GRILLING.id))) {
    const backlog = columns.findIndex(column => isColumnWithId(column, 'backlog'));
    columns = [...columns];
    (columns as unknown[]).splice(backlog + 1, 0, { ...NEEDS_GRILLING });
  }
  const upgraded: Json = { version: '1.1.0', ...rest, columns };
  if (!('featureColumns' in upgraded)) {
    upgraded.featureColumns = DEFAULT_FEATURE_COLUMNS.map(column => ({ ...column }));
  }
  return upgraded;
}

function isColumnWithId(column: unknown, id: string): boolean {
  return !!column && typeof column === 'object' && (column as Json).id === id;
}

/** Ordered upgrade steps per kind. The `from` of each step must equal the `to` of the step before it. */
export const PIPELINES: Record<FileKind, UpgradeStep[]> = {
  item: [{ from: '1.0.0', to: '1.1.0', upgrade: itemTo110 }],
  board: [{ from: '1.0.0', to: '1.1.0', upgrade: boardTo110 }],
  feature: [],
};

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_RE.test(value);
}

/** Reads a `version` field: missing or the integer 1 means 1.0.0; anything else must be a semver string. */
export function readVersion(value: unknown, kind: FileKind): string {
  if (value === undefined || value === 1) return '1.0.0';
  if (isVersion(value)) return value;
  throw new BoardError(`${LABELS[kind]} has an invalid version: ${JSON.stringify(value)}`);
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export type Upgraded = {
  value: Json;
  /** Version found on disk (normalized). */
  from: string;
  /** True when `value` differs from the disk format and should be written back. */
  upgraded: boolean;
};

/**
 * Brings a parsed file to CURRENT[kind] in memory. Rejects newer versions and versions no step starts
 * from. The result still has to be validated by the caller.
 */
export function upgrade(kind: FileKind, raw: unknown, pipelines: Partial<Record<FileKind, UpgradeStep[]>> = PIPELINES,
  current: string = CURRENT[kind]): Upgraded {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BoardError(kind === 'item' ? 'Invalid item structure or version' :
      kind === 'feature' ? 'Invalid feature file' : 'Invalid or unsupported board configuration');
  }
  const from = readVersion((raw as Json).version, kind);
  if (compareVersions(from, current) > 0) {
    throw new BoardError(`${LABELS[kind]} format ${from} was written by a newer AgentBoard (this copy supports up to ${current}); update this copy (run setup from a newer AgentBoard)`);
  }
  let value = raw as Json;
  let version = from;
  for (const step of (pipelines[kind] ?? [])) {
    if (step.from === version) {
      value = step.upgrade(value);
      version = step.to;
    }
  }
  if (version !== current) {
    throw new BoardError(`${LABELS[kind]} format ${from} is not supported by this AgentBoard`);
  }
  return { value, from, upgraded: from !== current };
}
