import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoardError, Conflict, SLUG_RE } from './types';
import { atomicWrite } from './store';
import { withLock } from './lock';

export type GraphSettings = {
  version: '1.0.0';
  orientation: 'horizontal' | 'vertical';
  layout: 'compact' | 'loose';
  showUnlinked: boolean;
  fields: string[];
};

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  version: '1.0.0', orientation: 'horizontal', layout: 'compact', showUnlinked: false, fields: [],
};

export function validateGraphSettings(value: unknown): GraphSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardError('Invalid graph settings');
  const v = value as Record<string, unknown>;
  if (typeof v.version === 'string' && /^\d+\.\d+\.\d+$/.test(v.version)) {
    const parts = v.version.split('.').map(Number);
    if (parts[0] > 1 || (parts[0] === 1 && (parts[1] > 0 || parts[2] > 0))) {
      throw new BoardError('Graph settings were written by a newer AgentBoard; update this copy');
    }
  }
  if (Object.keys(v).sort().join(',') !== 'fields,layout,orientation,showUnlinked,version'
    || v.version !== '1.0.0' || !['horizontal', 'vertical'].includes(v.orientation as string)
    || !['compact', 'loose'].includes(v.layout as string) || typeof v.showUnlinked !== 'boolean'
    || !Array.isArray(v.fields) || v.fields.length > 100
    || v.fields.some(field => typeof field !== 'string' || !(['assignee', 'priority', 'labels', 'feature'].includes(field)
      || (field.startsWith('field:') && SLUG_RE.test(field.slice(6)))))
    || new Set(v.fields).size !== v.fields.length) throw new BoardError('Invalid graph settings');
  return v as GraphSettings;
}

function path(root: string): string { return join(root, '.agentboard', 'graph-settings.json'); }

/** Caller holds board lock for a snapshot consistent with other files. */
export function readGraphSettings(root: string): { settings: GraphSettings; hash: string | null } {
  const file = path(root);
  if (!existsSync(file)) return { settings: { ...DEFAULT_GRAPH_SETTINGS, fields: [] }, hash: null };
  const bytes = readFileSync(file);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new BoardError('Invalid graph settings JSON'); }
  return { settings: validateGraphSettings(value), hash: createHash('sha256').update(bytes).digest('hex') };
}

export function saveGraphSettings(root: string, value: unknown, expectedHash: unknown): { settings: GraphSettings; hash: string | null } {
  const settings = validateGraphSettings(value);
  if (expectedHash !== null && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))) throw new BoardError('Expected graph settings hash or null');
  return withLock(root, () => {
    if (readGraphSettings(root).hash !== expectedHash) throw new Conflict('Graph settings changed since they were read');
    atomicWrite(path(root), settings);
    return readGraphSettings(root);
  });
}
