import { openQuestions } from './store';
import type { Item, Snapshot } from './types';
import type { Issue } from './issues';

export const EVENT_TYPES = [
  'card.created', 'card.updated', 'card.removed', 'card.status', 'card.assignee',
  'question.opened', 'question.closed', 'feature.created', 'feature.updated',
  'feature.removed', 'issue.created', 'issue.updated', 'issue.removed', 'issue.status', 'board.updated',
] as const;
export type EventType = typeof EVENT_TYPES[number];
export type WatchEvent = { type: EventType; id?: string; questionId?: string; fields?: string[]; before?: unknown; after?: unknown };

function fieldsChanged(before: object, after: object): string[] {
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key])).sort();
}

function questions(item: Item | undefined): Set<string> {
  return new Set(!item || item.archived ? [] : openQuestions(item).map(question => question.id));
}

/** Compare validated, in-memory snapshots, including edits that retain or lower revision numbers. */
export function changes(previous: Snapshot & { issues?: Issue[] }, next: Snapshot & { issues?: Issue[] }): WatchEvent[] {
  const events: WatchEvent[] = [];
  const configFields = fieldsChanged(previous.config, next.config);
  if (configFields.length) events.push({ type: 'board.updated', fields: configFields });
  const oldCards = new Map(previous.items.map(item => [item.id, item]));
  const newCards = new Map(next.items.map(item => [item.id, item]));
  for (const id of [...new Set([...oldCards.keys(), ...newCards.keys()])].sort()) {
    const before = oldCards.get(id);
    const after = newCards.get(id);
    if (!before) events.push({ type: 'card.created', id });
    else if (!after) events.push({ type: 'card.removed', id });
    else {
      const fields = fieldsChanged(before, after);
      if (fields.length) events.push({ type: 'card.updated', id, fields });
      if (before.status !== after.status) events.push({ type: 'card.status', id, before: before.status, after: after.status });
      if (before.assignee !== after.assignee) events.push({ type: 'card.assignee', id, before: before.assignee, after: after.assignee });
    }
    const oldQuestions = questions(before);
    const newQuestions = questions(after);
    for (const questionId of newQuestions) if (!oldQuestions.has(questionId)) events.push({ type: 'question.opened', id, questionId });
    for (const questionId of oldQuestions) if (!newQuestions.has(questionId)) events.push({ type: 'question.closed', id, questionId });
  }
  const oldFeatures = new Map(previous.features.map(feature => [feature.id, feature]));
  const newFeatures = new Map(next.features.map(feature => [feature.id, feature]));
  for (const id of [...new Set([...oldFeatures.keys(), ...newFeatures.keys()])].sort()) {
    const before = oldFeatures.get(id);
    const after = newFeatures.get(id);
    if (!before) events.push({ type: 'feature.created', id });
    else if (!after) events.push({ type: 'feature.removed', id });
    else {
      const fields = fieldsChanged(before, after);
      if (fields.length) events.push({ type: 'feature.updated', id, fields });
    }
  }
  const oldIssues = new Map((previous.issues ?? []).map(issue => [issue.id, issue]));
  const newIssues = new Map((next.issues ?? []).map(issue => [issue.id, issue]));
  for (const id of [...new Set([...oldIssues.keys(), ...newIssues.keys()])].sort()) {
    const before = oldIssues.get(id);
    const after = newIssues.get(id);
    if (!before) events.push({ type: 'issue.created', id });
    else if (!after) events.push({ type: 'issue.removed', id });
    else {
      const fields = fieldsChanged(before, after);
      if (fields.length) events.push({ type: 'issue.updated', id, fields });
      if (before.status !== after.status) events.push({ type: 'issue.status', id, before: before.status, after: after.status });
    }
  }
  return events;
}
