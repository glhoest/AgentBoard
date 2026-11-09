// Minimal Chrome DevTools Protocol client for Bun (no dependencies). Used only by ui.test.ts.
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export function findChrome(): string | null {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)']!, 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[];
  return candidates.find(existsSync) ?? null;
}

type Pending = {resolve: (v: any) => void; reject: (e: Error) => void};

export class Chrome {
  proc!: ReturnType<typeof Bun.spawn>;
  ws!: WebSocket;
  profile = mkdtempSync(join(tmpdir(), 'ab-chrome-'));
  private id = 0;
  private pending = new Map<number, Pending>();
  private listeners: ((m: any) => void)[] = [];

  static async launch(path: string): Promise<Chrome> {
    const c = new Chrome();
    c.proc = Bun.spawn([path, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${c.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--hide-scrollbars', 'about:blank'], {stdout: 'ignore', stderr: 'pipe'});
    const reader = (c.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = '', url = '';
    const deadline = Date.now() + 20000;
    while (!url && Date.now() < deadline) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) url = m[1];
    }
    reader.releaseLock();
    if (!url) throw new Error('Chrome did not report a DevTools endpoint');
    c.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { c.ws.onopen = () => res(); c.ws.onerror = () => rej(new Error('CDP websocket failed')); });
    c.ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && c.pending.has(msg.id)) { const p = c.pending.get(msg.id)!; c.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
      else for (const l of c.listeners) l(msg);
    };
    return c;
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params, sessionId}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
  on(fn: (m: any) => void) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(l => l !== fn); }; }
  async newPage(): Promise<Page> {
    const {targetId} = await this.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await this.send('Target.attachToTarget', {targetId, flatten: true});
    const p = new Page(this, sessionId);
    await p.init();
    return p;
  }
  async close() {
    try { this.ws.close(); } catch {}
    try { this.proc.kill(); await this.proc.exited; } catch {}
    for (let i = 0; i < 5; i++) { try { rmSync(this.profile, {recursive: true, force: true}); break; } catch { await Bun.sleep(200); } }
  }
}

export class Page {
  requests: {url: string; headers: Record<string, string>; method: string}[] = [];
  constructor(public chrome: Chrome, public sid: string) {
    chrome.on(m => {
      if (m.sessionId !== sid) return;
      if (m.method === 'Network.requestWillBeSent') this.requests.push({url: m.params.request.url, headers: m.params.request.headers, method: m.params.request.method});
    });
  }
  async init() {
    for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(m);
  }
  send(method: string, params: object = {}) { return this.chrome.send(method, params, this.sid); }
  async goto(url: string) {
    await this.send('Page.navigate', {url});
    await this.waitFor(`document.readyState === 'complete'`, 15000);
  }
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) + '\n' + expression);
    return r.result.value;
  }
  async waitFor(expression: string, timeout = 8000, what = expression) {
    const end = Date.now() + timeout;
    let last: any;
    while (Date.now() < end) {
      try { last = await this.eval(expression); if (last) return last; } catch (e) { last = e; }
      await Bun.sleep(60);
    }
    throw new Error(`Timed out waiting for: ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
  }
  q(sel: string) { return `document.querySelector(${JSON.stringify(sel)})`; }
  async click(sel: string) {
    await this.waitFor(`!!${this.q(sel)}`, 5000, 'exists ' + sel);
    await this.eval(`${this.q(sel)}.scrollIntoView({block:'center'})`);
    const box = await this.eval<{x: number; y: number}>(`(() => { const r = ${this.q(sel)}.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', {type, x: box.x, y: box.y, button: 'left', clickCount: 1});
  }
  async focus(sel: string) { await this.eval(`${this.q(sel)}.focus()`); }
  async type(sel: string, text: string) {
    await this.focus(sel);
    await this.send('Input.insertText', {text});
  }
  async set(sel: string, value: string) { // replace content, firing real input events
    await this.focus(sel);
    await this.eval(`${this.q(sel)}.select()`);
    await this.send('Input.insertText', {text: value});
  }
  async key(key: string, opts: {alt?: boolean; ctrl?: boolean; code?: string; vk?: number} = {}) {
    const modifiers = (opts.alt ? 1 : 0) | (opts.ctrl ? 2 : 0);
    const map: Record<string, [string, number]> = {Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], ' ': ['Space', 32]};
    const [code, vk] = map[key] ?? [opts.code ?? key, opts.vk ?? key.toUpperCase().charCodeAt(0)];
    const base = {key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers};
    await this.send('Input.dispatchKeyEvent', {type: 'rawKeyDown', ...base, text: key.length === 1 && !opts.alt && !opts.ctrl ? key : undefined});
    if (key.length === 1 && !opts.alt && !opts.ctrl) await this.send('Input.dispatchKeyEvent', {type: 'char', ...base, text: key});
    await this.send('Input.dispatchKeyEvent', {type: 'keyUp', ...base});
  }
  async resize(width: number, height: number, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile});
  }
  async screenshot(path: string) {
    const {data} = await this.send('Page.captureScreenshot', {format: 'png'});
    await Bun.write(path, Buffer.from(data, 'base64'));
  }
  async offline(on: boolean) {
    await this.send('Network.emulateNetworkConditions', {offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
  }
}
