// Custom card fields: definitions live in board.json (`fields`), values in each card (`fields` object).
// This module owns validation, value parsing and the exact/numeric/contains filters.
import { BoardError, SLUG_RE, type Item } from './types';

export const FIELD_TYPES = ['text', 'number', 'boolean'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type FieldValue = string | number | boolean;
export type FieldDef = { id: string; name: string; type: FieldType };
/** Key order of a definition in board.json. */
export const FIELD_DEF_KEYS = ['id', 'name', 'type'];

export const FIELD_LIMITS = { fields: 50, name: 80, text: 1000 } as const;

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export function validateFieldDefs(defs: unknown): FieldDef[] {
  if (!Array.isArray(defs)) throw new BoardError('Invalid fields');
  if (defs.length > FIELD_LIMITS.fields) throw new BoardError(`A board holds at most ${FIELD_LIMITS.fields} fields`);
  const seen = new Set<string>();
  for (const def of defs) {
    if (!isObject(def) || Object.keys(def).sort().join() !== [...FIELD_DEF_KEYS].sort().join()) throw new BoardError('Invalid field definition');
    if (typeof def.id !== 'string' || !SLUG_RE.test(def.id)) throw new BoardError('Field IDs are lowercase letters, digits and dashes, starting with a letter (max 40)');
    if (seen.has(def.id)) throw new BoardError(`Duplicate field id ${def.id}`);
    seen.add(def.id);
    if (typeof def.name !== 'string' || !def.name.trim() || def.name.length > FIELD_LIMITS.name) throw new BoardError(`Field name must be 1–${FIELD_LIMITS.name} characters`);
    if (!(FIELD_TYPES as readonly unknown[]).includes(def.type)) throw new BoardError(`Field type must be one of: ${FIELD_TYPES.join(', ')}`);
  }
  return defs as FieldDef[];
}

export function validateFieldValue(def: FieldDef, value: unknown): FieldValue {
  if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new BoardError(`Field ${def.id} needs a finite number`);
  } else if (def.type === 'boolean') {
    if (typeof value !== 'boolean') throw new BoardError(`Field ${def.id} needs true or false`);
  } else if (typeof value !== 'string' || !value.trim() || value.length > FIELD_LIMITS.text) {
    throw new BoardError(`Field ${def.id} needs text of 1–${FIELD_LIMITS.text} characters`);
  }
  return value as FieldValue;
}

/** Validates a card's `fields` object against the board's definitions. Returns it with keys in definition order. */
export function validateFieldValues(values: unknown, defs: FieldDef[]): Record<string, FieldValue> {
  if (!isObject(values)) throw new BoardError('Invalid fields');
  for (const key of Object.keys(values)) {
    const def = defs.find(candidate => candidate.id === key);
    if (!def) throw new BoardError(`Unknown field ${key}; define it with field-add`);
    validateFieldValue(def, values[key]);
  }
  return values as Record<string, FieldValue>;
}

/** Same values, keys in definition order, so file bytes do not depend on the order of edits. */
export function orderFieldValues(values: Record<string, FieldValue>, defs: FieldDef[]): Record<string, FieldValue> {
  const ordered: Record<string, FieldValue> = {};
  for (const def of defs) if (def.id in values) ordered[def.id] = values[def.id];
  return ordered;
}

export function findField(defs: FieldDef[], id: string): FieldDef {
  const def = defs.find(candidate => candidate.id === id);
  if (!def) throw new BoardError(`Unknown field ${id}; known fields: ${defs.map(candidate => candidate.id).join(', ') || '(none)'}`);
  return def;
}

/** Parses command-line text into a value of the field's type. */
export function parseFieldValue(def: FieldDef, text: string): FieldValue {
  if (def.type === 'number') {
    if (!NUMBER_RE.test(text.trim())) throw new BoardError(`Field ${def.id} needs a number, got '${text}'`);
    return validateFieldValue(def, Number(text));
  }
  if (def.type === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new BoardError(`Field ${def.id} needs true or false, got '${text}'`);
    return text === 'true';
  }
  return validateFieldValue(def, text);
}

/** Splits `ID=VALUE` at the first `=`. */
export function splitAssignment(text: string): [string, string] {
  const at = text.indexOf('=');
  if (at < 1) throw new BoardError(`Expected ID=VALUE, got '${text}'`);
  return [text.slice(0, at), text.slice(at + 1)];
}

export type FieldChange = { set?: Record<string, FieldValue>; clear?: string[] };

/** Builds a set/clear patch from CLI `ID=VALUE` and `ID` arguments. */
export function buildFieldChange(defs: FieldDef[], sets: string[] | null, clears: string[] | null): FieldChange | null {
  if (!sets?.length && !clears?.length) return null;
  const set: Record<string, FieldValue> = {};
  for (const assignment of sets ?? []) {
    const [id, text] = splitAssignment(assignment);
    set[id] = parseFieldValue(findField(defs, id), text);
  }
  for (const id of clears ?? []) {
    findField(defs, id);
    if (id in set) throw new BoardError(`Field ${id} is both set and cleared`);
  }
  return { set, clear: clears ?? [] };
}

export function applyFieldChange(values: Record<string, FieldValue>, change: FieldChange): Record<string, FieldValue> {
  const next = { ...values, ...(change.set ?? {}) };
  for (const id of change.clear ?? []) delete next[id];
  return next;
}

/**
 * Card filters of `list`. All given filters must match (AND); a card without a value matches only `missing`.
 * - equals: exact. Numbers compare numerically (5 equals 5.0), text is case-sensitive and whole-value, booleans are true/false.
 * - min / max: inclusive numeric bounds, number fields only.
 * - contains: case-insensitive substring, text fields only.
 * - has / missing: the card has / has no value for the field.
 */
export type FieldFilters = { equals?: string[] | null; min?: string[] | null; max?: string[] | null; contains?: string[] | null; has?: string[] | null; missing?: string[] | null };

type Predicate = (item: Item) => boolean;

export function buildFieldFilter(defs: FieldDef[], filters: FieldFilters): Predicate {
  const checks: Predicate[] = [];
  const need = (def: FieldDef, type: FieldType, option: string) => {
    if (def.type !== type) throw new BoardError(`${option} needs a ${type} field; ${def.id} is ${def.type}`);
  };
  for (const text of filters.equals ?? []) {
    const [id, raw] = splitAssignment(text);
    const def = findField(defs, id);
    const wanted = parseFieldValue(def, raw);
    checks.push(item => item.fields[id] === wanted);
  }
  for (const [option, list, test] of [
    ['--field-min', filters.min, (value: number, bound: number) => value >= bound],
    ['--field-max', filters.max, (value: number, bound: number) => value <= bound],
  ] as const) {
    for (const text of list ?? []) {
      const [id, raw] = splitAssignment(text);
      const def = findField(defs, id);
      need(def, 'number', option);
      const bound = parseFieldValue(def, raw) as number;
      checks.push(item => typeof item.fields[id] === 'number' && test(item.fields[id] as number, bound));
    }
  }
  for (const text of filters.contains ?? []) {
    const [id, raw] = splitAssignment(text);
    const def = findField(defs, id);
    need(def, 'text', '--field-contains');
    const needle = raw.toLowerCase();
    if (!needle) throw new BoardError('--field-contains needs non-empty text');
    checks.push(item => typeof item.fields[id] === 'string' && (item.fields[id] as string).toLowerCase().includes(needle));
  }
  for (const id of filters.has ?? []) { findField(defs, id); checks.push(item => id in item.fields); }
  for (const id of filters.missing ?? []) { findField(defs, id); checks.push(item => !(id in item.fields)); }
  return item => checks.every(check => check(item));
}
