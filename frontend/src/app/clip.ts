import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NaAlert, NaButton, NaCard, NaField, NaInput, NaRow, NaStack, NaText } from 'newang';
import { blobKey, metaKey, newClipId, Pake, parseCode, plateOf, roomId } from './clip-keys';
import { decrypt, encrypt, fromBase64Url, toBase64Url } from './e2e';

/** What a clip is, sealed with its meta key. `ml clip` reads and writes the same JSON. */
interface Meta {
  kind: 'text' | 'image' | 'files';
  from?: string;
  text?: string;
  size: number;
  name?: string;
  type?: string;
  /** The blob is a zip of these top-level files and folders. */
  entries?: string[];
}

interface ServerClip {
  id: string;
  at: number;
  meta: string;
  blob: boolean;
}

type ServerMsg =
  | { t: 'hello'; now: number; clip: ServerClip | null; devices: number }
  | { t: 'clip'; clip: ServerClip }
  | { t: 'stale'; id: string; clip: ServerClip }
  | { t: 'devices'; n: number }
  | { t: 'error'; error: string }
  | { t: 'ended' }
  | { t: 'pong' };

/** The latest clip, as this page shows it. */
interface Shown {
  id: string;
  meta: Meta;
  mine: boolean;
  state: 'receiving' | 'ready' | 'failed';
  text?: string;
  blob?: Blob;
  url?: string;
  error?: string;
}

interface Saved {
  key: string;
  name: string;
}

// Session storage: the room survives reloads and the phone locking, and is forgotten with the tab.
const STORAGE = 'ml-clip';
/** Longer text goes as a blob, like in `ml`. */
const INLINE_TEXT = 32 * 1024;
const PING_EVERY = 10_000;
const DEAD_AFTER = 30_000;
const MAX_BACKOFF = 30_000;

function wsUrl(path: string) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad|Macintosh.*Mobile/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Web browser';
}

function loadSaved(): Saved | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE) ?? 'null') as Saved | null;
    return saved && fromBase64Url(saved.key)?.length === 32 ? saved : null;
  } catch {
    return null;
  }
}

function errorText(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Reads one pairing message at a time from a socket, failing on errors, a close, or a timeout. */
function inbox(ws: WebSocket) {
  const queue: Record<string, string>[] = [];
  let waiting: ((m: Record<string, string> | null) => void) | null = null;
  let closed = false;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (waiting) waiting(m);
    else queue.push(m);
  };
  ws.onclose = () => {
    closed = true;
    waiting?.(null);
  };
  return (timeout: number) =>
    new Promise<Record<string, string>>((resolve, reject) => {
      const settle = (m: Record<string, string> | null) => {
        waiting = null;
        clearTimeout(timer);
        if (!m) reject(new Error('The other device left'));
        else if (m['t'] === 'error') reject(new Error(m['error']));
        else resolve(m);
      };
      const timer = setTimeout(() => {
        waiting = null;
        reject(new Error('The other device took too long to answer'));
      }, timeout);
      const next = queue.shift();
      if (next) settle(next);
      else if (closed) settle(null);
      else waiting = settle;
    });
}

async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Cannot read that image'))),
      'image/png',
    ),
  );
}

/** The shared clipboard page: pairs this browser with `ml clip`, shows the latest clip, and lets a
 *  phone copy it or send its own clipboard, since phones can't sync in the background. */
@Component({
  selector: 'app-clip',
  imports: [FormsModule, NaAlert, NaButton, NaCard, NaField, NaInput, NaRow, NaStack, NaText],
  styleUrl: './clip.css',
  templateUrl: './clip.html',
})
export class Clip implements OnInit, OnDestroy {
  protected readonly saved = signal<Saved | null>(loadSaved());
  protected readonly status = signal<'offline' | 'connecting' | 'online'>('offline');
  protected readonly devices = signal(0);
  protected readonly shown = signal<Shown | null>(null);
  protected readonly notice = signal('');
  protected readonly error = signal('');
  protected readonly pairing = signal(false);
  protected readonly sending = signal(false);
  protected readonly copied = signal(false);
  protected codeText = '';
  protected typed = '';

  protected readonly others = computed(() => {
    const n = this.devices() - 1;
    return n <= 0
      ? 'no other device online'
      : n === 1
        ? '1 other device online'
        : `${n} other devices online`;
  });

  private roomKey: Uint8Array<ArrayBuffer> | null = null;
  private room = '';
  private ws: WebSocket | null = null;
  private heard = 0;
  private offset = 0;
  private backoff = 1000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private current: { id: string; at: number } | null = null;
  private pending: { id: string; meta: Meta; blob?: Blob } | null = null;
  private readonly wake = () => {
    // Phones freeze background tabs; coming back is the moment to check the connection.
    if (document.visibilityState === 'visible') this.reconnectIfStale();
  };
  private readonly online = () => this.reconnectIfStale();

  async ngOnInit() {
    document.addEventListener('visibilitychange', this.wake);
    addEventListener('online', this.online);
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY);
    const code = location.hash.startsWith('#clip=') ? location.hash.slice('#clip='.length) : '';
    if (code) {
      history.replaceState(null, '', '/#clip');
      this.codeText = decodeURIComponent(code);
      await this.join();
    } else {
      await this.start();
    }
  }

  ngOnDestroy() {
    document.removeEventListener('visibilitychange', this.wake);
    removeEventListener('online', this.online);
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.disconnect();
    this.revoke();
  }

  // ---- Pairing ----

  protected async join() {
    const code = parseCode(this.codeText);
    if (!code) {
      this.error.set('That is not a pairing code. They look like K7X-42PQ.');
      return;
    }
    this.error.set('');
    this.pairing.set(true);
    const ws = new WebSocket(wsUrl('/clip/pair'));
    try {
      const next = inbox(ws);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('Cannot reach the server'));
      });
      ws.send(JSON.stringify({ t: 'join', plate: plateOf(code) }));
      const start = await next(30_000);
      const pake = await Pake.start(code, start['sid']);
      ws.send(JSON.stringify({ t: 'msg', data: toBase64Url(pake.publicKey) }));
      const host = fromBase64Url((await next(30_000))['data']);
      if (host?.length !== 32) throw new Error('The other device sent a broken pairing message');
      const keys = await pake.finish(host);
      const sealed = fromBase64Url((await next(30_000))['data']) ?? new Uint8Array();
      let welcome: { key: string; from: string };
      try {
        const { header, content } = await decrypt(keys.toJoiner, new Blob([sealed]));
        if (header.kind !== 'pair') throw new Error();
        welcome = JSON.parse(await content.text());
        if (fromBase64Url(welcome.key)?.length !== 32) throw new Error();
      } catch {
        throw new Error('Wrong code. Check it and try again (the other device shows a new one).');
      }
      const name = deviceName();
      const thanks = await encrypt(
        keys.toHost,
        { kind: 'pair' },
        new Blob([JSON.stringify({ name })]),
      );
      const thanksBytes = new Uint8Array(await thanks.arrayBuffer());
      ws.send(JSON.stringify({ t: 'msg', data: toBase64Url(thanksBytes) }));
      const saved = { key: welcome.key, name };
      sessionStorage.setItem(STORAGE, JSON.stringify(saved));
      this.saved.set(saved);
      this.codeText = '';
      this.notice.set(`Paired with ${welcome.from}.`);
      this.current = null;
      this.shown.set(null);
      await this.start();
    } catch (e) {
      this.error.set(errorText(e, 'Pairing failed'));
    } finally {
      this.pairing.set(false);
      // Give the last message a moment to leave before closing.
      setTimeout(() => ws.close(), 1000);
    }
  }

  protected forget(notice = 'This browser left the room. Your other devices stay paired.') {
    sessionStorage.removeItem(STORAGE);
    this.saved.set(null);
    this.roomKey = null;
    this.disconnect();
    this.revoke();
    this.shown.set(null);
    this.current = null;
    this.pending = null;
    this.notice.set(notice);
  }

  // ---- Connection ----

  private async start() {
    const saved = this.saved();
    if (!saved) return;
    this.roomKey = fromBase64Url(saved.key);
    this.room = await roomId(this.roomKey!);
    this.connect();
  }

  private connect() {
    if (!this.roomKey || this.ws) return;
    clearTimeout(this.retryTimer);
    this.status.set('connecting');
    const ws = new WebSocket(wsUrl(`/clip/ws?room=${this.room}`));
    this.ws = ws;
    this.heard = Date.now();
    ws.onmessage = (e) => {
      this.heard = Date.now();
      this.onServer(JSON.parse(e.data) as ServerMsg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status.set('offline');
      this.retryTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    };
  }

  private disconnect() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.status.set('offline');
  }

  private reconnectIfStale() {
    if (!this.roomKey) return;
    if (!this.ws || Date.now() - this.heard > DEAD_AFTER / 2) {
      this.disconnect();
      this.backoff = 1000;
      this.connect();
    }
  }

  private ping() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.heard > DEAD_AFTER) {
      // The socket looks open but nothing comes through: start over.
      this.reconnectIfStale();
      return;
    }
    this.ws.send('{"t":"ping"}');
  }

  private onServer(msg: ServerMsg) {
    switch (msg.t) {
      case 'hello':
        this.status.set('online');
        this.backoff = 1000;
        this.offset = msg.now - Date.now();
        this.devices.set(msg.devices);
        if (msg.clip) this.onClip(msg.clip);
        break;
      case 'clip':
        this.onClip(msg.clip);
        break;
      case 'stale':
        if (msg.clip.id !== msg.id && this.pending?.id === msg.id) {
          this.pending = null;
          this.current = null;
          this.notice.set('Another device copied something newer first.');
        }
        this.onClip(msg.clip);
        break;
      case 'devices':
        this.devices.set(msg.n);
        break;
      case 'ended':
        this.forget(
          'A computer stopped syncing, so the room ended. Run ml clip sync to start a new one.',
        );
        break;
      case 'error':
        this.error.set(msg.error);
        break;
    }
  }

  private async onClip(c: ServerClip) {
    const cur = this.current;
    if (cur?.id === c.id) {
      cur.at = c.at;
      const p = this.pending;
      if (p?.id === c.id) {
        this.pending = null;
        if (p.blob) this.upload(c.id, p.meta, p.blob);
      }
      return;
    }
    if (cur && (c.at < cur.at || (c.at === cur.at && c.id <= cur.id))) return;
    this.current = { id: c.id, at: c.at };
    this.pending = null;
    let meta: Meta;
    try {
      const sealed = fromBase64Url(c.meta) ?? new Uint8Array();
      const { header, content } = await decrypt(
        await metaKey(this.roomKey!, c.id),
        new Blob([sealed]),
      );
      if (header.kind !== 'clip') throw new Error();
      meta = JSON.parse(await content.text());
    } catch {
      this.show({
        id: c.id,
        meta: { kind: 'text', size: 0 },
        mine: false,
        state: 'failed',
        error: "This browser can't decrypt the latest clip.",
      });
      return;
    }
    if (this.current?.id !== c.id) return;
    if (meta.kind === 'text' && meta.text !== undefined) {
      this.show({ id: c.id, meta, mine: false, state: 'ready', text: meta.text });
    } else if (c.blob) {
      this.show({ id: c.id, meta, mine: false, state: 'receiving' });
      this.download(c.id, meta);
    }
  }

  private async download(id: string, meta: Meta) {
    let wait = 1000;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (this.current?.id !== id) return;
      try {
        const res = await fetch(`/clip/${this.room}/blob/${id}`, { cache: 'no-store' });
        if (res.status === 404) throw new Error('A newer clip replaced this one');
        if (!res.ok) throw new Error(`Server answered ${res.status}`);
        const { content } = await decrypt(await blobKey(this.roomKey!, id), await res.blob());
        if (this.current?.id !== id) return;
        const type = meta.kind === 'image' ? 'image/png' : meta.type || 'application/octet-stream';
        const blob = content.slice(0, content.size, type);
        const shown: Shown = { id, meta, mine: false, state: 'ready', blob };
        if (meta.kind === 'text') shown.text = (await blob.text()).replace(/\r\n/g, '\n');
        else shown.url = URL.createObjectURL(blob);
        this.show(shown);
        return;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('A newer clip')) break;
      }
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
    if (this.current?.id === id) {
      this.show({ id, meta, mine: false, state: 'failed', error: 'Could not receive this clip.' });
    }
  }

  private show(s: Shown) {
    this.revoke();
    this.copied.set(false);
    this.shown.set(s);
  }

  private revoke() {
    const url = this.shown()?.url;
    if (url) URL.revokeObjectURL(url);
  }

  // ---- Sending ----

  private async send(meta: Meta, blob?: Blob) {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.roomKey) {
      this.error.set('Not connected yet. Try again in a moment.');
      return;
    }
    this.error.set('');
    this.notice.set('');
    this.sending.set(true);
    try {
      const id = newClipId();
      const at = Date.now() + this.offset;
      meta.from = this.saved()?.name;
      const sealed = await encrypt(
        await metaKey(this.roomKey, id),
        { kind: 'clip' },
        new Blob([JSON.stringify(meta)]),
      );
      this.current = { id, at };
      this.pending = { id, meta, blob };
      const shown: Shown = { id, meta, mine: true, state: 'ready', text: meta.text, blob };
      if (blob && meta.kind !== 'text') shown.url = URL.createObjectURL(blob);
      if (blob && meta.kind === 'text') shown.text = await blob.text();
      this.show(shown);
      const metaB64 = toBase64Url(new Uint8Array(await sealed.arrayBuffer()));
      this.ws.send(JSON.stringify({ t: 'clip', id, at, meta: metaB64, blob: !!blob }));
    } catch (e) {
      this.error.set(errorText(e, 'Could not send that'));
    }
    this.sending.set(false);
  }

  private async upload(id: string, meta: Meta, blob: Blob) {
    this.sending.set(true);
    try {
      const header = { kind: 'file', name: meta.name, type: meta.type };
      const body = await encrypt(await blobKey(this.roomKey!, id), header, blob);
      const res = await fetch(`/clip/${this.room}/blob/${id}`, { method: 'PUT', body });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? `Server answered ${res.status}`);
      }
    } catch (e) {
      if (this.current?.id === id) this.error.set(errorText(e, 'Upload failed'));
    }
    this.sending.set(false);
  }

  protected async sendText(text: string) {
    text = text.replace(/\r\n/g, '\n');
    if (!text) return;
    const size = new Blob([text]).size;
    if (size <= INLINE_TEXT) {
      await this.send({ kind: 'text', text, size });
    } else {
      const meta: Meta = { kind: 'text', size, name: 'clipboard.txt', type: 'text/plain' };
      await this.send(meta, new Blob([text], { type: 'text/plain' }));
    }
  }

  protected async sendTyped() {
    const text = this.typed;
    this.typed = '';
    await this.sendText(text);
  }

  /** Reads this device's clipboard (the browser asks first) and sends it to the room. */
  protected async paste() {
    this.error.set('');
    try {
      if (navigator.clipboard.read) {
        for (const item of await navigator.clipboard.read()) {
          const image = item.types.find((t) => t.startsWith('image/'));
          if (image) {
            let blob = await item.getType(image);
            if (image !== 'image/png') blob = await toPng(blob);
            await this.send(
              { kind: 'image', size: blob.size, name: 'image.png', type: 'image/png' },
              blob,
            );
            return;
          }
          if (item.types.includes('text/plain')) {
            await this.sendText(await (await item.getType('text/plain')).text());
            return;
          }
        }
        this.error.set(
          'The clipboard is empty, or holds something only text and images can stand in for.',
        );
      } else {
        await this.sendText(await navigator.clipboard.readText());
      }
    } catch {
      this.error.set(
        "This browser didn't let the page read the clipboard. Type or paste into the box below instead.",
      );
    }
  }

  protected async pick(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      this.error.set('Clips are limited to 100 MB.');
      return;
    }
    await this.send(
      { kind: 'files', size: file.size, name: file.name, type: file.type || undefined },
      file,
    );
  }

  /** Puts the latest clip on this device's clipboard. */
  protected async copy() {
    const s = this.shown();
    if (!s || s.state !== 'ready') return;
    try {
      if (s.text !== undefined) {
        await navigator.clipboard.writeText(s.text);
      } else if (s.blob && s.meta.kind === 'image') {
        await navigator.clipboard.write([new ClipboardItem({ [s.blob.type]: s.blob })]);
      } else {
        return;
      }
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      this.error.set("This browser didn't let the page write to the clipboard.");
    }
  }

  protected describe(s: Shown) {
    const m = s.meta;
    if (m.kind === 'text') return 'Text';
    if (m.kind === 'image') return 'Image';
    if (m.entries && m.entries.length > 1) return `${m.entries.length} files`;
    return m.entries?.[0] ?? m.name ?? 'File';
  }

  protected size(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}
