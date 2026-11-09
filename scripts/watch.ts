#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withLock } from './lib/lock';
import { locate, snapshot } from './lib/store';
import { changes, EVENT_TYPES, type EventType } from './lib/watch-events';

const usage = `Usage: bun watch.ts [--root DIR] [--interval MS] [--timeout MS] [--on TYPE ...] (--webhook | -- PROGRAM [ARG ...])

Watch a board until interrupted. Events: ${EVENT_TYPES.join(', ')}
--webhook reads AGENTBOARD_WEBHOOK_URL and optional AGENTBOARD_WEBHOOK_AUTHORIZATION.
Process actions receive one JSON batch on stdin; arguments are passed directly, without a shell.`;

type Options = { root: string; interval: number; timeout: number; events: Set<string>; webhook: boolean; command: string[] };

function parse(argv: string[]): Options {
  let root = process.cwd();
  let interval = 2000;
  let timeout = 60000;
  let webhook = false;
  const events = new Set<string>();
  let command: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { command = argv.slice(i + 1); break; }
    if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0); }
    if (arg === '--webhook') { webhook = true; continue; }
    if (!['--root', '--interval', '--timeout', '--on'].includes(arg) || i + 1 >= argv.length) throw new Error(`Invalid option: ${arg}`);
    const value = argv[++i];
    if (arg === '--root') root = value;
    if (arg === '--on') {
      if (!EVENT_TYPES.includes(value as EventType)) throw new Error(`Unknown event type: ${value}`);
      events.add(value);
    }
    if (arg === '--interval' || arg === '--timeout') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 100 || Number(value) > 86400000) {
        throw new Error(`${arg} must be an integer from 100 to 86400000 milliseconds`);
      }
      if (arg === '--interval') interval = Number(value);
      else timeout = Number(value);
    }
  }
  if (webhook === (command.length > 0)) throw new Error('Choose exactly one of --webhook or -- PROGRAM [ARG ...]');
  root = locate(root);
  if (command.length) {
    const executable = command[0];
    const pathLike = isAbsolute(executable) || executable.includes('/') || executable.includes('\\');
    const resolved = Bun.which(pathLike ? resolve(root, executable) : executable);
    if (!resolved) throw new Error(`Action executable not found: ${executable}`);
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) throw new Error('Windows .cmd and .bat action wrappers are not supported; use a real executable');
    command[0] = resolved;
  }
  return { root, interval, timeout, events, webhook, command };
}

let active: ChildProcess | null = null;
let stopping = false;
const stopController = new AbortController();

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
}

async function runProcess(command: string[], root: string, input: string, timeout: number): Promise<void> {
  const child = spawn(command[0], command.slice(1), {
    cwd: root, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, detached: process.platform !== 'win32',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['AGENTBOARD_WEBHOOK_URL', 'AGENTBOARD_WEBHOOK_AUTHORIZATION'].includes(key.toUpperCase()))),
  });
  active = child;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
  try {
    await new Promise<void>((resolve, reject) => {
      let inputError: Error | null = null;
      child.stdin?.on('error', error => {
        if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes((error as NodeJS.ErrnoException).code ?? '')) inputError = error;
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (timedOut) reject(new Error('Action timed out'));
        else if (stopping) resolve();
        else if (code !== 0) reject(new Error(`Action failed (exit ${code ?? signal})`));
        else if (inputError) reject(new Error(`Action stdin failed: ${inputError.message}`));
        else resolve();
      });
      child.stdin?.end(input);
    });
  } finally {
    clearTimeout(timer);
    active = null;
  }
}

function webhookUrl(): URL {
  let url: URL;
  try { url = new URL(process.env.AGENTBOARD_WEBHOOK_URL ?? ''); } catch { throw new Error('Invalid AGENTBOARD_WEBHOOK_URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw new Error('Webhook requires HTTPS (HTTP is allowed only on localhost); URL credentials are not supported');
  }
  return url;
}

async function postWebhook(url: URL, input: string, timeout: number): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.AGENTBOARD_WEBHOOK_AUTHORIZATION) headers.authorization = process.env.AGENTBOARD_WEBHOOK_AUTHORIZATION;
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: input, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(timeout), stopController.signal]) });
  } catch {
    if (stopping) return;
    throw new Error('Webhook request failed or timed out');
  }
  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
  await response.body?.cancel();
}

async function watch(options: Options): Promise<void> {
  const url = options.webhook ? webhookUrl() : null;
  const read = () => withLock(options.root, () => snapshot(options.root, { persist: false }));
  let previous = read();
  let lastWarning = '';
  const dispatches: number[] = [];
  console.error('AgentBoard watcher ready; initial snapshot is the baseline.');
  while (!stopping) {
    try { await delay(options.interval, undefined, { signal: stopController.signal }); } catch { if (!stopping) throw new Error('Polling delay failed'); }
    if (stopping) break;
    let next;
    try {
      next = read();
      if (lastWarning) console.error('AgentBoard watcher: board readable again.');
      lastWarning = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('written by a newer AgentBoard')) throw error;
      if (message !== lastWarning) console.error(`AgentBoard watcher: snapshot failed; retrying: ${message}`);
      lastWarning = message;
      continue;
    }
    const events = changes(previous, next).filter(event => !options.events.size || options.events.has(event.type));
    previous = next;
    if (!events.length) continue;
    const now = Date.now();
    while (dispatches.length && dispatches[0] <= now - 60000) dispatches.shift();
    if (dispatches.length >= 60) throw new Error('Action rate limit exceeded (60 batches per minute); possible feedback loop');
    dispatches.push(now);
    const input = JSON.stringify({ schema: 1, at: new Date(now).toISOString(), events }) + '\n';
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Event batch exceeds 1 MiB');
    if (url) await postWebhook(url, input, options.timeout);
    else await runProcess(options.command, options.root, input, options.timeout);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopping = true; stopController.abort(); if (active) killTree(active); });
}

try {
  await watch(parse(process.argv.slice(2)));
} catch (error) {
  console.error(`AgentBoard watcher: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
