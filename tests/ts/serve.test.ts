import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge } from '../../scripts/lib/serve';
import { init } from '../../scripts/lib/store';

test('bridge serves UI, protects API, and performs create/update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-serve-'));
  const ui = join(dir, 'board.html');
  writeFileSync(ui, '<p>bridge</p>');
  init(dir);
  const lines: string[] = [];
  const bridge = startBridge(dir, 0, ui, line => lines.push(line));
  const base = `http://127.0.0.1:${bridge.port}`;
  const headers = {Authorization: `Bearer ${bridge.token}`};
  try {
    expect(lines[0]).toBe(`Open: ${base}/#token=${bridge.token}`);
    let res = await fetch(base + '/', {headers});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toBe('<p>bridge</p>');
    res = await fetch(base + '/api/board');
    expect(res.status).toBe(403);
    res = await fetch(base + '/api/board', {headers});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const board: any = await res.json();
    expect(board.hashes).toEqual({});
    res = await fetch(base + '/api/items', {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({title:'HTTP item'})});
    expect(res.status).toBe(201);
    const item: any = await res.json();
    res = await fetch(base + `/api/items/${item.id}`, {method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({revision:1,hash:board.hashes[item.id] ?? (await (await fetch(base+'/api/board',{headers})).json() as any).hashes[item.id],changes:{title:'Updated'}})});
    expect(res.status).toBe(200);
    res = await fetch(base + '/missing', {headers});
    expect(res.status).toBe(404);
  } finally { bridge.stop(); rmSync(dir,{recursive:true,force:true}); }
});
