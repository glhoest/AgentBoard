#!/usr/bin/env bun
import * as issues from './lib/issues';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from './lib/args';
import { withLock } from './lib/lock';
import { startBridge } from './lib/serve';
import { setup } from './lib/setup';
import { updateNotice } from './lib/update-check';
import * as store from './lib/store';
import { BoardError, Conflict, type Changes, type Entry, type Item, type FeatureChanges } from './lib/types';
import { NEEDS_GRILLING } from './lib/versions';

export function formatJson(value: unknown, indent?: number): string {
  if (indent !== undefined) return JSON.stringify(value, null, indent);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => formatJson(item)).join(', ')}]`;
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${formatJson(item)}`).join(', ')}}`;
}

/** Where the CLI writes and which environment it reads; tests pass their own. */
export type Io = {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
};

const consoleIo: Io = {
  out: text => console.log(text),
  err: text => console.error(text),
  env: process.env,
};

/** One open question with the card it belongs to (output of `questions`). */
export type OpenQuestion = { item: string; title: string; status: string; question: Entry };

export function openQuestions(items: Item[]): OpenQuestion[] {
  const found: OpenQuestion[] = [];
  for (const item of items) {
    if (item.archived) continue;
    for (const question of store.openQuestions(item)) {
      found.push({ item: item.id, title: item.title, status: item.status, question });
    }
  }
  return found;
}

const NOTICE_IDS = 10;

/**
 * The stderr line shown after a command while questions are open, or null. Reads the board without
 * the lock and without writing (older files are upgraded in memory only); any failure means no notice.
 */
export function questionNotice(start: string): string | null {
  let items: Item[];
  try {
    items = store.snapshot(store.locate(start), { persist: false }).items;
  } catch {
    return null;
  }
  const open = openQuestions(items);
  if (!open.length) return null;
  const ids = [...new Set(open.map(entry => entry.item))];
  const shown = ids.slice(0, NOTICE_IDS).join(', ') + (ids.length > NOTICE_IDS ? ` (+${ids.length - NOTICE_IDS} more)` : '');
  const count = open.length === 1 ? '1 open question' : `${open.length} open questions`;
  return `${count} on ${shown} — run "questions"`;
}

type GrillCard = {
  id: string; title: string; status: string; priority: string; assignee: string | null;
  description: string; acceptanceCriteria: Item['acceptanceCriteria']; openQuestions: Entry[];
};

function grillCards(root: string, id: string | null): GrillCard[] {
  let cards: Item[];
  if (id !== null) {
    cards = [store.get(root, id)];
  } else {
    const snap = store.snapshot(root);
    if (!snap.config.columns.some(column => column.id === NEEDS_GRILLING.id)) {
      throw new BoardError(`This board has no "${NEEDS_GRILLING.id}" column; add it to .agentboard/board.json or pass a card ID`);
    }
    cards = snap.items.filter(item => !item.archived && item.status === NEEDS_GRILLING.id);
  }
  return cards.map(item => ({
    id: item.id, title: item.title, status: item.status, priority: item.priority, assignee: item.assignee,
    description: item.description, acceptanceCriteria: item.acceptanceCriteria, openQuestions: store.openQuestions(item),
  }));
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(line => (line ? prefix + line : line)).join('\n');
}

/** Plain-text grilling brief, meant to be pasted into a grilling session. */
export function grillBrief(cards: GrillCard[], single: boolean): string {
  if (!cards.length) return 'No cards in Needs grilling.';
  const lines: string[] = [];
  lines.push(single ? 'Grilling brief' : `Grilling brief: ${cards.length} card${cards.length === 1 ? '' : 's'} in Needs grilling`);
  for (const card of cards) {
    lines.push('', `## ${card.id}: ${card.title}`);
    lines.push(`Status: ${card.status} | Priority: ${card.priority} | Assignee: ${card.assignee ?? 'none'}`);
    lines.push('', 'Description:', card.description.trim() ? indent(card.description, '  ') : '  (none)');
    lines.push('', 'Acceptance criteria:');
    if (!card.acceptanceCriteria.length) lines.push('  (none)');
    for (const criterion of card.acceptanceCriteria) lines.push(`  - [${criterion.done ? 'x' : ' '}] ${criterion.text}`);
    lines.push('', `Open questions (${card.openQuestions.length}):`);
    if (!card.openQuestions.length) lines.push('  (none)');
    for (const question of card.openQuestions) {
      lines.push(`  - ${question.id}${question.author ? ` (${question.author})` : ''}:`);
      lines.push(indent(question.body, '      '));
    }
  }
  lines.push('', 'Answer each question with: answer CARD_ID QUESTION_ID "answer"');
  lines.push('When a card has no open questions left: move CARD_ID todo');
  return lines.join('\n');
}

function authorFrom(option: string | null, io: Io): string | null {
  if (option !== null) return option;
  const env = io.env.AGENTBOARD_AUTHOR;
  return env ? env : null;
}

export function main(argv: string[], io: Io = consoleIo): number {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.out(parsed.text);
    return 0;
  }
  if (parsed.kind === 'error') {
    io.err(parsed.text);
    return 2;
  }

  const args = parsed.args;
  let code = 0;
  try {
    let result: unknown;
    let text: string | null = null;
    if (args.cmd === 'init') {
      result = store.init(args.path);
    } else if (args.cmd === 'setup') {
      result = setup(args.path, dirname(dirname(import.meta.path)));
    } else {
      const root = store.locate(args.root ?? process.cwd());
      switch (args.cmd) {
        case 'issues':
          result = issues.listIssues(root).map(issue => issues.issueSummary(root, issue));
          break;
        case 'issue-show':
          result = issues.issueSummary(root, issues.getIssue(root, args.id));
          break;
        case 'issue-create':
          result = issues.createIssue(root, {
            title: args.title,
            observed: args.observed ?? undefined,
            expected: args.expected ?? undefined,
            reproduction: args.reproduction ?? undefined,
          });
          break;
        case 'issue-evidence':
          result = issues.addEvidence(root, args.id, args.revision, args.body);
          break;
        case 'issue-promote':
          result = issues.promoteIssue(root, args.id, args.revision, args.workItem);
          break;
        case 'issue-edit': {
          const changes: issues.IssueChanges = {};
          const fields = ['title', 'status', 'observed', 'expected', 'reproduction',
            'workItem', 'closureReason', 'duplicateOf'] as const;
          for (const key of fields) {
            if (args[key] !== null) (changes as any)[key] = args[key];
          }
          if (args.criteriaJson !== null) changes.criteria = JSON.parse(args.criteriaJson);
          result = issues.updateIssue(root, args.id, args.revision, changes);
          break;
        }
        case 'list':
          result = withLock(root, () => store.snapshot(root).items).filter(item =>
            (args.all || !item.archived) &&
            (!args.status || item.status === args.status) &&
            (!args.assignee || item.assignee === args.assignee) &&
            (!args.feature || item.feature === args.feature));
          break;
        case 'show':
          result = store.get(root, args.id);
          break;
        case 'create': {
          const values: Changes = { title: args.title };
          if (args.feature !== null) values.feature = args.feature;
          if (args.status !== null) values.status = args.status;
          if (args.priority !== null) values.priority = args.priority;
          if (args.assignee !== null) values.assignee = args.assignee;
          if (args.description !== null) values.description = args.description;
          if (args.label !== null) values.labels = args.label;
          if (args.criterion?.length) values.acceptanceCriteria = args.criterion.map(text => ({ text, done: false }));
          result = store.create(root, values);
          break;
        }
        case 'edit': {
          if ((args.archive && args.unarchive) || (args.assignee !== null && args.unassign)) {
            throw new BoardError('Conflicting options');
          }
          const changes: Changes = {};
          if (args.feature !== null) changes.feature = args.feature;
          if (args.clearFeature) changes.feature = null;
          if (args.title !== null) changes.title = args.title;
          if (args.status !== null) changes.status = args.status;
          if (args.priority !== null) changes.priority = args.priority;
          if (args.assignee !== null) changes.assignee = args.assignee;
          if (args.description !== null) changes.description = args.description;
          if (args.notes !== null) changes.notes = args.notes;
          if (args.unassign) changes.assignee = null;
          if (args.archive || args.unarchive) changes.archived = args.archive;
          if (args.labelsJson !== null) changes.labels = JSON.parse(args.labelsJson);
          if (args.criteriaJson !== null) changes.acceptanceCriteria = JSON.parse(args.criteriaJson);
          result = store.update(root, args.id, args.revision, changes);
          break;
        }
        case 'feature-create': {
          const values: FeatureChanges = { title: args.title };
          if (args.status !== null) values.status = args.status;
          if (args.description !== null) values.description = args.description;
          result = store.createFeature(root, values);
          break;
        }
        case 'feature-edit': {
          if (args.archive && args.unarchive) throw new BoardError('Conflicting options');
          const changes: FeatureChanges = {};
          if (args.title !== null) changes.title = args.title;
          if (args.status !== null) changes.status = args.status;
          if (args.description !== null) changes.description = args.description;
          if (args.archive || args.unarchive) changes.archived = args.archive;
          result = store.updateFeature(root, args.id, args.revision, changes);
          break;
        }
        case 'feature-move':
          result = store.updateFeature(root, args.id, args.revision, { status: args.status });
          break;
        case 'feature-show': {
          const snap = store.snapshot(root);
          const feature = store.getFeature(root, args.id, snap.config);
          const summary = store.featureSummary(feature, snap.items, snap.config.columns);
          result = { ...feature, progress: summary.progress, counts: summary.counts,
            cards: snap.items.filter(item => item.feature === feature.id).map(({ id, title, status, archived }) => ({ id, title, status, archived })) };
          break;
        }
        case 'features': {
          const snap = store.snapshot(root);
          const available = new Set(snap.features.filter(feature => !feature.archived).map(feature => feature.id));
          result = {
            features: snap.features.filter(feature => args.includeArchived || !feature.archived)
              .map(feature => store.featureSummary(feature, snap.items, snap.config.columns)),
            dangling: snap.items.filter(item => !item.archived && item.feature !== null && !available.has(item.feature))
              .map(item => item.id),
          };
          break;
        }
        case 'move':
          result = store.update(root, args.id, args.revision, { status: args.status });
          break;
        case 'claim':
          result = store.update(root, args.id, args.revision, { assignee: args.assignee }, { claim: true });
          break;
        case 'ask':
          result = store.addEntry(root, args.id, args.revision, { kind: 'question', body: args.body, author: authorFrom(args.author, io) });
          break;
        case 'answer':
          result = store.addEntry(root, args.id, args.revision,
            { kind: 'answer', body: args.body, author: authorFrom(args.author, io), replyTo: args.question });
          break;
        case 'comment':
          result = store.addEntry(root, args.id, args.revision,
            { kind: 'comment', body: args.body, author: authorFrom(args.author, io), replyTo: args.replyTo });
          break;
        case 'edit-entry': {
          const changes: { body?: string; author?: string } = {};
          if (args.body !== null) changes.body = args.body;
          if (args.author !== null) changes.author = args.author;
          if (!Object.keys(changes).length) throw new BoardError('Nothing to change: pass --body and/or --author');
          result = store.editEntry(root, args.id, args.entry, args.revision, changes);
          break;
        }
        case 'thread':
          result = store.get(root, args.id).thread;
          break;
        case 'questions':
          result = openQuestions(store.snapshot(root).items);
          break;
        case 'grill': {
          const cards = grillCards(root, args.id);
          if (args.json) result = cards;
          else text = grillBrief(cards, args.id !== null);
          break;
        }
        case 'serve':
          startBridge(root, args.port, args.ui ?? join(dirname(import.meta.path), 'board.html'));
          return 0;
      }
    }
    io.out(text ?? formatJson(result, args.json ? undefined : 2));
  } catch (error) {
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    code = error instanceof Conflict ? 2 : 1;
  }
  // The notice goes to stderr only, after the command, and never changes the exit code.
  if (!args.quiet && args.cmd !== 'setup' && args.cmd !== 'serve') {
    const notice = questionNotice(args.cmd === 'init' ? args.path : args.root ?? process.cwd());
    if (notice) io.err(notice);
  }
  return code;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const skill = dirname(dirname(import.meta.path));
  const noUpdate = existsSync(join(skill, '.agentboard-no-update'));
  if (noUpdate && parsed.kind === 'help') console.log('AgentBoard no-update build: self-update and automatic checks are unavailable.');
  if (parsed.kind === 'ok' && parsed.args.cmd === 'update') {
    if (noUpdate) { console.error('This AgentBoard build does not support updates.'); process.exit(1); }
    if (!skill.endsWith(join('.agents', 'skills', 'agentboard'))) { console.error('Update requires an installed AgentBoard copy.'); process.exit(1); }
    try {
      const { updateInstallation } = await import('./lib/update');
      const result = await updateInstallation(skill, fetch, parsed.args.force);
      console.log(parsed.args.json ? JSON.stringify(result) : result.changed ? `Updated AgentBoard to ${result.version}.` : `AgentBoard is already at ${result.version} or newer.`);
      process.exit(0);
    } catch (error) { console.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
  }
  if (parsed.kind === 'ok' && !noUpdate && !parsed.args.quiet && skill.endsWith(join('.agents', 'skills', 'agentboard'))) {
    const notice = await updateNotice(skill);
    if (notice) console.error(notice);
  }
  const code = main(argv);
  if (code !== 0 || parsed.kind !== 'ok' || parsed.args.cmd !== 'serve') process.exit(code);
}
