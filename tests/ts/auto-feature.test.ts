import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as board from '../../scripts/lib/store';
import { main } from '../../scripts/agentboard';

test('feature follows linked unfinished work and completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-auto-'));
  try {
    board.init(root);
    const feature = board.createFeature(root, {title: 'Feature'});
    const first = board.create(root, {title: 'First', feature: feature.id});
    board.update(root, first.id, null, {status: 'in-progress'});
    expect(board.getFeature(root, feature.id).status).toBe('active');
    board.update(root, first.id, null, {status: 'done'});
    expect(board.getFeature(root, feature.id).status).toBe('done');
    const second = board.create(root, {title: 'Second', feature: feature.id});
    expect(board.getFeature(root, feature.id).status).toBe('planned');
    board.update(root, second.id, null, {status: 'in-progress'});
    expect(board.getFeature(root, feature.id).status).toBe('active');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('custom columns, archives, empty features, and manual overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-auto-custom-'));
  try {
    board.init(root);
    const path = join(root, '.agentboard', 'board.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.columns = ['queue', 'working', 'review', 'finished'].map(id => ({id, name:id}));
    config.featureColumns = ['planned', 'active', 'review', 'done'].map(id => ({id, name:id}));
    writeFileSync(path, JSON.stringify(config));
    const feature = board.createFeature(root, {title:'Custom'});
    const item = board.create(root, {title:'Work', feature:feature.id, status:'review'});
    expect(board.getFeature(root, feature.id).status).toBe('review');
    const revision = board.getFeature(root, feature.id).revision;
    board.updateFeature(root, feature.id, revision, {status:'active'});
    board.update(root, item.id, null, {title:'Unrelated'});
    expect(board.getFeature(root, feature.id).status).toBe('active');
    board.update(root, item.id, null, {archived:true});
    expect(board.getFeature(root, feature.id).status).toBe('active');
    board.update(root, item.id, null, {archived:false});
    expect(board.getFeature(root, feature.id).status).toBe('review');
    expect(() => board.updateFeature(root, feature.id, revision, {title:'Stale'})).toThrow('Revision mismatch; current revision is 4');
    board.update(root, item.id, null, {status:'finished'});
    expect(board.getFeature(root, feature.id).status).toBe('done');
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('preflight prevents card writes and clearing a damaged feature remains possible', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-preflight-'));
  try {
    board.init(root);
    const feature = board.createFeature(root, {title:'F'});
    const item = board.create(root, {title:'I', feature:feature.id});
    const bad = join(root, '.agentboard', 'items', 'AB-FFFFFFFFFFFF.json');
    writeFileSync(bad, '{');
    expect(() => board.update(root, item.id, null, {status:'done'})).toThrow();
    expect(board.get(root, item.id).status).toBe('backlog');
    expect(() => board.create(root, {title:'Rejected', feature:feature.id})).toThrow();
    rmSync(bad);
    expect(board.snapshot(root).items).toHaveLength(1);
    writeFileSync(board.featurePath(root, feature.id), '{');
    expect(() => board.update(root, item.id, null, {status:'done'})).toThrow();
    expect(board.get(root, item.id).status).toBe('backlog');
    expect(board.update(root, item.id, null, {feature:null}).feature).toBeNull();
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('blocked work and relinking recalculate both features while archived features stay unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-relink-'));
  try {
    board.init(root);
    const a = board.createFeature(root, {title:'A'});
    const b = board.createFeature(root, {title:'B'});
    const one = board.create(root, {title:'One', feature:a.id, status:'blocked'});
    const two = board.create(root, {title:'Two', feature:a.id, status:'backlog'});
    expect(board.getFeature(root, a.id).status).toBe('active');
    board.update(root, one.id, null, {feature:b.id});
    expect(board.getFeature(root, a.id).status).toBe('planned');
    expect(board.getFeature(root, b.id).status).toBe('active');
    board.update(root, one.id, null, {feature:null});
    expect(board.getFeature(root, b.id).status).toBe('active');
    board.updateFeature(root, a.id, null, {archived:true});
    board.update(root, two.id, null, {status:'done'});
    expect(board.getFeature(root, a.id).status).toBe('planned');
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('progress uses the configured last card column', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-progress-'));
  try {
    board.init(root);
    const path = join(root, '.agentboard', 'board.json');
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    cfg.columns = [{id:'todo',name:'Todo'}, {id:'shipped',name:'Shipped'}];
    writeFileSync(path, JSON.stringify(cfg));
    const feature = board.createFeature(root, {title:'F'});
    board.create(root, {title:'I', feature:feature.id, status:'shipped'});
    const snap = board.snapshot(root);
    expect(board.featureSummary(snap.features[0], snap.items, snap.config.columns).progress).toEqual({done:1,total:1});
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('failed feature write identifies saved card and same-status move repairs it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-failed-sync-'));
  const old = board.seams.beforeFeatureWrite;
  try {
    board.init(root);
    const f = board.createFeature(root, {title:'F'});
    board.seams.beforeFeatureWrite = () => { throw new Error('injected failure'); };
    let error: any;
    try { board.create(root, {title:'Saved once', feature:f.id, status:'done'}); } catch (e) { error = e; }
    expect(error.message).toContain('injected failure');
    expect(error.itemId).toMatch(/^AB-[A-F0-9]{12}$/);
    expect(error.featureIds).toEqual([f.id]);
    expect(error.message).toContain('For an archived card, status retries do not recalculate');
    expect(error.message).toContain('Do not repeat create');
    expect(board.get(root, error.itemId).title).toBe('Saved once');
    expect(board.getFeature(root, f.id).status).toBe('planned');
    board.seams.beforeFeatureWrite = old;
    board.update(root, error.itemId, null, {status:'done'});
    expect(board.getFeature(root, f.id).status).toBe('done');
    expect(board.snapshot(root).items).toHaveLength(1);
  } finally { board.seams.beforeFeatureWrite = old; rmSync(root, {recursive:true, force:true}); }
});

test('editing status of an archived card does not override a manual feature status', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-archived-status-'));
  try {
    board.init(root);
    const f = board.createFeature(root, {title:'F'});
    board.create(root, {title:'Live', feature:f.id});
    const archived = board.create(root, {title:'Archived', feature:f.id, archived:true});
    board.updateFeature(root, f.id, null, {status:'active'});
    board.update(root, archived.id, null, {status:'done'});
    expect(board.getFeature(root, f.id).status).toBe('active');
  } finally { rmSync(root, {recursive:true, force:true}); }
});


test('CLI error reports the saved card and recovery instructions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-cli-sync-'));
  const old = board.seams.beforeFeatureWrite;
  try {
    board.init(root);
    const feature = board.createFeature(root, {title:'F'});
    board.seams.beforeFeatureWrite = () => { throw new Error('injected CLI failure'); };
    const errors: string[] = [];
    const code = main(['--root', root, '--quiet', 'create', 'CLI saved', '--feature', feature.id, '--status', 'done'], {out:() => {}, err:line => errors.push(line), env:{}});
    expect(code).toBe(1);
    const item = board.snapshot(root).items[0];
    expect(errors.join(' ')).toContain(`Card ${item.id} was saved`);
    expect(errors.join(' ')).toContain(feature.id);
    expect(errors.join(' ')).toContain('Do not repeat create');
    expect(errors.join(' ')).toContain('feature-move');
  } finally { board.seams.beforeFeatureWrite = old; rmSync(root, {recursive:true, force:true}); }
});
