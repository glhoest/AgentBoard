import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BoardError, Conflict, FeatureSyncError } from './types';
import { encode, snapshot, hashItem, hashFeature, createFeature, updateFeature, create, update, addEntry, editEntry } from './store';
import { withLock } from './lock';
import { listIssues, hashIssue, createIssue, updateIssue, addEvidence } from './issues';

const FEATURE_ROUTE = /^\/api\/features\/(FT-[0-9A-F]{12})$/;
const ITEM_ROUTE = /^\/api\/items\/(AB-[0-9A-F]{12})$/;
const THREAD_ROUTE = /^\/api\/items\/(AB-[0-9A-F]{12})\/thread$/;
const ENTRY_ROUTE = /^\/api\/items\/(AB-[0-9A-F]{12})\/thread\/(TH-[0-9A-F]{12})$/;

function response(status: number, value: unknown): Response {
  const body = encode(value);
  return new Response(body, { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(body.byteLength),
  }});
}

/** Checks a write body `{revision, hash, <payload>}` (exactly these keys) and returns the payload. */
function versioned(body: any, payload: 'changes' | 'entry'): unknown {
  if (Object.keys(body).sort().join(',') !== [payload, 'hash', 'revision'].sort().join(',')
    || body.revision == null || typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash)) {
    throw new BoardError(`Expected revision, SHA-256 hash and ${payload}`);
  }
  return body[payload];
}

function handleWrite(root: string, method: string, path: string, body: any): Response {
  if (method === 'POST' && path === '/api/issues') return response(201, createIssue(root, body));
  const issueMatch = path.match(/^\/api\/issues\/(IS-[0-9A-F]{12})(\/evidence)?$/);
  if (issueMatch && method === 'PATCH' && !issueMatch[2]) {
    const changes = versioned(body, 'changes') as any;
    return response(200, updateIssue(root, issueMatch[1], body.revision, changes, { expectedHash: body.hash }));
  }
  if (issueMatch && method === 'POST' && issueMatch[2]) {
    const entry = versioned(body, 'entry');
    return response(200, addEvidence(root, issueMatch[1], body.revision, entry as string, { expectedHash: body.hash }));
  }
  if (method === 'POST' && path === '/api/features') return response(201, createFeature(root, body));
  const featureMatch = path.match(FEATURE_ROUTE);
  if (method === 'PATCH' && featureMatch) {
    const changes = versioned(body, 'changes') as any;
    return response(200, updateFeature(root, featureMatch[1], body.revision, changes, { expectedHash: body.hash }));
  }
  if (method === 'POST' && path === '/api/items') return response(201, create(root, body));
  let match = path.match(ITEM_ROUTE);
  if (method === 'PATCH' && match) {
    const changes = versioned(body, 'changes') as any;
    return response(200, update(root, match[1], body.revision, changes, { expectedHash: body.hash }));
  }
  match = path.match(THREAD_ROUTE);
  if (method === 'POST' && match) {
    const entry = versioned(body, 'entry') as any;
    return response(201, addEntry(root, match[1], body.revision, entry, { expectedHash: body.hash }));
  }
  match = path.match(ENTRY_ROUTE);
  if (method === 'PATCH' && match) {
    const changes = versioned(body, 'changes') as any;
    return response(200, editEntry(root, match[1], match[2], body.revision, changes, { expectedHash: body.hash }));
  }
  return response(404, { error: 'Not found', code: 'not_found' });
}

export function startBridge(root: string, port: number, uiPath: string, print: (line: string) => void = console.log): { port: number; token: string; stop(): void } {
  const ui = resolve(uiPath);
  if (!existsSync(ui)) throw new BoardError(`UI file missing: ${ui}. Supply --ui after Claude creates it.`);
  const token = randomBytes(32).toString('base64url');
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const host = req.headers.get('Host') ?? '';
    const allowedHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
    if (req.method === 'GET' && path === '/') {
      if (!allowedHosts.includes(host)) return response(403, { error: 'Invalid host', code: 'forbidden' });
      const body = readFileSync(ui);
      return new Response(body, { status: 200, headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      }});
    }
    if (!allowedHosts.includes(host)) return response(403, { error: 'Invalid host', code: 'forbidden' });
    const origin = req.headers.get('Origin');
    if (origin && ![`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`].includes(origin)) {
      return response(403, { error: 'Invalid origin', code: 'forbidden' });
    }
    if (req.headers.get('Authorization') !== `Bearer ${token}`) return response(403, { error: 'Invalid token', code: 'forbidden' });
    try {
      if (req.method === 'GET' && path === '/api/board') {
        // Under the lock, the snapshot upgrades older files on disk first, so the hashes match the current bytes.
        const result = withLock(root, () => {
          const value = snapshot(root) as any;
          value.issues = listIssues(root);
          value.hashes = Object.fromEntries([
            ...value.items.map((item: any) => [item.id, hashItem(root, item.id)]),
            ...value.features.map((feature: any) => [feature.id, hashFeature(root, feature.id)]),
            ...value.issues.map((issue: any) => [issue.id, hashIssue(root, issue.id)]),
          ]);
          return value;
        });
        return response(200, result);
      }
      if (req.method === 'POST' || req.method === 'PATCH') {
        if ((req.headers.get('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new BoardError('Expected application/json');
        const length = Number(req.headers.get('Content-Length') ?? '0');
        if (!Number.isInteger(length) || length < 1 || length > 1048576) throw new BoardError('Invalid request size');
        // Request bodies are bounded before parsing; Bun's Request stream is consumed once.
        return req.arrayBuffer().then(buffer => {
          if (buffer.byteLength !== length) throw new BoardError('Invalid request size');
          const body: any = JSON.parse(new TextDecoder().decode(buffer));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BoardError('Expected JSON object');
          return handleWrite(root, req.method, path, body);
        }).catch(error => errorResponse(error));
      }
      return response(404, { error: 'Not found', code: 'not_found' });
    } catch (error) {
      return errorResponse(error);
    }
  }});
  print(`Open: http://127.0.0.1:${server.port}/#token=${token}`);
  return { port: server.port, token, stop() { server.stop(true); } };
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof FeatureSyncError) return response(500, { error: message, code: 'feature_sync_failed', itemId: error.itemId, featureIds: error.featureIds });
  if (error instanceof Conflict) return response(409, { error: message, code: 'conflict' });
  if (error instanceof BoardError || error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) {
    return response(400, { error: message, code: 'invalid' });
  }
  if (error instanceof Error && 'code' in error) return response(500, { error: message, code: 'io_error' });
  return response(400, { error: message, code: 'invalid' });
}
