// Browser tests for scripts/board.html. Run from the skill directory:  bun test tests/ui.test.ts
// Uses the real CLI/bridge (default: Bun implementation; AB_CLI overrides) and real Chrome (CDP). Skipped when Chrome is not found.
import {afterAll, beforeAll, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Chrome, findChrome, type Page} from './cdp';

setDefaultTimeout(60000);

const HERE = import.meta.dir;
const TS_SCRIPT = resolve(HERE, '../scripts/agentboard.ts');
const BOARD = resolve(HERE, '../scripts/board.html');
const SHOTS = process.env.AB_SHOTS || '';   // optional directory for screenshots

// AB_CLI optionally overrides the command under test (space-separated, or a JSON array). Default: bun <abs>/scripts/agentboard.ts.
function cliCommand(): string[] {
  const env = process.env.AB_CLI?.trim();
  const cmd = env ? (env.startsWith('[') ? JSON.parse(env) : env.split(/\s+/)) : ['bun', TS_SCRIPT];
  // Resolve repo-relative script paths so the CLI works from any cwd.
  return cmd.map((t: string) => (existsSync(resolve(HERE, '..', t)) ? resolve(HERE, '..', t) : t));
}
const chromePath = findChrome(), CLI = cliCommand();
const ready = !!(chromePath && CLI);

type Json = any;
let root: string, tmpRoot: string, bridge: ReturnType<typeof Bun.spawn> | null = null, base = '', token = '';
let chrome: Chrome, page: Page;

function cli(...args: string[]): {code: number; out: string; err: string} {
  const r = Bun.spawnSync([...CLI!,'--root', root, '--json', ...args]);
  return {code: r.exitCode ?? -1, out: String(r.stdout).trim(), err: String(r.stderr).trim()};
}
function cliJson(...args: string[]): Json { const r = cli(...args); if (r.code !== 0) throw new Error(`cli ${args.join(' ')} failed: ${r.err}`); return JSON.parse(r.out); }
const items = (): Json[] => cliJson('list', '--all');
const byTitle = (t: string) => { const x = items().find(i => i.title === t); if (!x) throw new Error('no card titled ' + t); return x; };

async function startBridge() {
  bridge = Bun.spawn([...CLI!,'--root', root, 'serve', '--ui', BOARD], {stdout: 'pipe', stderr: 'pipe'});
  const reader = (bridge.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = '';
  while (!/Open: \S+/.test(buf)) { const {value, done} = await reader.read(); if (done) throw new Error('bridge exited'); buf += new TextDecoder().decode(value); }
  reader.releaseLock();
  const m = buf.match(/Open: (http:\/\/127\.0\.0\.1:\d+)\/#token=(\S+)/)!;
  base = m[1]; token = m[2];
}
const url = () => `${base}/#token=${token}`;
const cardsJs = `[...document.querySelectorAll('.col')].map(c => ({col: c.dataset.col, titles: [...c.querySelectorAll('.card-title')].map(t => t.textContent)}))`;
const colOf = (title: string) => `(() => { const t = [...document.querySelectorAll('.card-title')].find(x => x.textContent === ${JSON.stringify(title)}); return t ? t.closest('.col').dataset.col : null; })()`;
const cardSel = (id: string) => `.card[data-id="${id}"]`;
const hasCard = (title: string) => `[...document.querySelectorAll('.card-title')].some(x => x.textContent === ${JSON.stringify(title)})`;
const shot = async (name: string) => { if (SHOTS) { mkdirSync(SHOTS, {recursive: true}); await page.screenshot(join(SHOTS, name + '.png')); } };
async function openCard(title: string) { await page.click(`.card-title[title=${JSON.stringify(title)}]`); await page.waitFor(`document.querySelector('#editor').open && document.querySelector('#ed-title').value === ${JSON.stringify(title)}`, 5000, 'editor open for ' + title); }

beforeAll(async () => {
  if (!ready) return;
  tmpRoot = mkdtempSync(join(tmpdir(), 'ab-ui-'));
  root = join(tmpRoot, 'project'); mkdirSync(root);
  const init = Bun.spawnSync([...CLI!,'init', root]); if (init.exitCode !== 0) throw new Error('init failed ' + init.stderr);
  cliJson('create', 'Seed card', '--priority', 'high', '--label', 'seed', '--criterion', 'First', '--criterion', 'Second');
  await startBridge();
  chrome = await Chrome.launch(chromePath!);
  page = await chrome.newPage();
  await page.resize(1400, 900);
});
afterAll(async () => {
  if (!ready) return;
  try { await chrome?.close(); } catch {}
  try { bridge?.kill(); await bridge?.exited; } catch {}
  for (let i = 0; i < 5; i++) { try { rmSync(tmpRoot, {recursive: true, force: true}); break; } catch { await Bun.sleep(200); } }
});

describe.skipIf(!ready)('board.html (bridge mode)', () => {
  test('without a token it shows launch instructions and makes no API calls', async () => {
    await page.goto(`${base}/`);
    await page.waitFor(`document.body.innerText.includes('Connect AgentBoard to a project')`);
    expect(await page.eval(`document.body.innerText.includes('agentboard.ts --root /path/to/project serve')`)).toBe(true);
    expect(page.requests.filter(r => r.url.includes('/api/')).length).toBe(0);
    await shot('01-launch');
  });

  test('with a token it renders configured columns and cards; token is only in the Authorization header', async () => {
    page.requests.length = 0;
    await page.goto(url());
    await page.waitFor(hasCard('Seed card'));
    const cols = await page.eval<string[]>(`[...document.querySelectorAll('.col')].map(c => c.dataset.col)`);
    expect(cols).toEqual(['backlog', 'needs-grilling', 'todo', 'in-progress', 'blocked', 'done']);
    const card = await page.eval<Json>(`(() => { const a = document.querySelector('.card'); return {id: a.querySelector('.id').textContent, prio: a.querySelector('.prio').textContent, labels: [...a.querySelectorAll('.label')].map(x => x.textContent), crit: a.querySelector('.crit').textContent.trim(), assignee: a.querySelector('.assignee').textContent}; })()`);
    expect(card.id).toMatch(/^AB-[0-9A-F]{12}$/);
    expect(card.prio).toBe('high'); expect(card.labels).toEqual(['seed']); expect(card.crit).toContain('0/2'); expect(card.assignee).toBe('Unassigned');
    const api = page.requests.filter(r => r.url.includes('/api/'));
    expect(api.length).toBeGreaterThan(0);
    for (const r of api) {
      expect(r.url.startsWith(base + '/api/')).toBe(true);                 // relative → same origin
      expect(r.headers.Authorization ?? r.headers.authorization).toBe('Bearer ' + token);
      expect(r.url).not.toContain(token);                                   // never in a URL
    }
    expect(page.requests.every(r => r.url.startsWith(base) || r.url.startsWith('about:') || r.url.startsWith('data:'))).toBe(true);
    expect(await page.eval(`document.documentElement.outerHTML.includes(${JSON.stringify(token)})`)).toBe(false);
    expect(await page.eval(`document.querySelector('#conn').dataset.state`)).toBe('ok');
    await shot('02-board-desktop');
  });

  test('view controls hide correctly and expose the active view', async () => {
    await page.goto(url());
    await page.waitFor(hasCard('Seed card'));
    expect(await page.eval(`getComputedStyle(document.querySelector('#new-feature')).display`)).toBe('none');
    expect(await page.eval(`getComputedStyle(document.querySelector('#toolbar')).display`)).not.toBe('none');
    await page.focus('#view-features');
    await page.key(' ');
    await page.waitFor(`document.querySelector('#view-features').getAttribute('aria-pressed') === 'true'`);
    expect(await page.eval(`getComputedStyle(document.querySelector('#toolbar')).display`)).toBe('none');
    expect(await page.eval(`getComputedStyle(document.querySelector('#new-feature')).display`)).not.toBe('none');
    expect(await page.eval(`getComputedStyle(document.querySelector('#view-features')).backgroundColor !== getComputedStyle(document.querySelector('#view-board')).backgroundColor`)).toBe(true);
    await page.key('/');
    expect(await page.eval(`document.activeElement.id`)).not.toBe('q');
    await page.offline(true);
    try {
      await page.eval(`window.dispatchEvent(new Event('focus'))`);
      await page.waitFor(`document.querySelector('#conn').dataset.state === 'error'`);
      expect(await page.eval(`getComputedStyle(document.querySelector('#toolbar')).display`)).toBe('none');
    } finally {
      await page.offline(false);
      await page.eval(`window.dispatchEvent(new Event('online'))`);
      await page.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
    }
    await page.click('#view-board');
  });

  test('No feature includes dangling links and resets an unavailable selection', async () => {
    const feature = cliJson('feature-create', 'Filter feature');
    const card = cliJson('create', 'Dangling filter card', '--feature', feature.id);
    try {
      await page.goto(url());
      await page.waitFor(hasCard('Dangling filter card'));
      await page.eval(`document.querySelector('#f-feature').value = ${JSON.stringify(feature.id)}; document.querySelector('#f-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      cliJson('feature-edit', feature.id, '--archive');
      await page.waitFor(`document.querySelector('#f-feature').value === '' && document.querySelector('#toasts').textContent.includes('no longer available')`);
      await page.eval(`document.querySelector('#f-feature').value = 'none'; document.querySelector('#f-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      expect(await page.eval(hasCard('Dangling filter card'))).toBe(true);
      expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id))}).textContent`)).toContain('Feature unavailable');
      expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id) + ' .badge.bad')}).textContent`)).toBe('Feature unavailable');
      expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id) + ' .badge.bad')}).getAttribute('aria-label')`)).toContain(feature.id);
      await page.resize(390, 900);
      expect(await page.eval(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
      await page.click('#f-clear');
      expect(await page.eval(`document.querySelector('#f-feature').value`)).toBe('');
    } finally {
      await page.resize(1400, 900);
      rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('removed selected feature resets filter and shown counts', async () => {
    const feature = cliJson('feature-create', 'Removed filter');
    const card = cliJson('create', 'Removed filter card', '--feature', feature.id);
    try {
      await page.goto(base + '/?removed-filter#token=' + token);
      await page.waitFor(hasCard('Removed filter card'));
      const total = items().filter(i => !i.archived).length;
      expect(await page.eval(`document.querySelector('#summary').textContent`)).toContain(`${total} shown`);
      await page.eval(`document.querySelector('#f-feature').value = ${JSON.stringify(feature.id)}; document.querySelector('#f-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      expect(await page.eval(`document.querySelector('#summary').textContent`)).toContain('1 shown');
      rmSync(join(root, '.agentboard/features', feature.id + '.json'));
      await page.waitFor(`document.querySelector('#f-feature').value === '' && document.querySelector('#toasts').textContent.includes('no longer available')`);
      expect(await page.eval(`document.querySelector('#summary').textContent`)).toContain(`${total} shown`);
      await page.eval(`document.querySelector('#f-feature').value = 'none'; document.querySelector('#f-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      expect(await page.eval(hasCard('Removed filter card'))).toBe(true);
      const filtered = await page.eval<number>(`document.querySelectorAll('.card[data-id^="AB-"]').length`);
      expect(await page.eval(`document.querySelector('#summary').textContent`)).toContain(`${filtered} shown`);
      await page.click('#f-clear');
      expect(await page.eval(`document.querySelector('#summary').textContent`)).toContain(`${total} shown`);
    } finally {
      rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('native feature drops handle moves, deferred polling, conflicts and busy writes', async () => {
    const feature = cliJson('feature-create', 'Drag feature');
    let off = () => {};
    let dragData: any = null;
    const start = async () => {
      dragData = null;
      const src = await page.eval<{x:number; y:number}>(`(() => { const r = document.querySelector(${JSON.stringify(cardSel(feature.id) + ' .id')}).getBoundingClientRect(); return {x:r.x + 4, y:r.y + r.height / 2}; })()`);
      await page.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...src});
      await page.send('Input.dispatchMouseEvent', {type:'mousePressed', ...src, button:'left', buttons:1, clickCount:1});
      for (let i = 1; i <= 10 && !dragData; i++) {
        await page.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:src.x + i * 6, y:src.y + i * 4, button:'left', buttons:1});
        await Bun.sleep(30);
      }
      const end = Date.now() + 3000;
      while (!dragData && Date.now() < end) await Bun.sleep(30);
      expect(dragData).not.toBeNull();
    };
    const drop = async (column: string) => {
      const dst = await page.eval<{x:number; y:number}>(`(() => { const r = document.querySelector('.col[data-col="${column}"] .col-head').getBoundingClientRect(); return {x:r.x + 40, y:r.bottom + 20}; })()`);
      for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', {type, ...dst, data:dragData});
      await page.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...dst, button:'left', clickCount:1});
    };
    try {
      await page.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => { const original = fetch; window.fetch = async (...args) => { const response = await original(...args); if (String(args[0]).includes('api/board')) window.__lastBoard = await response.clone().json(); return response; }; })()`});
      await page.goto(base + '/?feature-drag#token=' + token);
      await page.waitFor(hasCard('Seed card'));
      await page.click('#view-features');
      await page.waitFor(`!!document.querySelector(${JSON.stringify(cardSel(feature.id))})`);
      await page.send('Input.setInterceptDrags', {enabled:true});
      off = chrome.on(m => { if (m.sessionId === page.sid && m.method === 'Input.dragIntercepted') dragData = m.params.data; });
      await start();
      await drop('active');
      await page.waitFor(`${colOf('Drag feature')} === 'active'`);
      expect(cliJson('feature-show', feature.id).revision).toBe(2);
      await start();
      cliJson('feature-edit', feature.id, '--title', 'Renamed during drag');
      await page.waitFor(`window.__lastBoard.features.some(f => f.id === ${JSON.stringify(feature.id)} && f.title === 'Renamed during drag')`);
      await drop('active');
      await page.waitFor(hasCard('Renamed during drag'), 3000);
      await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).value = 'done'; document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).dispatchEvent(new Event('change', {bubbles:true}))`);
      await page.waitFor(`${colOf('Renamed during drag')} === 'done'`);
      expect(cliJson('feature-show', feature.id).revision).toBe(4);
      await start();
      cliJson('feature-edit', feature.id, '--description', 'Concurrent change');
      await drop('planned');
      await page.waitFor(`document.querySelector('#toasts').textContent.includes('changed')`);
      expect(cliJson('feature-show', feature.id).status).toBe('done');
      expect(cliJson('feature-show', feature.id).description).toBe('Concurrent change');
      await page.waitFor(`window.__lastBoard.features.some(f => f.id === ${JSON.stringify(feature.id)} && f.description === 'Concurrent change')`);
      await start();
      await page.send('Fetch.enable', {patterns:[{urlPattern:'*/api/features/*', requestStage:'Request'}]});
      await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).value = 'active'; document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).dispatchEvent(new Event('change', {bubbles:true}))`);
      await page.waitFor(`document.querySelector('#board').getAttribute('aria-busy') === 'true'`);
      expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id))}).draggable`)).toBe(false);
      await drop('planned');
      await page.waitFor(`document.querySelector('#toasts').textContent.includes('save is in progress')`);
      expect(cliJson('feature-show', feature.id).status).toBe('done');
    } finally {
      await page.send('Fetch.disable');
      off();
      await page.send('Input.setInterceptDrags', {enabled:false});
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
      await page.click('#view-board');
    }
  });

  test('feature select racing a poll preserves an external edit and recovers controls', async () => {
    const feature = cliJson('feature-create', 'Select race');
    let held = '';
    const off = chrome.on(m => { if (m.sessionId === page.sid && m.method === 'Fetch.requestPaused') held = m.params.requestId; });
    try {
      await page.goto(base + '/?feature-select-race#token=' + token);
      await page.waitFor(hasCard('Seed card'));
      await page.click('#view-features');
      await page.send('Fetch.enable', {patterns:[{urlPattern:'*/api/board', requestStage:'Response'}]});
      await page.eval(`window.dispatchEvent(new Event('focus'))`);
      const deadline = Date.now() + 5000;
      while (!held && Date.now() < deadline) await Bun.sleep(25);
      expect(held).not.toBe('');
      cliJson('feature-edit', feature.id, '--description', 'External wins');
      await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).value = 'active'; document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).dispatchEvent(new Event('change', {bubbles:true}))`);
      await page.waitFor(`document.querySelector('#toasts').textContent.includes('changed')`);
      await page.send('Fetch.continueRequest', {requestId:held});
      held = '';
      await page.send('Fetch.disable');
      await page.waitFor(`document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}) && !document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).disabled`);
      expect(cliJson('feature-show', feature.id).description).toBe('External wins');
      expect(cliJson('feature-show', feature.id).status).toBe('planned');
      await page.click(`${cardSel(feature.id)} .card-title`);
      expect(await page.eval(`document.querySelector('#feature-description').value`)).toBe('External wins');
      await page.eval(`document.querySelector('#feature-editor').close()`);
      await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).value = 'active'; document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).dispatchEvent(new Event('change', {bubbles:true}))`);
      await page.waitFor(`${colOf('Select race')} === 'active'`);
      const result = cliJson('feature-show', feature.id);
      expect(result.revision).toBe(3);
      expect(result.description).toBe('External wins');
    } finally {
      if (held) await page.send('Fetch.continueRequest', {requestId:held});
      await page.send('Fetch.disable');
      off();
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('feature draft survives polls and board draft survives view changes', async () => {
    const feature = cliJson('feature-create', 'Polling feature');
    const card = cliJson('create', 'Polling feature card');
    try {
      await page.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => { const original = fetch; window.fetch = async (...args) => { const response = await original(...args); if (String(args[0]).includes('api/board')) window.__lastBoard = await response.clone().json(); return response; }; })()`});
      await page.goto(base + '/?poll-draft#token=' + token);
      await page.waitFor(hasCard('Polling feature card'));
      await openCard('Polling feature card');
      await page.set('#ed-title', 'Unsent card draft');
      await page.eval(`document.querySelector('#editor').close()`);
      await page.click('#view-features');
      await page.click(`${cardSel(feature.id)} .card-title`);
      await page.set('#feature-title', 'Feature draft title');
      await page.set('#feature-description', 'Feature draft description');
      await page.eval(`document.querySelector('#feature-description').setSelectionRange(4, 4)`);
      cliJson('edit', card.id, '--notes', 'External card change');
      cliJson('feature-edit', feature.id, '--description', 'External feature change');
      await page.waitFor(`window.__lastBoard && window.__lastBoard.features.some(f => f.id === ${JSON.stringify(feature.id)} && f.description === 'External feature change')`);
      expect(await page.eval(`document.querySelector('#feature-title').value`)).toBe('Feature draft title');
      expect(await page.eval(`document.querySelector('#feature-description').value`)).toBe('Feature draft description');
      expect(await page.eval(`document.activeElement.id`)).toBe('feature-description');
      expect(await page.eval(`document.querySelector('#feature-description').selectionStart`)).toBe(4);
      await page.eval(`document.querySelector('#feature-editor').close()`);
      expect(await page.eval(`document.querySelector('#view-features').getAttribute('aria-pressed')`)).toBe('true');
      await page.click('#view-board');
      await page.eval(`[...document.querySelectorAll('#drafts-strip button')].find(b => b.textContent.includes('Unsent card draft')).click()`);
      expect(await page.eval(`document.querySelector('#ed-title').value`)).toBe('Unsent card draft');
      await page.click('#ed-cancel');
      await page.click('#cf-form button[value=ok]');
      await page.waitFor(`!document.querySelector('#editor').open`);
    } finally {
      await page.eval(`document.querySelectorAll('dialog[open]').forEach(d => d.close())`);
      rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('create card with feature and report feature field conflict', async () => {
    const first = cliJson('feature-create', 'Card feature one');
    const second = cliJson('feature-create', 'Card feature two');
    let cardId = '';
    try {
      await page.goto(base + '/?feature-conflict#token=' + token);
      await page.waitFor(hasCard('Seed card'));
      await page.click('#new-card');
      await page.type('#ed-title', 'Card with feature');
      await page.eval(`document.querySelector('#ed-feature').value = ${JSON.stringify(first.id)}; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      await page.click('#ed-save');
      await page.waitFor(`!document.querySelector('#editor').open`);
      cardId = byTitle('Card with feature').id;
      expect(cliJson('show', cardId).feature).toBe(first.id);
      await openCard('Card with feature');
      await page.eval(`document.querySelector('#ed-feature').value = ${JSON.stringify(second.id)}; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      cliJson('edit', cardId, '--clear-feature');
      await page.waitFor(`document.querySelector('#ed-form').textContent.includes('feature') && document.querySelector('#ed-form').textContent.includes('changed')`);
      expect(await page.eval(`document.querySelector('#ed-feature').value`)).toBe(second.id);
      expect(await page.eval(`document.querySelector('#ed-form').textContent`)).toContain('feature');
      await page.click('#ed-cancel');
      await page.click('#cf-form button[value=ok]');
      await page.waitFor(`!document.querySelector('#editor').open`);
    } finally {
      if (cardId) rmSync(join(root, '.agentboard/items', cardId + '.json'), {force:true});
      for (const feature of [first, second]) rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('feature progress follows CLI for empty, archived, mixed and live cards', async () => {
    const feature = cliJson('feature-create', 'Progress parity');
    const cards: Json[] = [];
    const assertProgress = async () => {
      const summary = cliJson('features', '--include-archived').features.find((f:Json) => f.id === feature.id);
      await page.waitFor(`document.querySelector(${JSON.stringify(cardSel(feature.id))})?.textContent.includes(${JSON.stringify('')} + ${summary.progress.done} + ' of ' + ${summary.progress.total} + ' cards done')`);
      const progress = await page.eval<Json>(`(() => { const p = document.querySelector(${JSON.stringify(cardSel(feature.id) + ' progress')}); return {max:p.max, value:p.value, label:p.getAttribute('aria-label'), duplicate:p.nextElementSibling.getAttribute('aria-hidden')}; })()`);
      expect(progress.max).toBe(Math.max(1, summary.progress.total));
      expect(progress.value).toBe(summary.progress.done);
      expect(progress.label).toBe(`${summary.progress.done} of ${summary.progress.total} cards done`);
      expect(progress.duplicate).toBe('true');
    };
    try {
      await page.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => { const original = fetch; window.fetch = async (...args) => { const response = await original(...args); if (String(args[0]).includes('api/board')) window.__lastBoard = await response.clone().json(); return response; }; })()`});
      await page.goto(base + '/?progress#token=' + token);
      await page.waitFor(hasCard('Seed card'));
      await page.click('#view-features');
      await assertProgress();
      cards.push(cliJson('create', 'Progress archived', '--feature', feature.id, '--status', 'done'));
      cliJson('edit', cards[0].id, '--archive');
      await page.waitFor(`window.__lastBoard?.items.some(i => i.id === ${JSON.stringify(cards[0].id)} && i.archived)`);
      await assertProgress();
      cards.push(cliJson('create', 'Progress todo', '--feature', feature.id));
      cards.push(cliJson('create', 'Progress done', '--feature', feature.id, '--status', 'done'));
      await assertProgress();
      cliJson('move', cards[1].id, 'done');
      await assertProgress();
      cliJson('feature-edit', feature.id, '--archive');
      await page.waitFor(`!document.querySelector(${JSON.stringify(cardSel(feature.id))})`);
      await page.click('#feature-archived');
      await assertProgress();
      await page.click('#feature-archived');
    } finally {
      for (const card of cards) rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
      await page.click('#view-board');
    }
  });

  test('feature links and progress follow the CLI', async () => {
    const feature = cliJson('feature-create', 'Browser feature');
    const card = cliJson('create', 'Feature browser card', '--feature', feature.id, '--status', 'done');
    await page.goto(url());
    await page.waitFor(hasCard('Feature browser card'));
    expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id))}).textContent.includes('Browser feature')`)).toBe(true);
    await page.click('#view-features');
    await page.waitFor(`document.querySelector(${JSON.stringify(cardSel(feature.id))})`);
    const summary = cliJson('features').features.find((f: Json) => f.id === feature.id);
    expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id))}).textContent`)).toContain(`${summary.progress.done} of ${summary.progress.total} cards done`);
    expect(cliJson('features').features.find((f: Json) => f.id === feature.id).status).toBe('done');
    await page.click('#view-board');
    await openCard('Feature browser card');
    await page.eval(`document.querySelector('#ed-feature').value = ''; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
    await page.click('#ed-save');
    await page.waitFor(`!document.querySelector('#editor').open`);
    expect(cliJson('show', card.id).feature).toBeNull();
    rmSync(join(root, '.agentboard/items', card.id + '.json'));
    rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
  });

  test('bridge restores an archived feature and links a card to it', async () => {
    const feature = cliJson('feature-create', 'Restore link');
    const card = cliJson('create', 'Restore link card');
    try {
      await page.goto(base + '/?restore-feature#token=' + token);
      await page.waitFor(hasCard('Restore link card'));
      await page.click('#view-features');
      await page.click(`${cardSel(feature.id)} .card-title`);
      await page.eval(`[...document.querySelectorAll('#feature-form button')].find(b => b.textContent === 'Archive').click()`);
      await page.waitFor(`!document.querySelector('#feature-editor').open && !document.querySelector(${JSON.stringify(cardSel(feature.id))})`);
      expect(cliJson('feature-show', feature.id).archived).toBe(true);
      await page.click('#feature-archived');
      await page.click(`${cardSel(feature.id)} .card-title`);
      await page.eval(`[...document.querySelectorAll('#feature-form button')].find(b => b.textContent === 'Restore').click()`);
      await page.waitFor(`!document.querySelector('#feature-editor').open`);
      expect(cliJson('feature-show', feature.id).archived).toBe(false);
      await page.click('#feature-archived');
      await page.click('#view-board');
      await openCard('Restore link card');
      await page.eval(`document.querySelector('#ed-feature').value = ${JSON.stringify(feature.id)}; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      await page.click('#ed-save');
      await page.waitFor(`!document.querySelector('#editor').open`);
      expect(cliJson('show', card.id).feature).toBe(feature.id);
    } finally {
      rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('feature editor creates, edits and archives without interpreting text', async () => {
    await page.goto(url());
    await page.waitFor(hasCard('Seed card'));
    await page.click('#view-features');
    await page.click('#new-feature');
    await page.type('#feature-title', '<img src=x onerror=alert(1)>');
    await page.type('#feature-description', '<script>bad()</script>');
    await page.click('#feature-form button[type=submit]');
    await page.waitFor(`!document.querySelector('#feature-editor').open`);
    const feature = cliJson('features').features.find((f: Json) => f.title === '<img src=x onerror=alert(1)>');
    expect(feature).toBeTruthy();
    expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id))}).querySelector('img')`)).toBeNull();
    await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id))} + ' .card-title').click()`);
    await page.set('#feature-title', 'Edited browser feature');
    await page.click('#feature-form button[type=submit]');
    await page.waitFor(`!document.querySelector('#feature-editor').open`);
    expect(cliJson('feature-show', feature.id).title).toBe('Edited browser feature');
    await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id))} + ' .card-title').click()`);
    await page.eval(`[...document.querySelectorAll('#feature-form button')].find(b => b.textContent === 'Archive').click()`);
    await page.waitFor(`!document.querySelector('#feature-editor').open`);
    expect(cliJson('feature-show', feature.id).archived).toBe(true);
    rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    await page.click('#view-board');
  });

  test('feature linking, progress, filters and unavailable links update the board', async () => {
    const feature = cliJson('feature-create', 'Link coverage');
    const card = cliJson('create', 'Link coverage card');
    try {
      await page.goto(url());
      await page.waitFor(hasCard('Link coverage card'));
      await openCard('Link coverage card');
      await page.eval(`document.querySelector('#ed-feature').value = ${JSON.stringify(feature.id)}; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      expect(await page.eval(`document.querySelector('#ed-save').disabled`)).toBe(false);
      await page.click('#ed-save');
      await page.waitFor(`!document.querySelector('#editor').open`);
      expect(cliJson('show', card.id).feature).toBe(feature.id);
      expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id))}).textContent`)).toContain('Link coverage');
      await page.click('#view-features');
      expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id))}).textContent`)).toContain('0 of 1 cards done');
      await shot('09-features-1400');
      await page.resize(390, 900);
      await shot('10-features-390');
      await page.resize(1400, 900);
      cliJson('move', card.id, 'done');
      await page.waitFor(`document.querySelector(${JSON.stringify(cardSel(feature.id))}).textContent.includes('1 of 1 cards done')`);
      expect(cliJson('features').features.find((f: Json) => f.id === feature.id).progress).toEqual({done:1, total:1});
      expect(cliJson('features').features.find((f: Json) => f.id === feature.id).status).toBe('done');
      await page.click('#view-board');
      await page.resize(390, 900);
      await shot('11-board-feature-chip-390');
      await page.resize(1400, 900);
      await page.eval(`document.querySelector('#f-feature').value = ${JSON.stringify(feature.id)}; document.querySelector('#f-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      expect(await page.eval(`document.querySelector('#summary').textContent`)).toContain('1 shown');
      await page.eval(`document.querySelector('#f-feature').value = 'none'; document.querySelector('#f-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      expect(await page.eval(hasCard('Link coverage card'))).toBe(false);
      await page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear filters').click()`);
      cliJson('feature-edit', feature.id, '--archive');
      await page.waitFor(`document.querySelector(${JSON.stringify(cardSel(card.id))}).textContent.includes('Feature unavailable')`);
      await page.resize(390, 900);
      await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id))}).scrollIntoView({block:'center'})`);
      await shot('11-board-feature-chip-390');
      await page.resize(1400, 900);
      await openCard('Link coverage card');
      expect(await page.eval(`document.querySelector('#ed-feature').selectedOptions[0].textContent`)).toContain('Unavailable feature');
      await page.eval(`document.querySelector('#ed-feature').value = ''; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      await page.click('#ed-save');
      await page.waitFor(`!document.querySelector('#editor').open`);
      expect(cliJson('show', card.id).feature).toBeNull();
    } finally {
      rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('feature editor busy guard shows a toast and preserves its draft', async () => {
    const first = cliJson('feature-create', 'Busy write');
    const second = cliJson('feature-create', 'Busy editor');
    let held = '';
    const off = chrome.on(m => { if (m.sessionId === page.sid && m.method === 'Fetch.requestPaused') held = m.params.requestId; });
    try {
      await page.goto(base + '/?busy-feature#token=' + token);
      await page.waitFor(hasCard('Seed card'));
      await page.click('#view-features');
      await page.send('Fetch.enable', {patterns:[{urlPattern:'*/api/features/' + first.id, requestStage:'Request'}]});
      await page.eval(`document.querySelector(${JSON.stringify(cardSel(first.id) + ' select')}).value = 'active'; document.querySelector(${JSON.stringify(cardSel(first.id) + ' select')}).dispatchEvent(new Event('change', {bubbles:true}))`);
      const deadline = Date.now() + 5000;
      while (!held && Date.now() < deadline) await Bun.sleep(25);
      expect(held).not.toBe('');
      await page.click(`${cardSel(second.id)} .card-title`);
      await page.set('#feature-title', 'Busy draft');
      await page.eval(`document.querySelector('#feature-form').requestSubmit()`);
      await page.waitFor(`document.querySelector('#toasts').textContent.includes('save is in progress')`);
      expect(await page.eval(`getComputedStyle(document.querySelector('#feature-form [role=alert]')).display`)).toBe('none');
      expect(await page.eval(`document.querySelector('#feature-title').value`)).toBe('Busy draft');
      await page.eval(`document.querySelector('#feature-editor').close()`);
    } finally {
      if (held) await page.send('Fetch.continueRequest', {requestId:held});
      await page.send('Fetch.disable');
      off();
      await page.waitFor(`document.querySelector('#board').getAttribute('aria-busy') !== 'true'`);
      for (const f of [first, second]) rmSync(join(root, '.agentboard/features', f.id + '.json'), {force:true});
    }
  });

  test('feature editor reports ordinary write errors without a conflict banner', async () => {
    const feature = cliJson('feature-create', 'Permission feature');
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => { const original = fetch; window.fetch = (...args) => String(args[0]).includes('api/features/') && args[1]?.method === 'PATCH' ? Promise.resolve(new Response(JSON.stringify({error:{kind:'forbidden', message:'Permission denied'}}), {status:403, headers:{'Content-Type':'application/json'}})) : original(...args); })()`});
      await p.goto(url());
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      await p.click('#view-features');
      await p.click(`${cardSel(feature.id)} .card-title`);
      await p.set('#feature-title', 'Draft after denial');
      await p.click('#feature-form button[type=submit]');
      await p.waitFor(`document.querySelector('#feature-form [role=alert]').textContent.includes('Could not save feature')`);
      expect(await p.eval(`document.querySelector('#feature-form [role=alert]').textContent`)).not.toContain('Feature changed');
      expect(await p.eval(`document.querySelector('#feature-title').value`)).toBe('Draft after denial');
    } finally {
      await p.send('Page.close');
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('feature editor keeps a stale draft and offers a reload', async () => {
    const feature = cliJson('feature-create', 'Stale feature');
    try {
      await page.goto(url());
      await page.waitFor(hasCard('Seed card'));
      await page.click('#view-features');
      await page.click(`${cardSel(feature.id)} .card-title`);
      expect(await page.eval(`getComputedStyle(document.querySelector('#feature-form [role=alert]')).display`)).toBe('none');
      await shot('12-feature-editor');
      await page.set('#feature-title', 'Feature draft');
      await page.send('Fetch.enable', {patterns:[{urlPattern:'*/api/board', requestStage:'Request'}]});
      try {
        cliJson('feature-edit', feature.id, '--description', 'External');
        await page.click('#feature-form button[type=submit]');
      } finally {
        await page.send('Fetch.disable');
      }
      await page.waitFor(`document.querySelector('#feature-form [role=alert]').textContent.includes('draft is kept')`);
      expect(await page.eval(`document.querySelector('#feature-title').value`)).toBe('Feature draft');
      expect(await page.eval(`document.querySelector('#feature-form button[type=submit]').disabled`)).toBe(false);
      await page.eval(`[...document.querySelectorAll('#feature-form button')].find(b => b.textContent === 'Reload current feature').click()`);
      expect(await page.eval(`document.querySelector('#feature-description').value`)).toBe('External');
      await page.eval(`document.querySelector('#feature-editor').close()`);
    } finally {
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('feature columns create with their status and controls recover after moving', async () => {
    await page.goto(url());
    await page.click('#view-board');
    await page.waitFor(hasCard('Seed card'));
    await page.click('#view-features');
    await page.click('[aria-label="Add feature to Active"]');
    expect(await page.eval(`document.querySelector('#feature-status').value`)).toBe('active');
    await page.type('#feature-title', 'Column feature');
    await page.click('#feature-form button[type=submit]');
    await page.waitFor(`!document.querySelector('#feature-editor').open`);
    const feature = cliJson('features').features.find((f: Json) => f.title === 'Column feature');
    try {
      expect(feature.status).toBe('active');
      await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).value = 'done'; document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).dispatchEvent(new Event('change', {bubbles:true}))`);
      await page.waitFor(`document.querySelector(${JSON.stringify(cardSel(feature.id))}).closest('.col').dataset.col === 'done' && !document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).disabled`);
      expect(cliJson('feature-show', feature.id).status).toBe('done');
      expect(await page.eval(`document.querySelector('#new-feature').disabled`)).toBe(false);
    } finally {
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
      await page.click('#view-board');
    }
  });

  test('feature controls and dialogs have names, fit and restore focus at each width', async () => {
    const feature = cliJson('feature-create', 'Layout feature');
    const card = cliJson('create', 'Layout linked card', '--feature', feature.id);
    const assertControls = async (selector: string) => {
      const result = await page.eval<Json>(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.getClientRects().length).map(e => {
        const r = e.getBoundingClientRect();
        const name = e.getAttribute('aria-label') || [...(e.labels || [])].map(l => l.textContent.trim()).join(' ') || e.textContent.trim() || e.title;
        return {name, inside:r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight};
      })`);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((x:Json) => x.name && x.inside)).toBe(true);
    };
    try {
      await page.goto(base + '/?feature-matrix#token=' + token);
      await page.waitFor(hasCard('Layout linked card'));
      for (const width of [1400, 1200, 1024, 390]) {
        await page.resize(width, 900);
        await page.eval(`window.scrollTo(0, 0); document.querySelector('#board').scrollLeft = 0`);
        await assertControls('#view-board, #view-features, #f-feature');
        const chip = await page.eval<Json>(`(() => { const e = document.querySelector(${JSON.stringify(cardSel(card.id) + ' .label')}); const r = e.getBoundingClientRect(); const c = e.closest('.card').getBoundingClientRect(); return {text:e.textContent, inside:r.left >= c.left && r.right <= c.right}; })()`);
        expect(chip).toEqual({text:'Layout feature', inside:true});
        if (width === 390) expect(await page.eval(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
        await page.click('#view-features');
        await assertControls('#view-board, #view-features, #new-feature, #feature-archived');
        if (width === 390) expect(await page.eval(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
        await page.click('#new-feature');
        await assertControls('#feature-form input, #feature-form textarea, #feature-form select, #feature-form button');
        await page.eval(`[...document.querySelectorAll('#feature-form button')].find(b => b.textContent === 'Close').click()`);
        await page.waitFor(`document.activeElement.id === 'new-feature'`);
        await page.click(`${cardSel(feature.id)} .card-title`);
        await assertControls('#feature-form input, #feature-form textarea, #feature-form select, #feature-form button');
        expect(await page.eval(`getComputedStyle(document.querySelector('#feature-form ul')).listStyleType`)).toBe('none');
        expect(await page.eval(`document.querySelector('#feature-form ul').textContent`)).toContain('Layout linked card');
        await page.eval(`[...document.querySelectorAll('#feature-form button')].find(b => b.textContent === 'Close').click()`);
        await page.waitFor(`document.activeElement === document.querySelector(${JSON.stringify(cardSel(feature.id) + ' .card-title')})`);
        await page.click('#view-board');
      }
    } finally {
      await page.resize(1400, 900);
      rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
    }
  });

  test('feature controls fit and restore focus across polls, moves and dialogs', async () => {
    const feature = cliJson('feature-create', 'Accessible feature');
    try {
      await page.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => { const original = fetch; window.fetch = async (...args) => { const response = await original(...args); if (String(args[0]).includes('api/board')) window.__lastBoard = await response.clone().json(); return response; }; })()`});
      await page.goto(base + '/?feature-layout#token=' + token);
      await page.waitFor(hasCard('Seed card'));
      await page.click('#view-features');
      for (const width of [1400, 1200, 1024, 390]) {
        await page.resize(width, 900);
        expect(await page.eval(`(() => { const card = document.querySelector(${JSON.stringify(cardSel(feature.id))}); const box = card.getBoundingClientRect(); return [...card.querySelectorAll('button,select,progress')].every(el => { const r = el.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right && r.bottom <= box.bottom; }); })()`)).toBe(true);
        expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).getAttribute('aria-label')`)).toContain('Accessible feature');
        if (width === 390) expect(await page.eval(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
      }
      await page.focus(`${cardSel(feature.id)} .card-title`);
      cliJson('feature-edit', feature.id, '--description', 'Poll change');
      await page.waitFor(`window.__lastBoard?.features.some(f => f.id === ${JSON.stringify(feature.id)} && f.description === 'Poll change')`);
      await page.waitFor(`document.querySelector(${JSON.stringify(cardSel(feature.id) + ' .card-title')}) === document.activeElement`);
      await page.click(`${cardSel(feature.id)} .card-title`);
      await page.eval(`[...document.querySelectorAll('#feature-form button')].find(b => b.textContent === 'Close').click()`);
      await page.waitFor(`document.activeElement === document.querySelector(${JSON.stringify(cardSel(feature.id) + ' .card-title')})`);
      await page.focus(`${cardSel(feature.id)} select`);
      await page.eval(`document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).value = 'active'; document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')}).dispatchEvent(new Event('change', {bubbles:true}))`);
      await page.waitFor(`${colOf('Accessible feature')} === 'active'`);
      await page.waitFor(`document.activeElement === document.querySelector(${JSON.stringify(cardSel(feature.id) + ' select')})`);
    } finally {
      await page.resize(1400, 900);
      rmSync(join(root, '.agentboard/features', feature.id + '.json'), {force:true});
      await page.click('#view-board');
    }
  });

  test('feature view renders 2000 features and linked cards within two seconds', async () => {
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => {
        const original = fetch;
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (!String(args[0]).includes('api/board')) return response;
          const data = await response.json();
          const seed = data.items[0];
          data.items = []; data.features = [];
          for (let i = 0; i < 2000; i++) {
            const suffix = i.toString(16).toUpperCase().padStart(12, '0');
            const id = 'FT-' + suffix;
            data.features.push({version:'1.0.0', id, revision:1, title:'Feature ' + i, status:'planned', description:'', createdAt:seed.createdAt, updatedAt:seed.updatedAt, archived:false});
            data.items.push({...seed, id:'AB-' + suffix, feature:id});
          }
          return new Response(JSON.stringify(data), {status:response.status, headers:response.headers});
        };
      })()`});
      await p.goto(url());
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      const elapsed = await p.eval<number>(`(() => { const start = performance.now(); document.querySelector('#view-features').click(); return performance.now() - start; })()`);
      expect(await p.eval(`document.querySelectorAll('.card[data-id^="FT-"]').length`)).toBe(2000);
      expect(elapsed).toBeLessThan(2000);
    } finally { await p.send('Page.close'); }
  });

  test('malformed feature columns show a specific load error', async () => {
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => { const original = fetch; window.fetch = async (...args) => { const response = await original(...args); if (!String(args[0]).includes('api/board')) return response; const data = await response.json(); data.config.featureColumns = [null]; return new Response(JSON.stringify(data), {status:response.status, headers:response.headers}); }; })()`});
      await p.goto(url());
      await p.waitFor(`document.body.textContent.includes('Invalid feature columns')`);
      expect(await p.eval(`document.querySelector('#conn').dataset.state`)).toBe('error');
    } finally { await p.send('Page.close'); }
  });

  test('malformed features from the bridge produce a load error', async () => {
    const p = await chrome.newPage();
    await p.send('Page.addScriptToEvaluateOnNewDocument', {source: `(() => {
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (!String(args[0]).includes('api/board')) return response;
        const data = await response.json();
        data.features = [{id:'invalid'}];
        return new Response(JSON.stringify(data), {status:response.status, headers:response.headers});
      };
    })()`});
    await p.goto(url());
    await p.waitFor(`document.body.textContent.includes('Invalid feature structure or version')`);
    expect(await p.eval(`document.querySelector('#conn').dataset.state`)).toBe('error');
    await p.send('Page.close');
  });

  test('card actions fit at common viewport widths', async () => {
    await page.goto(url());
    await page.waitFor(hasCard('Seed card'));
    try {
      for (const width of [1400, 1200, 1024, 390]) {
        await page.resize(width, 900);
        expect(await page.eval(` [...document.querySelectorAll('.card')].every(card => {
          const box = card.getBoundingClientRect();
          return [...card.querySelectorAll('.move, .assignee, .card-actions button')].every(control => {
            const r = control.getBoundingClientRect();
            return r.left >= box.left - 1 && r.right <= box.right + 1;
          });
        })`)).toBe(true);
        if (width === 1400) expect(await page.eval(`document.querySelector('#board').scrollWidth <= document.querySelector('#board').clientWidth`)).toBe(true);
        if (width === 1024) {
          // HEAD also overflows: absolutely positioned screen-reader text escapes the scrolling board.
          expect(await page.eval(`(() => {
            const board = document.querySelector('#board');
            const before = document.documentElement.scrollWidth;
            board.style.position = 'relative';
            const after = document.documentElement.scrollWidth;
            board.style.position = '';
            return before > innerWidth && after <= innerWidth;
          })()`)).toBe(true);
        }
      }
    } finally {
      await page.resize(1400, 900);
    }
  });

  test('thread draft status reflects unsent content', async () => {
    await page.goto(url());
    await page.waitFor(hasCard('Seed card'));
    cliJson('create', 'Draft status probe');
    await page.waitFor(hasCard('Draft status probe'));
    await openCard('Draft status probe');
    const dirty = () => page.eval<boolean>(`(() => { const e = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; })()`);
    await page.set('#thread-author', 'Alice');
    await page.set('#thread-body', 'Posted message');
    await page.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post comment').click()`);
    await page.waitFor(`document.querySelector('#thread-list').textContent.includes('Posted message') && !document.querySelector('#thread-body').value`);
    expect(await dirty()).toBe(false);
    expect(await page.eval(`document.querySelector('#ed-cancel').textContent`)).toBe('Cancel');
    await page.eval(`document.querySelector('#thread-list button').click()`);
    expect(await dirty()).toBe(false);
    await page.set('#thread-list textarea', 'Edited message');
    expect(await dirty()).toBe(true);
    expect(await page.eval(`document.querySelector('#ed-cancel').textContent`)).toBe('Discard draft');
    await page.set('#thread-list textarea', 'Posted message');
    await page.set('#thread-body', 'Unsent');
    expect(await dirty()).toBe(true);
    await page.click('#ed-cancel');
    await page.waitFor(`document.querySelector('#confirm').open`);
    await page.click('#cf-form button[value=ok]');
    await page.waitFor(`!document.querySelector('#editor').open`);
    await openCard('Draft status probe');
    expect(await page.eval(`document.querySelector('#thread-body').value`)).toBe('');
    expect(await page.eval(`document.querySelector('#thread-author').value`)).toBe('');
    expect(await dirty()).toBe(false);
    await page.click('#ed-close');
  });

  test('late thread response does not change another editor metadata', async () => {
    await page.goto(url());
    const first = cliJson('create', 'Late response first');
    const second = cliJson('create', 'Late response second');
    await page.waitFor(hasCard('Late response second'));
    await openCard('Late response first');
    await page.set('#thread-body', 'Delayed comment');
    let held = '';
    const off = chrome.on(message => {
      if (message.sessionId === page.sid && message.method === 'Fetch.requestPaused') held = message.params.requestId;
    });
    await page.send('Fetch.enable', {patterns: [{urlPattern: `*/api/items/${first.id}/thread`, requestStage: 'Response'}]});
    try {
      await page.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post comment').click()`);
      const deadline = Date.now() + 8000;
      while (!held && Date.now() < deadline) await Bun.sleep(25);
      expect(held).not.toBe('');
      await page.click('#ed-close');
      await openCard('Late response second');
      const before = await page.eval(`document.querySelector('.meta-list').textContent`);
      await page.send('Fetch.continueRequest', {requestId: held});
      held = '';
      await page.waitFor(`!document.querySelector('#ed-save').disabled || document.querySelector('#ed-save').textContent !== 'Saving…'`);
      await page.waitFor(`document.querySelector('#ed-heading').textContent.includes(${JSON.stringify(second.id)})`);
      expect(await page.eval(`document.querySelector('.meta-list').textContent`)).toBe(before);
    } finally {
      if (held) await page.send('Fetch.continueRequest', {requestId: held});
      off();
      await page.send('Fetch.disable');
      if (await page.eval(`document.querySelector('#editor').open`)) await page.click('#ed-close');
    }
  });

  test('malformed bridge thread shows a load error', async () => {
    const snapshot = await (await fetch(base + '/api/board', {headers:{Authorization:'Bearer ' + token}})).json() as Json;
    snapshot.items[0].thread = [null];
    const body = Buffer.from(JSON.stringify(snapshot)).toString('base64');
    const off = chrome.on(message => {
      if (message.sessionId === page.sid && message.method === 'Fetch.requestPaused') {
        page.send('Fetch.fulfillRequest', {requestId:message.params.requestId, responseCode:200, responseHeaders:[{name:'Content-Type', value:'application/json'}], body}).catch(() => {});
      }
    });
    await page.send('Fetch.enable', {patterns:[{urlPattern:'*/api/board', requestStage:'Request'}]});
    try {
      await page.goto(base + '/?malformed=1#token=' + token);
      await page.waitFor(`document.body.innerText.includes('Cannot load the board')`);
      expect(await page.eval(`document.querySelectorAll('.card').length`)).toBe(0);
    } finally {
      await page.send('Fetch.disable');
      off();
      await page.goto(url());
      await page.waitFor(hasCard('Seed card'));
    }
  });

  test('thread posts, answers, edits and preserves a card draft', async () => {
    const card = cliJson('create', 'Thread test');
    await page.waitFor(hasCard('Thread test'));
    await openCard('Thread test');
    await page.set('#ed-title', 'Thread draft');
    await page.set('#thread-author', '<img src=x onerror=alert(1)>');
    await page.set('#thread-body', '<img src=x onerror=alert(2)>');
    await page.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post question').click()`);
    await page.waitFor(`document.querySelector('#thread-list').textContent.includes('open')`);
    await page.waitFor(`!document.querySelector('#board').getAttribute('aria-busy').includes('true')`);
    expect(await page.eval(`[...document.querySelectorAll('.move,.card .assignee,.card-actions button')].every(el => !el.disabled)`)).toBe(true);
    expect(await page.eval(`document.querySelector('#ed-title').value`)).toBe('Thread draft');
    expect(await page.eval(`document.querySelector('#thread-list img')`)).toBeNull();
    let thread = cliJson('thread', card.id);
    expect(thread[0].body).toBe('<img src=x onerror=alert(2)>');
    expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id))}).textContent.includes('❔ 1')`)).toBe(true);
    expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id))}).querySelector('.badge').getAttribute('aria-label')`)).toBe('1 open question');
    await page.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Answer').click()`);
    await page.set('#thread-list textarea', 'An answer');
    await page.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Post answer').click()`);
    await page.waitFor(`document.querySelector('#thread-list').textContent.includes('answered')`);
    await page.waitFor(`document.querySelector('#board').getAttribute('aria-busy') === 'false'`);
    expect(await page.eval(`[...document.querySelectorAll('.move,.card .assignee,.card-actions button')].every(el => !el.disabled)`)).toBe(true);
    thread = cliJson('thread', card.id);
    expect(thread[1].replyTo).toBe(thread[0].id);
    expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id))}).textContent.includes('❔')`)).toBe(false);
    await page.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Edit').click()`);
    await page.set('#thread-list textarea', 'Edited question');
    await page.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Save entry').click()`);
    await page.waitFor(`document.querySelector('#thread-list').textContent.includes('Edited question')`);
    await page.waitFor(`document.querySelector('#board').getAttribute('aria-busy') === 'false'`);
    expect(await page.eval(`[...document.querySelectorAll('.move,.card .assignee,.card-actions button')].every(el => !el.disabled)`)).toBe(true);
    expect(cliJson('thread', card.id)[0].body).toBe('Edited question');
    expect(await page.eval(`[...document.querySelectorAll('#thread-panel button')].some(b => /delete/i.test(b.textContent))`)).toBe(false);
    await page.set('#thread-author', '');
    await page.click('#ed-save');
    await page.waitFor(`!document.querySelector('#editor').open`);
    expect(byTitle('Thread draft').id).toBe(card.id);
    rmSync(join(root, '.agentboard/items', card.id + '.json'));
    await page.waitFor(`!(${hasCard('Thread draft')})`);
  });

  test('polling updates thread while retaining text, focus and caret', async () => {
    const card = cliJson('create', 'Live thread');
    await page.waitFor(hasCard('Live thread')); await openCard('Live thread');
    await page.set('#thread-body', 'typing here');
    await page.eval(`document.querySelector('#thread-body').setSelectionRange(3, 3)`);
    cliJson('edit', card.id, '--title', 'Live thread renamed');
    await page.waitFor(`document.querySelector('#ed-title').value === 'Live thread renamed'`, 8000);
    expect(await page.eval(`(() => { const t = document.querySelector('#thread-body'); return [t.value, document.activeElement === t, t.selectionStart, t.selectionEnd]; })()`)).toEqual(['typing here', true, 3, 3]);
    cliJson('ask', card.id, 'Live question');
    await page.waitFor(`document.querySelector('#thread-list').textContent.includes('Live question')`, 8000);
    expect(await page.eval(`(() => { const t = document.querySelector('#thread-body'); return [t.value, document.activeElement === t, t.selectionStart, t.selectionEnd]; })()`)).toEqual(['typing here', true, 3, 3]);
    await page.set('#thread-body', '');
    await page.click('#ed-close'); await page.waitFor(`!document.querySelector('#editor').open`);
  });

  test('open answer and author survive polling and another post', async () => {
    const card = cliJson('create', 'Open answer retention');
    cliJson('ask', card.id, 'First question');
    try {
      await page.waitFor(hasCard('Open answer retention'));
      await openCard('Open answer retention');
      await page.set('#thread-author', 'Alice');
      await page.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Answer').click()`);
      await page.eval(`document.querySelector('#thread-list textarea').focus()`);
      cliJson('ask', card.id, 'Second question');
      await page.waitFor(`document.querySelector('#thread-list').textContent.includes('Second question')`, 8000);
      expect(await page.eval(`document.activeElement === document.querySelector('#thread-list textarea')`)).toBe(true);
      expect(await page.eval(`document.querySelector('#thread-author').value`)).toBe('Alice');
      expect(await page.eval(`document.querySelector('#thread-list textarea').value`)).toBe('');
      expect(await page.eval(`document.querySelector('#thread-body').getAttribute('aria-label')`)).toBeTruthy();
      expect(await page.eval(`document.querySelector('#thread-list textarea').getAttribute('aria-label')`)).toBeTruthy();
      expect(await page.eval(`document.querySelector(${JSON.stringify(cardSel(card.id))}).querySelector('.badge').getAttribute('aria-label')`)).toBe('2 open questions');
      await page.set('#thread-body', 'A separate comment');
      await page.eval(`document.querySelector('#thread-list textarea').focus()`);
      await page.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post comment').click()`);
      await page.waitFor(`document.querySelector('#thread-list').textContent.includes('A separate comment')`);
      expect(await page.eval(`document.activeElement === document.querySelector('#thread-list textarea')`)).toBe(true);
      expect(await page.eval(`document.querySelector('#thread-author').value`)).toBe('Alice');
    } finally {
      if (await page.eval(`document.querySelector('#editor').open`)) {
        await page.click('#ed-cancel');
        if (await page.eval(`document.querySelector('#confirm').open`)) await page.click('#cf-form button[value=ok]');
        await page.waitFor(`!document.querySelector('#editor').open`);
      }
      rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
      await page.goto(url());
      await page.waitFor(hasCard('Seed card'));
    }
  });

  test('unsent thread text survives closing the editor', async () => {
    const card = cliJson('create', 'Thread draft retained');
    try {
      await page.waitFor(hasCard('Thread draft retained'));
      await openCard('Thread draft retained');
      await page.set('#thread-author', 'Alice');
      await page.set('#thread-body', 'Unsent message');
      await page.click('#ed-close');
      await page.waitFor(`document.querySelector('#drafts-strip').textContent.includes('Thread draft retained')`);
      await openCard('Thread draft retained');
      expect(await page.eval(`document.querySelector('#thread-author').value`)).toBe('Alice');
      expect(await page.eval(`document.querySelector('#thread-body').value`)).toBe('Unsent message');
    } finally {
      if (await page.eval(`document.querySelector('#editor').open`)) {
        await page.click('#ed-cancel');
        if (await page.eval(`document.querySelector('#confirm').open`)) await page.click('#cf-form button[value=ok]');
        await page.waitFor(`!document.querySelector('#editor').open`);
      }
      rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
      await page.goto(url());
      await page.waitFor(hasCard('Seed card'));
    }
  });

  test('thread posts rebase field drafts only over thread changes', async () => {
    for (const externalTitle of [false, true]) {
      const title = externalTitle ? 'External field' : 'External thread';
      const card = cliJson('create', title);
      try {
        await page.waitFor(hasCard(title));
        await openCard(title);
        await page.set('#ed-title', title + ' draft');
        if (externalTitle) cliJson('edit', card.id, '--title', title + ' changed');
        else cliJson('ask', card.id, 'External question');
        await page.waitFor(`document.querySelector('#conflict-banner')`, 8000);
        await page.set('#thread-body', 'Independent comment');
        await page.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post comment').click()`);
        await page.waitFor(`document.querySelector('#thread-list').textContent.includes('Independent comment')`);
        expect(await page.eval(`document.querySelector('#ed-title').value`)).toBe(title + ' draft');
        if (externalTitle) {
          expect(await page.eval(`!!document.querySelector('#conflict-banner')`)).toBe(true);
          expect(cliJson('show', card.id).title).toBe(title + ' changed');
        } else {
          await page.waitFor(`!document.querySelector('#ed-save').disabled`);
          await page.click('#ed-save');
          await page.waitFor(`!document.querySelector('#editor').open`);
          expect(cliJson('show', card.id).title).toBe(title + ' draft');
        }
      } finally {
        if (await page.eval(`document.querySelector('#editor').open`)) {
          await page.click('#ed-cancel');
          if (await page.eval(`document.querySelector('#confirm').open`)) await page.click('#cf-form button[value=ok]');
          await page.waitFor(`!document.querySelector('#editor').open`);
        }
        rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
        await page.goto(url());
        await page.waitFor(hasCard('Seed card'));
      }
    }
  });

  test('stale thread post keeps text and succeeds on retry', async () => {
    const card = cliJson('create', 'Stale thread');
    await page.waitFor(hasCard('Stale thread')); await openCard('Stale thread');
    await page.set('#thread-body', 'Kept comment');
    await page.send('Fetch.enable', {patterns: [{urlPattern: '*/api/board', requestStage: 'Request'}]});
    try {
      cliJson('edit', card.id, '--description', 'External');
      await page.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post comment').click()`);
      await page.waitFor(`document.querySelector('#thread-panel .err').textContent.includes('changed')`);
    } finally {
      await page.send('Fetch.disable');
    }
    await page.waitFor(`document.querySelector('#thread-panel .err').textContent.includes('kept')`);
    expect(await page.eval(`document.querySelector('#thread-body').value`)).toBe('Kept comment');
    await page.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post comment').click()`);
    await page.waitFor(`document.querySelector('#thread-list').textContent.includes('Kept comment')`);
    expect(cliJson('thread', card.id).map((e: Json) => e.body)).toEqual(['Kept comment']);
    await page.click('#ed-close'); await page.waitFor(`!document.querySelector('#editor').open`);
  });

  test('archived card shows question error but allows a comment', async () => {
    const card = cliJson('create', 'Archived UI'); cliJson('edit', card.id, '--archive');
    try {
      await page.eval(`(() => { const s = document.querySelector('#f-archived'); s.value = 'show'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      await page.waitFor(hasCard('Archived UI')); await openCard('Archived UI');
      await page.set('#thread-body', 'Question');
      await page.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post question').click()`);
      await page.waitFor(`document.querySelector('#thread-panel .err').textContent.includes('Unarchive')`);
      expect(cliJson('thread', card.id)).toEqual([]);
      await page.set('#thread-body', 'Allowed comment');
      await page.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post comment').click()`);
      await page.waitFor(`document.querySelector('#thread-list').textContent.includes('Allowed comment')`);
      expect(cliJson('thread', card.id)).toHaveLength(1);
      await page.click('#ed-close'); await page.waitFor(`!document.querySelector('#editor').open`);
    } finally {
      await page.eval(`(() => { if (document.querySelector('#editor').open) document.querySelector('#editor').close(); const s = document.querySelector('#f-archived'); s.value = 'hide'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      rmSync(join(root, '.agentboard/items', card.id + '.json'), {force:true});
    }
  });

  test('archived cards reject questions through CLI and bridge', async () => {
    const card = cliJson('create', 'Archived question');
    cliJson('edit', card.id, '--archive');
    const result = cli('ask', card.id, 'Hidden question');
    expect(result.code).toBe(1);
    expect(result.err.toLowerCase()).toContain('unarchive');
    const snapshot = await (await fetch(base + '/api/board', {headers:{Authorization:'Bearer ' + token}})).json() as Json;
    const current = snapshot.items.find((x: Json) => x.id === card.id);
    const response = await fetch(base + '/api/items/' + card.id + '/thread', {method:'POST', headers:{Authorization:'Bearer ' + token, 'Content-Type':'application/json'}, body:JSON.stringify({revision:current.revision, hash:snapshot.hashes[card.id], entry:{kind:'question', body:'Hidden question'}})});
    expect(response.status).toBe(400);
    expect((await response.json() as Json).code).toBe('invalid');
    rmSync(join(root, '.agentboard/items', card.id + '.json'));
  });

  test('create a card in the UI (POST), then it appears in the CLI list', async () => {
    await page.click('#new-card');
    await page.waitFor(`document.querySelector('#editor').open`);
    expect(await page.eval(`document.activeElement.id`)).toBe('ed-title');   // focus moves into the dialog
    await page.type('#ed-title', 'Created in UI');
    await page.set('#ed-assignee', 'ui-user');
    await page.type('#ed-labels', 'alpha');  await page.key('Enter');
    await page.type('#ed-labels', 'beta,');
    await page.type('#ed-crit-new', 'Does the thing'); await page.key('Enter');
    await page.type('#ed-description', 'Line one\n<b>not bold</b>');
    await page.click('#ed-save');
    await page.waitFor(`!document.querySelector('#editor').open`);
    await page.waitFor(hasCard('Created in UI'));
    const x = byTitle('Created in UI');
    expect(x.assignee).toBe('ui-user'); expect(x.labels).toEqual(['alpha', 'beta']); expect(x.acceptanceCriteria).toEqual([{text: 'Does the thing', done: false}]);
    expect(x.status).toBe('backlog'); expect(x.priority).toBe('medium'); expect(x.description).toBe('Line one\n<b>not bold</b>');
    // focus returns to the new card
    expect(await page.eval(`document.activeElement.dataset.fk`)).toBe(x.id + ':title');
  });

  test('edit every writable field in the UI; unchanged fields are preserved', async () => {
    const before = byTitle('Created in UI');
    await openCard('Created in UI');
    await page.set('#ed-title', 'Edited in UI');
    await page.eval(`(() => { const s = document.querySelector('#ed-status'); s.value = 'in-progress'; s.dispatchEvent(new Event('change', {bubbles: true})); const p = document.querySelector('#ed-priority'); p.value = 'urgent'; p.dispatchEvent(new Event('change', {bubbles: true})); })()`);
    await page.set('#ed-assignee', 'agent-7');
    await page.click('#ed-label-list li:first-child button');            // remove "alpha"
    await page.click('#ed-crit-list .crit-row input[type=checkbox]');    // toggle done
    await page.set('#ed-notes', 'some notes');
    await page.click('#ed-save');
    await page.waitFor(`!document.querySelector('#editor').open`);
    await page.waitFor(`${colOf('Edited in UI')} === 'in-progress'`);
    const x = byTitle('Edited in UI');
    expect(x.revision).toBe(before.revision + 1);
    expect(x.priority).toBe('urgent'); expect(x.assignee).toBe('agent-7'); expect(x.labels).toEqual(['beta']);
    expect(x.acceptanceCriteria).toEqual([{text: 'Does the thing', done: true}]); expect(x.notes).toBe('some notes');
    expect(x.description).toBe(before.description);            // untouched field preserved
    expect(x.createdAt).toBe(before.createdAt);
  });

  test('card text is never interpreted as HTML (XSS probes)', async () => {
    cliJson('create', '<img src=x onerror="window.__xss=1">', '--label', '<script>window.__xss=2</script>', '--description', '<svg onload="window.__xss=3">');
    await page.waitFor(hasCard('<img src=x onerror="window.__xss=1">'));
    await openCard('<img src=x onerror="window.__xss=1">');
    expect(await page.eval(`window.__xss`)).toBeUndefined();
    expect(await page.eval(`document.querySelectorAll('.card img, .card script, #editor img, #editor svg').length`)).toBe(0);
    expect(await page.eval(`document.querySelector('#ed-description').value`)).toBe('<svg onload="window.__xss=3">');
    await page.click('#ed-cancel');
    await page.waitFor(`!document.querySelector('#editor').open`);
  });

  test('CLI create, move and edit appear without a manual refresh', async () => {
    cliJson('create', 'From CLI', '--status', 'todo');
    await page.waitFor(`${colOf('From CLI')} === 'todo'`, 6000);
    const id = byTitle('From CLI').id;
    cliJson('move', id, 'blocked');
    await page.waitFor(`${colOf('From CLI')} === 'blocked'`, 6000);
    cliJson('edit', id, '--title', 'From CLI (edited)', '--priority', 'low');
    await page.waitFor(hasCard('From CLI (edited)'), 6000);
  });

  test('an external edit that does NOT bump the revision is detected via the hash', async () => {
    const x = byTitle('From CLI (edited)');
    const p = join(root, '.agentboard', 'items', x.id + '.json');
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    raw.title = 'Hand edited, same revision';             // revision untouched
    writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
    expect(raw.revision).toBe(x.revision);
    await page.waitFor(hasCard('Hand edited, same revision'), 6000);
  });

  test('conflict while editing: banner, whole draft kept, save disabled, copy access, confirmed reload', async () => {
    const x = byTitle('Seed card');
    await openCard('Seed card');
    await page.set('#ed-title', 'My draft title');
    await page.set('#ed-notes', 'my draft notes that must survive');
    await page.type('#ed-labels', 'draft-label'); await page.key('Enter');
    cliJson('edit', x.id, '--notes', 'changed by the CLI meanwhile');
    await page.waitFor(`!!document.querySelector('#conflict-banner')`, 6000, 'conflict banner');
    expect(await page.eval(`document.querySelector('#conflict-banner').innerText`)).toContain('does not merge');
    expect(await page.eval(`document.querySelector('#ed-title').value`)).toBe('My draft title');
    expect(await page.eval(`document.querySelector('#ed-notes').value`)).toBe('my draft notes that must survive');
    expect(await page.eval(`document.querySelector('#ed-save').disabled`)).toBe(true);
    const draft = JSON.parse(await page.eval(`document.querySelector('#draft-text').value`));
    expect(draft.draft.title).toBe('My draft title'); expect(draft.draft.notes).toBe('my draft notes that must survive'); expect(draft.draft.labels).toContain('draft-label');
    await shot('03-conflict');
    // keep editing keeps everything and keeps saving disabled
    await page.click('#cf-keep');
    expect(await page.eval(`document.querySelector('#ed-title').value`)).toBe('My draft title');
    expect(await page.eval(`document.querySelector('#ed-save').disabled`)).toBe(true);
    // closing keeps the draft: reopening restores it
    await page.click('#ed-close');
    await page.waitFor(`!document.querySelector('#editor').open`);
    await page.waitFor(`document.querySelector('#drafts-strip').innerText.includes('conflict')`, 3000, 'draft chip with conflict marker');
    await page.click('#drafts-strip button');
    await page.waitFor(`document.querySelector('#editor').open && document.querySelector('#ed-title').value === 'My draft title'`);
    // reload requires explicit confirmation; cancelling keeps the draft
    await page.click('#cf-review'); await page.click('#cf-reload');
    await page.waitFor(`document.querySelector('#confirm').open`);
    await page.click('#cf-form button[value=cancel]');
    await page.waitFor(`!document.querySelector('#confirm').open`);
    expect(await page.eval(`document.querySelector('#ed-title').value`)).toBe('My draft title');
    expect(byTitle('Seed card').notes).toBe('changed by the CLI meanwhile');   // nothing was overwritten
    // confirming discards the draft and shows the current card
    await page.click('#cf-reload');
    await page.waitFor(`document.querySelector('#confirm').open`);
    await page.click('#cf-form button[value=ok]');
    await page.waitFor(`document.querySelector('#ed-title').value === 'Seed card' && document.querySelector('#ed-notes').value === 'changed by the CLI meanwhile'`);
    expect(await page.eval(`!!document.querySelector('#conflict-banner')`)).toBe(false);
    await page.click('#ed-close');
    await page.waitFor(`!document.querySelector('#editor').open`);
  });

  test('HTTP 409 on save (stale snapshot) keeps the draft and nothing is overwritten', async () => {
    const x = byTitle('Seed card');
    await openCard('Seed card');
    await page.set('#ed-title', 'Draft vs 409');
    // Stall GET /api/board so the page cannot notice the external change, then save: the server must answer 409.
    await page.send('Fetch.enable', {patterns: [{urlPattern: '*/api/board', requestStage: 'Request'}]});
    const held: string[] = [];
    const off = chrome.on(m => {
      if (m.sessionId !== page.sid || m.method !== 'Fetch.requestPaused') return;
      held.push(m.params.requestId);
    });
    await Bun.sleep(2500);                                    // let any in-flight poll finish / get held
    cliJson('edit', x.id, '--description', 'external change while snapshot is stale');
    const patches = () => page.requests.filter(r => r.method === 'PATCH').length;
    const before = patches();
    await page.click('#ed-save');
    await page.waitFor(`!!document.querySelector('#conflict-banner')`, 10000, '409 banner');
    expect(patches()).toBe(before + 1);                       // the PATCH really went out, with the stale hash
    expect(await page.eval(`document.querySelector('#conflict-banner').innerText`)).toContain('409');
    off();
    await page.send('Fetch.disable');
    expect(await page.eval(`document.querySelector('#ed-title').value`)).toBe('Draft vs 409');
    expect(byTitle('Seed card').title).toBe('Seed card');     // server file was not overwritten
    await page.click('#cf-reload'); await page.waitFor(`document.querySelector('#confirm').open`);
    await page.click('#cf-form button[value=ok]');
    await page.waitFor(`document.querySelector('#ed-title').value === 'Seed card'`);
    await page.click('#ed-close'); await page.waitFor(`!document.querySelector('#editor').open`);
  });

  test('archive hides a card, "Archived only" shows it, restore brings it back', async () => {
    const x = byTitle('From CLI (edited)'.replace('From CLI (edited)', 'Hand edited, same revision'));
    await page.click(`${cardSel(x.id)} button[aria-label^="Archive"]`);
    await page.waitFor(`!(${hasCard('Hand edited, same revision')})`);
    expect(items().find(i => i.id === x.id).archived).toBe(true);
    expect(await page.eval(`document.querySelector('#summary').innerText`)).toContain('(hidden)');
    await page.eval(`(() => { const s = document.querySelector('#f-archived'); s.value = 'only'; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
    await page.waitFor(hasCard('Hand edited, same revision'));
    expect(await page.eval(`document.querySelectorAll('.card-title').length`)).toBe(1);
    await page.click(`${cardSel(x.id)} button[aria-label^="Restore"]`);
    await page.waitFor(`!(${hasCard('Hand edited, same revision')})`);
    expect(items().find(i => i.id === x.id).archived).toBe(false);
    await page.eval(`(() => { const s = document.querySelector('#f-archived'); s.value = 'hide'; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
    await page.waitFor(hasCard('Hand edited, same revision'));
  });

  test('search and filters narrow the board and show counts / empty state', async () => {
    await page.type('#q', 'agent-7');
    await page.waitFor(`document.querySelectorAll('.card-title').length === 1 && ${hasCard('Edited in UI')}`);
    expect(await page.eval(`document.querySelector('#summary').innerText`)).toContain('1 shown');
    await page.set('#q', 'zzz-no-match');
    await page.waitFor(`document.body.innerText.includes('No cards match')`);
    await page.click('#f-clear');
    await page.waitFor(`document.querySelectorAll('.card-title').length >= 4`);
    expect(await page.eval(`document.querySelector('#q').value`)).toBe('');
  });

  test('status control, quick assignee dialog and keyboard shortcuts', async () => {
    const x = byTitle('Edited in UI');
    // <select> status control (works for keyboard + touch)
    await page.eval(`(() => { const s = document.querySelector('${cardSel(x.id)} select.move'); s.value = 'done'; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
    await page.waitFor(`${colOf('Edited in UI')} === 'done'`);
    expect(byTitle('Edited in UI').status).toBe('done');
    // Alt+ArrowLeft on the focused title moves one column left, focus is kept
    await page.focus(`${cardSel(x.id)} .card-title`);
    await page.key('ArrowLeft', {alt: true});
    await page.waitFor(`${colOf('Edited in UI')} === 'blocked'`);
    expect(byTitle('Edited in UI').status).toBe('blocked');
    expect(await page.eval(`document.activeElement.dataset.fk`)).toBe(x.id + ':title');
    // assignee dialog
    await page.click(`${cardSel(x.id)} .assignee`);
    await page.waitFor(`document.querySelector('#assign').open`);
    await page.set('#as-input', 'new-owner'); await page.key('Enter');
    await page.waitFor(`!document.querySelector('#assign').open`);
    await page.waitFor(`document.querySelector('${cardSel(x.id)} .assignee').textContent === '@new-owner'`);
    expect(byTitle('Edited in UI').assignee).toBe('new-owner');
    // "/" focuses search, "n" opens the new-card editor, Escape closes and keeps the typed draft
    await page.eval(`document.activeElement.blur()`);
    await page.key('/'); expect(await page.eval(`document.activeElement.id`)).toBe('q');
    await page.eval(`document.activeElement.blur()`);
    await page.key('n'); await page.waitFor(`document.querySelector('#editor').open`);
    await page.type('#ed-title', 'Escaped draft');
    await page.key('Escape'); await page.waitFor(`!document.querySelector('#editor').open`);
    await page.waitFor(`document.querySelector('#drafts-strip').innerText.includes('Escaped draft')`, 3000, 'draft chip');
    expect(items().some(i => i.title === 'Escaped draft')).toBe(false);          // not saved
    await page.click('#drafts-strip button');
    await page.waitFor(`document.querySelector('#editor').open && document.querySelector('#ed-title').value === 'Escaped draft'`);
    await page.click('#ed-cancel'); await page.waitFor(`document.querySelector('#confirm').open`);   // dirty → explicit confirmation
    await page.click('#cf-form button[value=ok]');
    await page.waitFor(`!document.querySelector('#editor').open`);
    await page.waitFor(`document.querySelector('#drafts-strip').innerText === ''`, 3000, 'draft chip removed');
  });

  test('native drag and drop moves a card using the latest revision', async () => {
    const x = byTitle('Seed card');
    await page.send('Input.setInterceptDrags', {enabled: true});
    let dragData: any = null;
    const off = chrome.on(m => { if (m.sessionId === page.sid && m.method === 'Input.dragIntercepted') dragData = m.params.data; });
    const src = await page.eval<{x: number; y: number}>(`(() => { const r = document.querySelector('${cardSel(x.id)} .id').getBoundingClientRect(); return {x: r.x + 4, y: r.y + r.height / 2}; })()`);
    const dst = await page.eval<{x: number; y: number}>(`(() => { const r = document.querySelector('.col[data-col="done"] .col-head').getBoundingClientRect(); return {x: r.x + 60, y: r.y + r.height + 20}; })()`);
    // an external edit right before dropping bumps the revision: the drop must still use the *latest* one
    await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: src.x, y: src.y});
    await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: src.x, y: src.y, button: 'left', buttons: 1, clickCount: 1});
    for (let i = 1; i <= 8 && !dragData; i++) { await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: src.x + i * 6, y: src.y + i * 4, button: 'left', buttons: 1}); await Bun.sleep(40); }
    for (let i = 0; i < 40 && !dragData; i++) await Bun.sleep(50);
    expect(dragData).not.toBeNull();
    cliJson('edit', x.id, '--notes', 'bumped during drag');
    await Bun.sleep(2200);                                   // poll applies while the drag is "in flight" (render is deferred)
    for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', {type, x: dst.x, y: dst.y, data: dragData});
    await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: dst.x, y: dst.y, button: 'left', clickCount: 1});
    off(); await page.send('Input.setInterceptDrags', {enabled: false});
    await page.waitFor(`${colOf('Seed card')} === 'done'`, 8000);
    const after = byTitle('Seed card');
    expect(after.status).toBe('done'); expect(after.notes).toBe('bumped during drag');   // concurrent edit preserved
  });

  test('six columns remain reachable and dragging works at 1024 pixels', async () => {
    const x = byTitle('Seed card');
    let off = () => {};
    try {
      for (const width of [1400, 1024]) {
        await page.resize(width, 900);
        expect(await page.eval(`document.querySelectorAll('.col .col-head').length`)).toBe(6);
        for (const id of ['backlog', 'needs-grilling', 'todo', 'in-progress', 'blocked', 'done']) {
          await page.eval(`document.querySelector('.col[data-col="${id}"]').scrollIntoView({block:'nearest', inline:'nearest'})`);
          expect(await page.eval(`(() => { const r = document.querySelector('.col[data-col="${id}"] .col-head').getBoundingClientRect(); return r.right > 0 && r.left < innerWidth; })()`)).toBe(true);
        }
      }
      await page.eval(`document.querySelector(${JSON.stringify(cardSel(x.id))}).scrollIntoView({block:'nearest', inline:'nearest'})`);
      await page.send('Input.setInterceptDrags', {enabled:true});
      let dragData: any = null;
      off = chrome.on(m => { if (m.sessionId === page.sid && m.method === 'Input.dragIntercepted') dragData = m.params.data; });
      const src = await page.eval<{x:number; y:number}>(`(() => { const r = document.querySelector(${JSON.stringify(cardSel(x.id) + ' .id')}).getBoundingClientRect(); return {x:r.x + 4, y:r.y + r.height / 2}; })()`);
      await page.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:src.x, y:src.y});
      await page.send('Input.dispatchMouseEvent', {type:'mousePressed', x:src.x, y:src.y, button:'left', buttons:1, clickCount:1});
      for (let i = 1; i <= 8 && !dragData; i++) {
        await page.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:src.x + i * 6, y:src.y + i * 4, button:'left', buttons:1});
        await Bun.sleep(40);
      }
      for (let i = 0; i < 40 && !dragData; i++) await Bun.sleep(50);
      expect(dragData).not.toBeNull();
      await page.eval(`document.querySelector('.col[data-col="backlog"]').scrollIntoView({block:'nearest', inline:'nearest'})`);
      const dst = await page.eval<{x:number; y:number}>(`(() => { const r = document.querySelector('.col[data-col="backlog"] .col-head').getBoundingClientRect(); return {x:r.x + 60, y:r.bottom + 20}; })()`);
      for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', {type, x:dst.x, y:dst.y, data:dragData});
      await page.send('Input.dispatchMouseEvent', {type:'mouseReleased', x:dst.x, y:dst.y, button:'left', clickCount:1});
      await page.waitFor(`${colOf('Seed card')} === 'backlog'`, 8000);
    } finally {
      off();
      await page.send('Input.setInterceptDrags', {enabled:false});
      await page.resize(1400, 900);
    }
  });

  test('narrow layout: no horizontal overflow, controls reachable; desktop layout screenshot', async () => {
    await shot('04-desktop-final');
    await page.resize(390, 800, true);
    await Bun.sleep(300);
    const overflow = await page.eval<number>(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await page.eval(`getComputedStyle(document.querySelector('.col')).width === document.querySelector('#board').clientWidth - 24 + 'px' || document.querySelector('.col').getBoundingClientRect().width > 300`)).toBe(true);
    const minTarget = await page.eval<number>(`Math.min(...[...document.querySelectorAll('.card button, .card select')].map(e => e.getBoundingClientRect().height))`);
    expect(minTarget).toBeGreaterThanOrEqual(26);
    await shot('05-narrow');
    // collapse toggle
    await page.click('.col .col-toggle');
    await page.waitFor(`document.querySelector('.col').classList.contains('collapsed')`);
    await page.click('.col .col-toggle');
    // editor is full-screen on narrow screens and does not overflow
    await page.click('.card-title');
    await page.waitFor(`document.querySelector('#editor').open`);
    expect(await page.eval(`document.querySelector('#editor').getBoundingClientRect().width`)).toBeLessThanOrEqual(390);
    expect(await page.eval(`document.querySelector('#editor .ed-body').scrollWidth <= document.querySelector('#editor .ed-body').clientWidth`)).toBe(true);
    await shot('06-narrow-editor');
    await page.key('Escape'); await page.waitFor(`!document.querySelector('#editor').open`);
    await page.resize(1400, 900);
  });

  test('long content does not break the layout', async () => {
    const long = 'W'.repeat(280) + ' ' + 'x'.repeat(10);
    cliJson('create', long, '--label', 'L'.repeat(80), '--assignee', 'A'.repeat(120));
    await page.waitFor(hasCard(long));
    const w = await page.eval<Json>(`(() => { const c = [...document.querySelectorAll('.card')].find(a => a.querySelector('.card-title').textContent.startsWith('WWWW')); const col = c.closest('.col'); return {card: c.getBoundingClientRect().width, col: col.getBoundingClientRect().width, over: c.scrollWidth > c.clientWidth + 1}; })()`);
    expect(w.card).toBeLessThanOrEqual(w.col); expect(w.over).toBe(false);
    await shot('07-long-content');
  });

  test('reconnect: offline shows status + keeps drafts, and recovers automatically', async () => {
    await openCard('Seed card');
    await page.set('#ed-notes', 'draft while offline');
    try {
      await page.offline(true);
      await page.waitFor(`document.querySelector('#conn').dataset.state === 'error'`, 12000, 'offline state');
      expect(await page.eval(`document.querySelector('#conn-text').innerText`)).toContain('retry in');
      expect(await page.eval(`document.querySelector('#notices').innerText`)).toContain('Connection problem');
      // saving offline never loses the draft
      await page.click('#ed-save');
      await page.waitFor(`document.querySelector('#ed-alerts').innerText.includes('Your draft is kept')`, 12000);
      expect(await page.eval(`document.querySelector('#ed-notes').value`)).toBe('draft while offline');
      await shot('08-offline');
    } finally { await page.offline(false); }
    await page.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`, 25000, 'automatic recovery');
    expect(await page.eval(`document.querySelector('#ed-notes').value`)).toBe('draft while offline');
    await page.click('#ed-save');                       // after recovery the same draft saves normally
    await page.waitFor(`!document.querySelector('#editor').open`, 10000);
    expect(byTitle('Seed card').notes).toBe('draft while offline');
  });

  test('stopped bridge → unreachable message; new-process token → access-denied message', async () => {
    bridge!.kill(); await bridge!.exited;
    await page.waitFor(`document.querySelector('#conn').dataset.state === 'error'`, 15000);
    expect(await page.eval(`document.querySelector('#notices').innerText`)).toContain('Cannot reach the bridge');
    expect(await page.eval(`document.querySelectorAll('.card').length`)).toBeGreaterThan(0);   // last data still visible
    const port = new URL(base).port;
    bridge = Bun.spawn([...CLI!,'--root', root, 'serve', '--ui', BOARD, '--port', port], {stdout: 'pipe', stderr: 'pipe'});
    const oldToken = token;
    const reader = (bridge.stdout as ReadableStream<Uint8Array>).getReader(); let buf = '';
    while (!/token=\S+/.test(buf)) { const {value, done} = await reader.read(); if (done) throw new Error('bridge exited'); buf += new TextDecoder().decode(value); }
    reader.releaseLock();
    token = buf.match(/token=(\S+)/)![1];
    expect(token).not.toBe(oldToken);
    await page.waitFor(`document.querySelector('#notices').innerText.includes('Access denied')`, 25000, 'access denied');
    await page.goto(url());                               // opening the new URL works
    await page.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
  });
});

// ---- Direct (File System Access API) mode: real FileSystemDirectoryHandle from OPFS, only the picker is stubbed ----
describe.skipIf(!ready)('board.html (direct file mode)', () => {
  let fixture: Record<string, string>;
  const picker = (files: Record<string, string>) => `(() => {
    const files = ${JSON.stringify(files)};
    window.showDirectoryPicker = async () => {
      const top = await navigator.storage.getDirectory();
      try { await top.removeEntry('proj', {recursive: true}); } catch {}
      const proj = await top.getDirectoryHandle('proj', {create: true});
      const ab = await proj.getDirectoryHandle('.agentboard', {create: true});
      const items = await ab.getDirectoryHandle('items', {create: true});
      for (const [name, text] of Object.entries(files)) {
        const dir = name.startsWith('features/') ? await ab.getDirectoryHandle('features', {create:true}) : name.startsWith('issues/') ? await ab.getDirectoryHandle('issues', {create:true}) : name === 'board.json' ? ab : items;
        const filename = name.startsWith('features/') ? name.slice('features/'.length) : name.startsWith('issues/') ? name.slice('issues/'.length) : name;
        const w = await (await dir.getFileHandle(filename, {create: true})).createWritable(); await w.write(text); await w.close();
      }
      return proj;
    };
  })()`;
  beforeAll(() => {
    if (!ready) return;
    const proj = join(tmpRoot, 'direct'); mkdirSync(proj);
    Bun.spawnSync([...CLI!,'init', proj]);
    Bun.spawnSync([...CLI!,'--root', proj, 'create', 'Direct seed', '--label', 'd1', '--criterion', 'c1']);
    fixture = {'board.json': readFileSync(join(proj, '.agentboard/board.json'), 'utf8')};
    for (const f of readdirSync(join(proj, '.agentboard/items'))) fixture[f] = readFileSync(join(proj, '.agentboard/items', f), 'utf8');
  });

  test('direct mode ignores temporary item and feature files', async () => {
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, '.tmp-AB-000000000000.json':'broken', 'features/.tmp-FT-000000000000.json':'broken'})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      expect(await p.eval(`document.body.textContent.includes('Direct seed')`)).toBe(true);
    } finally { await p.send('Page.close'); }
  });

  test('direct mode refuses status changes when issue data exists', async () => {
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, 'issues/IS-0123456789AB.json':'{}'})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      await p.click('.card-title[title="Direct seed"]');
      await p.eval(`document.querySelector('#ed-status').value = 'done'; document.querySelector('#ed-status').dispatchEvent(new Event('change', {bubbles:true}))`);
      await p.click('#ed-save');
      await p.waitFor(`document.body.textContent.includes('Use the local bridge to change work status')`);
      expect(await p.eval(`document.querySelector('#editor').open`)).toBe(true);
      expect(await p.eval(`document.querySelector('.card-title[title="Direct seed"]').closest('.col').dataset.col`)).toBe('backlog');
    } finally { await p.send('Page.close'); }
  });

  test('direct feature lifecycle and card linking writes valid files', async () => {
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker(fixture)});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      await p.click('#view-features');
      await p.click('#new-feature');
      await p.type('#feature-title', 'Direct lifecycle');
      await p.type('#feature-description', 'Description');
      await p.click('#feature-form button[type=submit]');
      await p.waitFor(`!document.querySelector('#feature-editor').open`);
      const id: string = await p.eval(`document.querySelector('.card[data-id^="FT-"]').dataset.id`);
      await p.click(`${cardSel(id)} .card-title`);
      await p.set('#feature-title', 'Direct edited');
      await p.set('#feature-description', 'Edited description');
      await p.click('#feature-form button[type=submit]');
      await p.waitFor(`!document.querySelector('#feature-editor').open`);
      await p.eval(`document.querySelector(${JSON.stringify(cardSel(id) + ' select')}).value = 'active'; document.querySelector(${JSON.stringify(cardSel(id) + ' select')}).dispatchEvent(new Event('change', {bubbles:true}))`);
      await p.waitFor(`document.querySelector(${JSON.stringify(cardSel(id))}).closest('.col').dataset.col === 'active'`);
      await p.click('#view-board');
      await p.click('.card-title[title="Direct seed"]');
      await p.eval(`document.querySelector('#ed-feature').value = ${JSON.stringify(id)}; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      await p.click('#ed-save');
      await p.waitFor(`!document.querySelector('#editor').open`);
      expect(await p.eval(`document.querySelector('.card').textContent.includes('Direct edited')`)).toBe(true);
      await p.click('#view-features');
      await p.click(`${cardSel(id)} .card-title`);
      await p.eval(`[...document.querySelectorAll('#feature-form button')].find(b => b.textContent === 'Archive').click()`);
      await p.waitFor(`!document.querySelector('#feature-editor').open`);
      await p.click('#feature-archived');
      await p.click(`${cardSel(id)} .card-title`);
      await p.eval(`[...document.querySelectorAll('#feature-form button')].find(b => b.textContent === 'Restore').click()`);
      await p.waitFor(`!document.querySelector('#feature-editor').open`);
      await p.click('#view-board');
      await p.click('.card-title[title="Direct seed"]');
      await p.eval(`document.querySelector('#ed-feature').value = ''; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true}))`);
      await p.click('#ed-save');
      await p.waitFor(`!document.querySelector('#editor').open`);
      const files: Record<string,string> = await p.eval(`(async () => { const ab = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('proj')).getDirectoryHandle('.agentboard'); const out = {'board.json':await (await (await ab.getFileHandle('board.json')).getFile()).text()}; for (const d of ['items','features']) { const dir = await ab.getDirectoryHandle(d); for await (const [name, handle] of dir.entries()) out[d + '/' + name] = await (await handle.getFile()).text(); } return out; })()`);
      const check = join(tmpRoot, 'direct-lifecycle-check');
      mkdirSync(join(check, '.agentboard/items'), {recursive:true});
      mkdirSync(join(check, '.agentboard/features'), {recursive:true});
      for (const [name, bytes] of Object.entries(files)) writeFileSync(join(check, '.agentboard', name), bytes);
      const result = Bun.spawnSync([...CLI!, '--root', check, '--json', 'feature-show', id]);
      expect(result.exitCode).toBe(0);
      const feature = JSON.parse(String(result.stdout));
      expect(feature.title).toBe('Direct edited');
      expect(feature.description).toBe('Edited description');
      expect(feature.status).toBe('planned');
      expect(feature.archived).toBe(false);
      expect(Bun.spawnSync([...CLI!, '--root', check, 'list', '--all']).exitCode).toBe(0);
    } finally { await p.send('Page.close'); }
  });

  test('direct card transitions update feature and custom-column progress', async () => {
    const feature = {version:'1.0.0', id:'FT-0123456789AB', revision:1, title:'Direct status', status:'planned', description:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', archived:false};
    const config = JSON.parse(fixture['board.json']);
    config.columns = [{id:'backlog',name:'Backlog'}, {id:'todo',name:'Todo'}, {id:'ready',name:'Ready'}, {id:'in-progress',name:'In progress'}, {id:'shipped',name:'Shipped'}];
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, 'board.json':JSON.stringify(config), ['features/' + feature.id + '.json']:JSON.stringify(feature)})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      await p.click('.card-title[title="Direct seed"]');
      await p.eval(`document.querySelector('#ed-feature').value = 'FT-0123456789AB'; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#ed-status').value = 'ready'; document.querySelector('#ed-status').dispatchEvent(new Event('change', {bubbles:true}));`);
      await p.click('#ed-save');
      await p.waitFor(`!document.querySelector('#editor').open`);
      await p.click('#view-features');
      await p.waitFor(`document.querySelector(${JSON.stringify(cardSel(feature.id))})?.closest('.col').dataset.col === 'planned'`);
      await p.click('#view-board');
      await p.click('.card-title[title="Direct seed"]');
      await p.eval(`document.querySelector('#ed-status').value = 'in-progress'; document.querySelector('#ed-status').dispatchEvent(new Event('change', {bubbles:true}));`);
      await p.click('#ed-save');
      await p.waitFor(`!document.querySelector('#editor').open`);
      await p.click('#view-features');
      await p.waitFor(`document.querySelector(${JSON.stringify(cardSel(feature.id))})?.closest('.col').dataset.col === 'active'`);
      await p.click('#view-board');
      await p.click('.card-title[title="Direct seed"]');
      await p.eval(`document.querySelector('#ed-status').value = 'shipped'; document.querySelector('#ed-status').dispatchEvent(new Event('change', {bubbles:true}));`);
      await p.click('#ed-save');
      await p.waitFor(`!document.querySelector('#editor').open`);
      await p.click('#view-features');
      await p.waitFor(`document.querySelector(${JSON.stringify(cardSel(feature.id))})?.closest('.col').dataset.col === 'done' && document.querySelector(${JSON.stringify(cardSel(feature.id))})?.textContent.includes('1 of 1 cards done')`);
    } finally { await p.send('Page.close'); }
  });

  test('direct archived status edit preserves manually moved feature', async () => {
    const feature = {version:'1.0.0', id:'FT-0123456789AB', revision:1, title:'Manual feature', status:'active', description:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', archived:false};
    const cardName = Object.keys(fixture).find(name => name.startsWith('AB-'))!;
    const live = {...JSON.parse(fixture[cardName]), feature:feature.id};
    const archived = {...live, id:'AB-FFFFFFFFFFFF', title:'Archived direct', archived:true};
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, [cardName]:JSON.stringify(live), [archived.id + '.json']:JSON.stringify(archived), ['features/' + feature.id + '.json']:JSON.stringify(feature)})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      await p.eval(`document.querySelector('#f-archived').value = 'only'; document.querySelector('#f-archived').dispatchEvent(new Event('change', {bubbles:true}));`);
      await p.click('.card-title[title="Archived direct"]');
      await p.eval(`document.querySelector('#ed-status').value = 'done'; document.querySelector('#ed-status').dispatchEvent(new Event('change', {bubbles:true}));`);
      await p.click('#ed-save');
      await p.waitFor(`!document.querySelector('#editor').open`);
      const saved = await p.eval<Json>(`(async () => { const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('proj'); const dir = await (await root.getDirectoryHandle('.agentboard')).getDirectoryHandle('features'); return JSON.parse(await (await (await dir.getFileHandle('FT-0123456789AB.json')).getFile()).text()); })()`);
      expect(saved.status).toBe('active');
      expect(saved.revision).toBe(1);
    } finally { await p.send('Page.close'); }
  });

  test('direct feature sync failure preserves unsent thread draft after card edit', async () => {
    const feature = {version:'1.0.0', id:'FT-0123456789AB', revision:1, title:'Fault feature', status:'planned', description:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', archived:false};
    const cardName = Object.keys(fixture).find(name => name.startsWith('AB-'))!;
    const card = {...JSON.parse(fixture[cardName]), feature:feature.id};
    card.thread = [{id:'TH-0123456789AB', kind:'question', author:null, body:'Question', replyTo:null, createdAt:feature.createdAt, updatedAt:feature.updatedAt}];
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, [cardName]:JSON.stringify(card), ['features/' + feature.id + '.json']:JSON.stringify(feature)})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      await p.eval(`(() => { const original = FileSystemFileHandle.prototype.createWritable; FileSystemFileHandle.prototype.createWritable = function(...args) { if (this.name === 'FT-0123456789AB.json') throw new Error('injected failure'); return original.apply(this, args); }; })()`);
      await p.click('.card-title[title="Direct seed"]');
      await p.set('#thread-author', 'Draft author');
      await p.set('#thread-body', 'Unsent comment');
      await p.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Answer').click()`);
      await p.set('#thread-list textarea', 'Unsent answer');
      await p.eval(`document.querySelector('#ed-status').value = 'done'; document.querySelector('#ed-status').dispatchEvent(new Event('change', {bubbles:true}));`);
      await p.click('#ed-save');
      await p.waitFor(`!document.querySelector('#editor').open && document.querySelector('#toasts').textContent.includes('was saved')`);
      await p.waitFor(`document.querySelector('.card-title[title="Direct seed"]')?.closest('.col').dataset.col === 'done'`);
      await p.click('.card-title[title="Direct seed"]');
      expect(await p.eval(`document.querySelector('#thread-author').value`)).toBe('Draft author');
      expect(await p.eval(`document.querySelector('#thread-body').value`)).toBe('Unsent comment');
      expect(await p.eval(`document.querySelector('#thread-list textarea').value`)).toBe('Unsent answer');
      expect(await p.eval(`document.querySelector('#ed-status').value`)).toBe('done');
      expect(await p.eval(`document.querySelector('#ed-save').disabled`)).toBe(true);
      await p.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post comment').click()`);
      await p.waitFor(`document.querySelector('#thread-list').textContent.includes('Unsent comment')`);
    } finally { await p.send('Page.close'); }
  });

  test('direct feature write failure identifies saved create and prevents duplicate submission', async () => {
    const feature = {version:'1.0.0', id:'FT-0123456789AB', revision:1, title:'Fault feature', status:'planned', description:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', archived:false};
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, ['features/' + feature.id + '.json']:JSON.stringify(feature)})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      await p.eval(`(() => { const original = FileSystemFileHandle.prototype.createWritable; FileSystemFileHandle.prototype.createWritable = function(...args) { if (this.name === 'FT-0123456789AB.json') throw new Error('injected failure'); return original.apply(this, args); }; })()`);
      await p.click('#new-card');
      await p.set('#ed-title', 'Saved despite failure');
      await p.eval(`document.querySelector('#ed-feature').value = 'FT-0123456789AB'; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#ed-status').value = 'done'; document.querySelector('#ed-status').dispatchEvent(new Event('change', {bubbles:true}));`);
      await p.click('#ed-save');
      await p.waitFor(`!document.querySelector('#editor').open && document.querySelector('#toasts').textContent.includes('Do not repeat create')`);
      const message = await p.eval<string>(`document.querySelector('#toasts').textContent`);
      expect(message).toMatch(/Card AB-[A-F0-9]{12} was saved/);
      expect(message).toContain('FT-0123456789AB');
      expect(message).toContain('For an archived card, status retries do not recalculate');
      const cards = await p.eval<Json>(`(async () => { const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('proj'); const dir = await (await root.getDirectoryHandle('.agentboard')).getDirectoryHandle('items'); const found = []; for await (const [name, handle] of dir.entries()) { const item = JSON.parse(await (await handle.getFile()).text()); if (item.title === 'Saved despite failure') found.push(item.id); } return found; })()`);
      expect(cards).toHaveLength(1);
      expect(message).toContain(cards[0]);
      await p.click('#new-card');
      expect(await p.eval(`document.querySelector('#ed-title').value`)).toBe('');
    } finally { await p.send('Page.close'); }
  });

  test('direct preflight failure leaves the edited card unchanged', async () => {
    const feature = {version:'1.0.0', id:'FT-0123456789AB', revision:1, title:'Direct failure', status:'planned', description:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', archived:false};
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, ['features/' + feature.id + '.json']:JSON.stringify(feature)})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      await p.click('.card-title[title="Direct seed"]');
      await p.eval(`document.querySelector('#ed-feature').value = 'FT-0123456789AB'; document.querySelector('#ed-feature').dispatchEvent(new Event('change', {bubbles:true}));`);
      await p.eval(`(async () => { const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('proj'); const ab = await root.getDirectoryHandle('.agentboard'); const dir = await ab.getDirectoryHandle('items'); const w = await (await dir.getFileHandle('AB-FFFFFFFFFFFF.json', {create:true})).createWritable(); await w.write('{'); await w.close(); })()`);
      await p.click('#ed-save');
      await p.waitFor(`document.querySelector('#ed-form').textContent.includes('not valid UTF-8 JSON')`);
      const card = await p.eval<Json>(`(async () => { const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('proj'); const dir = await (await root.getDirectoryHandle('.agentboard')).getDirectoryHandle('items'); for await (const [name, handle] of dir.entries()) if (name !== 'AB-FFFFFFFFFFFF.json') return JSON.parse(await (await handle.getFile()).text()); })()`);
      expect(card.feature).toBeNull();
      expect(card.revision).toBe(1);
    } finally { await p.send('Page.close'); }
  });

  test('direct card writes reject unknown and archived feature links', async () => {
    const id = 'FT-0123456789AB';
    const feature = {version:'1.0.0', id, revision:1, title:'Archived direct feature', status:'planned', description:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', archived:true};
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, ['features/' + id + '.json']:JSON.stringify(feature, null, 2) + '\n'})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      for (const [link, message] of [['FT-FFFFFFFFFFFF', 'Unknown feature'], [id, 'Feature is archived']]) {
        await p.click('.card-title[title="Direct seed"]');
        await p.eval(`(() => { const s = document.querySelector('#ed-feature'); const o = document.createElement('option'); o.value = ${JSON.stringify(link)}; o.textContent = 'Injected'; s.append(o); s.value = o.value; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
        await p.click('#ed-save');
        await p.waitFor(`document.querySelector('#ed-form').textContent.includes(${JSON.stringify(message)})`);
        await p.click('#ed-cancel');
        await p.click('#cf-form button[value=ok]');
        await p.waitFor(`!document.querySelector('#editor').open`);
      }
    } finally { await p.send('Page.close'); }
  });

  test('direct mode rejects hostile feature files without rewriting', async () => {
    const feature = {version:'1.0.0', id:'FT-0123456789AB', revision:1, title:'Hostile', status:'planned', description:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', archived:false};
    const cases = [
      {name:'FT-0123456789AB.json', value:{...feature, status:'missing'}, error:'Invalid feature status'},
      {name:'FT-0123456789AB.json', value:{...feature, title:3}, error:'Invalid feature text'},
      {name:'FT-0123456789AB.json', value:{...feature, version:'0.9.0'}, error:'Invalid feature structure or version'},
      {name:'FT-0123456789AB.json', value:JSON.parse(JSON.stringify(feature).replace(/}$/, ',"__proto__":{}}')), error:'Invalid feature structure or version'},
      {name:'FT-000000000000.json', value:feature, error:'filename'},
    ];
    for (const testCase of cases) {
      const p = await chrome.newPage();
      const bytes = JSON.stringify(testCase.value, null, 2) + '\n';
      try {
        await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, ['features/' + testCase.name]:bytes})});
        await p.goto(base + '/');
        await p.eval(`document.querySelector('.direct-box').open = true`);
        await p.click('#pick-folder');
        await p.waitFor(`document.querySelector('#conn').dataset.state === 'error'`);
        expect(await p.eval(`document.body.textContent.toLowerCase()`)).toContain(testCase.error.toLowerCase());
        const written = await p.eval(`(async () => { const ab = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('proj')).getDirectoryHandle('.agentboard'); return (await (await (await ab.getDirectoryHandle('features')).getFileHandle(${JSON.stringify(testCase.name)})).getFile()).text(); })()`);
        expect(written).toBe(bytes);
      } finally { await p.send('Page.close'); }
    }
  });

  test('direct mode rejects duplicate feature IDs without rewriting either file', async () => {
    const feature = {version:'1.0.0', id:'FT-0123456789AB', revision:1, title:'Duplicate', status:'planned', description:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', archived:false};
    const bytes = JSON.stringify(feature, null, 2) + '\n';
    const names = ['FT-0123456789AB.json', 'FT-AAAAAAAAAAAA.json'];
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, ['features/' + names[0]]:bytes, ['features/' + names[1]]:bytes})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'error'`);
      expect(await p.eval(`document.body.textContent.toLowerCase()`)).toContain('filename');
      for (const name of names) {
        expect(await p.eval(`(async () => { const ab = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('proj')).getDirectoryHandle('.agentboard'); return (await (await (await ab.getDirectoryHandle('features')).getFileHandle(${JSON.stringify(name)})).getFile()).text(); })()`)).toBe(bytes);
      }
    } finally { await p.send('Page.close'); }
  });

  test('direct feature edit matches the real CLI file bytes', async () => {
    const source = join(tmpRoot, 'bytes-source');
    mkdirSync(source);
    expect(Bun.spawnSync([...CLI!, 'init', source]).exitCode).toBe(0);
    const created = Bun.spawnSync([...CLI!, '--root', source, '--json', 'feature-create', 'Byte feature']);
    expect(created.exitCode).toBe(0);
    const feature = JSON.parse(String(created.stdout));
    const files: Record<string,string> = {'board.json':readFileSync(join(source, '.agentboard/board.json'), 'utf8')};
    files['features/' + feature.id + '.json'] = readFileSync(join(source, '.agentboard/features', feature.id + '.json'), 'utf8');
    const cliCopy = join(tmpRoot, 'bytes-cli-copy');
    cpSync(source, cliCopy, {recursive:true});
    const edited = Bun.spawnSync([...CLI!, '--root', cliCopy, '--json', 'feature-edit', feature.id, '--title', 'Byte edited', '--description', 'Byte description']);
    expect(edited.exitCode).toBe(0);
    const expected = readFileSync(join(cliCopy, '.agentboard/features', feature.id + '.json'), 'utf8');
    const timestamp = JSON.parse(expected).updatedAt;
    const p = await chrome.newPage();
    try {
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker(files)});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
      await p.click('#view-features');
      await p.click(`${cardSel(feature.id)} .card-title`);
      await p.set('#feature-title', 'Byte edited');
      await p.set('#feature-description', 'Byte description');
      await p.eval(`(() => { const NativeDate = Date; window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [${JSON.stringify(timestamp)}])); } static now() { return NativeDate.parse(${JSON.stringify(timestamp)}); } }; })()`);
      await p.click('#feature-form button[type=submit]');
      await p.waitFor(`!document.querySelector('#feature-editor').open`);
      const actual = await p.eval<string>(`(async () => { const ab = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('proj')).getDirectoryHandle('.agentboard'); return (await (await (await ab.getDirectoryHandle('features')).getFileHandle(${JSON.stringify(feature.id + '.json')})).getFile()).text(); })()`);
      expect(actual).toBe(expected);
    } finally { await p.send('Page.close'); }
  });

  test('direct feature creation writes canonical bytes accepted by the CLI', async () => {
    const p = await chrome.newPage();
    await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker(fixture)});
    await p.goto(base + '/');
    await p.eval(`document.querySelector('.direct-box').open = true`);
    await p.click('#pick-folder');
    await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
    await p.click('#view-features');
    await p.click('#new-feature');
    await p.type('#feature-title', 'Direct feature');
    await p.click('#feature-form button[type=submit]');
    await p.waitFor(`!document.querySelector('#feature-editor').open`);
    const bytes: string = await p.eval(`(async () => {
      const ab = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('proj')).getDirectoryHandle('.agentboard');
      const dir = await ab.getDirectoryHandle('features');
      for await (const [, handle] of dir.entries()) return (await handle.getFile()).text();
    })()`);
    const feature = JSON.parse(bytes);
    expect(bytes).toBe(JSON.stringify(feature, null, 2) + '\n');
    const check = join(tmpRoot, 'direct-feature-check');
    mkdirSync(join(check, '.agentboard/features'), {recursive:true});
    mkdirSync(join(check, '.agentboard/items'), {recursive:true});
    writeFileSync(join(check, '.agentboard/board.json'), fixture['board.json']);
    writeFileSync(join(check, '.agentboard/features', feature.id + '.json'), bytes);
    expect(Bun.spawnSync([...CLI!, '--root', check, 'feature-show', feature.id]).exitCode).toBe(0);
  });

  test('invalid and newer direct feature files are rejected without rewriting', async () => {
    const feature = {
      version:'1.0.0', id:'FT-0123456789AB', revision:1, title:'Invalid feature', status:'planned',
      description:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', archived:false,
    };
    for (const value of [{...feature, revision:0}, {...feature, version:'99.0.0'}]) {
      const name = 'features/' + feature.id + '.json';
      const bytes = JSON.stringify(value, null, 2) + '\n';
      const p = await chrome.newPage();
      await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, [name]:bytes})});
      await p.goto(base + '/');
      await p.eval(`document.querySelector('.direct-box').open = true`);
      await p.click('#pick-folder');
      await p.waitFor(`document.querySelector('#conn').dataset.state === 'error' && document.body.textContent.includes(${JSON.stringify(value.revision === 0 ? 'Invalid feature ID or revision' : 'newer AgentBoard')})`);
      const actual = await p.eval(`(async () => {
        const ab = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('proj')).getDirectoryHandle('.agentboard');
        const dir = await ab.getDirectoryHandle('features');
        return (await (await dir.getFileHandle(${JSON.stringify(feature.id + '.json')})).getFile()).text();
      })()`);
      expect(actual).toBe(bytes);
    }
  });

  test('upgrades legacy files to the same bytes as the CLI', async () => {
    const source = join(HERE, 'ts/fixtures/v1-board');
    const files: Record<string, string> = {'board.json': readFileSync(join(source, 'board.json'), 'utf8')};
    for (const name of readdirSync(join(source, 'items'))) files[name] = readFileSync(join(source, 'items', name), 'utf8');
    const expected = join(tmpRoot, 'legacy-expected');
    mkdirSync(join(expected, '.agentboard/items'), {recursive:true});
    for (const [name, value] of Object.entries(files)) writeFileSync(name === 'board.json' ? join(expected, '.agentboard/board.json') : join(expected, '.agentboard/items', name), value);
    expect(Bun.spawnSync([...CLI!, '--root', expected, 'list', '--all']).exitCode).toBe(0);
    const p = await chrome.newPage();
    await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker(files)});
    await p.goto(base + '/');
    await p.eval(`document.querySelector('.direct-box').open = true`);
    await p.click('#pick-folder');
    await p.waitFor(`document.querySelector('#conn').dataset.state === 'ok'`);
    const written: Record<string, string> = await p.eval(`(async () => { const ab = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('proj')).getDirectoryHandle('.agentboard'); const items = await ab.getDirectoryHandle('items'); const out = {'board.json':await (await (await ab.getFileHandle('board.json')).getFile()).text()}; for await (const [n,h] of items.entries()) out[n] = await (await h.getFile()).text(); return out; })()`);
    for (const [name, value] of Object.entries(written)) expect(value).toBe(readFileSync(name === 'board.json' ? join(expected, '.agentboard/board.json') : join(expected, '.agentboard/items', name), 'utf8'));
  });

  test('newer card is reported and never rewritten', async () => {
    const name = Object.keys(fixture).find(n => n !== 'board.json')!;
    const invalid = JSON.stringify({...JSON.parse(fixture[name]), version:'99.0.0'}, null, 2) + '\n';
    const p = await chrome.newPage();
    await p.send('Page.addScriptToEvaluateOnNewDocument', {source:picker({...fixture, [name]:invalid})});
    await p.goto(base + '/'); await p.eval(`document.querySelector('.direct-box').open = true`); await p.click('#pick-folder');
    await p.waitFor(`document.body.innerText.includes('newer AgentBoard')`);
    const bytes = await p.eval(`(async () => { const top = await navigator.storage.getDirectory(); const proj = await top.getDirectoryHandle('proj'); const ab = await proj.getDirectoryHandle('.agentboard'); const items = await ab.getDirectoryHandle('items'); return (await (await items.getFileHandle(${JSON.stringify(name)})).getFile()).text(); })()`);
    expect(bytes).toBe(invalid);
  });

  test('unsupported browsers get a bridge-fallback explanation', async () => {
    const p = await chrome.newPage();
    await p.send('Page.addScriptToEvaluateOnNewDocument', {source: `Object.defineProperty(window, 'showDirectoryPicker', {value: undefined, configurable: true});`});
    await p.goto(`${base}/`);
    await p.waitFor(`document.body.innerText.includes('Not supported in this browser')`);
    expect(await p.eval(`document.body.innerText.includes('local bridge')`)).toBe(true);
  });

  test('pick folder → board loads, warning is visible, edits write valid files the CLI validator accepts', async () => {
    const p = await chrome.newPage();
    await p.send('Page.addScriptToEvaluateOnNewDocument', {source: picker(fixture)});
    await p.goto(`${base}/`);                              // bridge page without a token → direct option
    await p.eval(`document.querySelector('.direct-box').open = true`);
    await p.click('#pick-folder');
    await p.waitFor(`[...document.querySelectorAll('.card-title')].some(x => x.textContent === 'Direct seed')`, 10000, 'direct load');
    expect(await p.eval(`document.querySelector('#notices').innerText`)).toContain('concurrent updates can be lost');
    expect(await p.eval(`document.querySelector('#mode-badge').innerText`)).toContain('Direct file mode');
    // create + edit through the UI
    await p.click('#new-card'); await p.waitFor(`document.querySelector('#editor').open`);
    await p.type('#ed-title', 'Direct created'); await p.type('#ed-labels', 'x'); await p.key('Enter');
    await p.click('#ed-save'); await p.waitFor(`!document.querySelector('#editor').open`);
    await p.waitFor(`[...document.querySelectorAll('.card-title')].some(x => x.textContent === 'Direct created')`, 8000);
    await p.click(`.card-title[title="Direct seed"]`); await p.waitFor(`document.querySelector('#editor').open`);
    await p.set('#thread-body', 'Direct question');
    await p.eval(`[...document.querySelectorAll('#thread-panel button')].find(b => b.textContent === 'Post question').click()`);
    await p.waitFor(`document.querySelector('#thread-list').textContent.includes('Direct question')`);
    await p.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Answer').click()`);
    await p.set('#thread-list textarea', 'Direct answer');
    await p.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Post answer').click()`);
    await p.waitFor(`document.querySelector('#thread-list').textContent.includes('answered')`);
    await p.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Edit').click()`);
    await p.set('#thread-list textarea', 'Edited direct question');
    await p.eval(`[...document.querySelectorAll('#thread-list button')].find(b => b.textContent === 'Save entry').click()`);
    await p.waitFor(`document.querySelector('#thread-list').textContent.includes('Edited direct question')`);
    await p.set('#ed-notes', 'direct note'); await p.click('#ed-save'); await p.waitFor(`!document.querySelector('#editor').open`);
    await p.waitFor(`true`);
    // read the files the browser wrote and validate them with the real CLI validator
    const written: Record<string, string> = await p.eval(`(async () => { const top = await navigator.storage.getDirectory(); const ab = await (await top.getDirectoryHandle('proj')).getDirectoryHandle('.agentboard'); const out = {}; const items = await ab.getDirectoryHandle('items'); out['board.json'] = await (await (await ab.getFileHandle('board.json')).getFile()).text(); for await (const [n, h] of items.entries()) out[n] = await (await h.getFile()).text(); return out; })()`);
    const check = join(tmpRoot, 'direct-check'); mkdirSync(join(check, '.agentboard/items'), {recursive: true});
    for (const [n, t] of Object.entries(written)) writeFileSync(n === 'board.json' ? join(check, '.agentboard/board.json') : join(check, '.agentboard/items', n), t);
    const r = Bun.spawnSync([...CLI!,'--root', check, '--json', 'list', '--all']);
    expect(r.exitCode).toBe(0);
    const list = JSON.parse(String(r.stdout));
    expect(list.map((i: Json) => i.title).sort()).toEqual(['Direct created', 'Direct seed']);
    const seed = list.find((i: Json) => i.title === 'Direct seed');
    expect(seed.notes).toBe('direct note'); expect(seed.revision).toBe(5); expect(seed.thread).toHaveLength(2); expect(seed.thread[0].body).toBe('Edited direct question'); expect(seed.thread[1].replyTo).toBe(seed.thread[0].id); expect(seed.labels).toEqual(['d1']);
  });
});

describe.skipIf(!ready)('board.html (opened as a local file)', () => {
  test('loads from file:// and shows the launch screen (direct mode picker itself needs a human)', async () => {
    const p = await chrome.newPage();
    const errors: string[] = [];
    chrome.on(m => { if (m.sessionId === p.sid && m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails)); });
    await p.goto(pathToFileURL(BOARD).href);
    await p.waitFor(`document.body.innerText.includes('opened as a local file')`);
    expect(errors).toEqual([]);
    const info = await p.eval<Json>(`({secure: window.isSecureContext, picker: typeof window.showDirectoryPicker, opfs: !!(navigator.storage && navigator.storage.getDirectory)})`);
    // Record what this Chrome reports so the result is visible in the test output.
    console.log('file:// context:', JSON.stringify(info));
  });
});
