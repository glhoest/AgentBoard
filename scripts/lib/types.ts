// Shared AgentBoard types and constants (the contract is described in README.md).
// Owned by the integrator; leaf modules import from here and must not redefine these.
// File format versions and upgrades live in versions.ts.

export const ID_RE = /^AB-[0-9A-F]{12}$/;
export const ENTRY_ID_RE = /^TH-[0-9A-F]{12}$/;
export const FEATURE_ID_RE = /^FT-[0-9A-F]{12}$/;
export const SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const TIMESTAMP_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const ENTRY_KINDS = ['comment', 'question', 'answer'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** Limits for thread entries. */
export const LIMITS = {
  entries: 500,
  body: 20000,
  author: 120,
} as const;

/** Item keys in on-disk order (key order affects the file bytes and therefore the hash). */
export const ITEM_KEYS = ['version', 'id', 'revision', 'title', 'status', 'priority', 'assignee', 'labels', 'description',
  'acceptanceCriteria', 'notes', 'createdAt', 'updatedAt', 'archived', 'feature', 'thread'] as const;
export const FEATURE_KEYS = ['version', 'id', 'revision', 'title', 'status', 'description', 'createdAt', 'updatedAt', 'archived'];
export const FEATURE_WRITABLE: string[] = ['title', 'status', 'description', 'archived'];
/** Thread entry keys in on-disk order. */
export const ENTRY_KEYS = ['id', 'kind', 'author', 'body', 'replyTo', 'createdAt', 'updatedAt'] as const;
/** board.json keys in on-disk order. */
export const BOARD_KEYS = ['version', 'name', 'columns', 'featureColumns'] as const;
/** Fields that create/edit (CLI) and POST/PATCH (bridge) may set. The thread only changes through thread commands. */
export const WRITABLE = ['title', 'status', 'priority', 'assignee', 'labels', 'description', 'acceptanceCriteria', 'notes', 'archived', 'feature'] as const;
export type WritableKey = (typeof WRITABLE)[number];

export type Criterion = { text: string; done: boolean };
export type Entry = {
  id: string; kind: EntryKind; author: string | null; body: string; replyTo: string | null;
  createdAt: string; updatedAt: string;
};
export type Item = {
  version: string; id: string; revision: number; title: string; status: string; priority: Priority;
  assignee: string | null; labels: string[]; description: string; acceptanceCriteria: Criterion[];
  notes: string; createdAt: string; updatedAt: string; archived: boolean;
  feature: string | null; thread: Entry[];
};
export type Column = { id: string; name: string };
export type Board = { version: string; name: string; columns: Column[]; featureColumns: Column[] };
export type Feature = { version: string; id: string; revision: number; title: string; status: string; description: string; createdAt: string; updatedAt: string; archived: boolean };
export type FeatureChanges = Partial<Pick<Feature, 'title' | 'status' | 'description' | 'archived'>>;
export type Snapshot = { config: Board; items: Item[]; features: Feature[] };
export type Changes = Partial<Pick<Item, WritableKey>>;
/** A new thread entry as posted by the CLI or the bridge. */
export type NewEntry = { kind: EntryKind; body: string; author?: string | null; replyTo?: string | null };
/** Editable fields of an existing thread entry. */
export type EntryChanges = { body?: string; author?: string | null };

/** Expected failure (BoardError): CLI prints `Error: <message>` to stderr, exit 1. Bridge answers 400 `invalid`. */
export class BoardError extends Error { override name = 'BoardError'; }
/** Concurrency conflict (Conflict): CLI exit 2. Bridge answers 409 `conflict`. */
export class Conflict extends BoardError { override name = 'Conflict'; }

/** A card committed, but one or more derived feature updates did not. */
export class FeatureSyncError extends BoardError {
  constructor(public readonly itemId: string, public readonly featureIds: string[], reason: string) {
    super(`Card ${itemId} was saved, but feature status update failed for ${featureIds.join(', ')}: ${reason}. Reload the board; inspect the listed features and set their statuses with feature-move. For a non-archived card, reapplying its saved status with move recalculates its current feature. For an archived card, status retries do not recalculate; manually correct each listed feature. Do not repeat create.`);
  }
}
