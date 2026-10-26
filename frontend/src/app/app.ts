import { HttpClient, HttpEventType } from '@angular/common/http';
import { Component, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  NaAlert,
  NaApp,
  NaButton,
  NaCard,
  NaCodeInput,
  NaField,
  NaHeading,
  NaInput,
  NaLink,
  NaPage,
  NaRadioGroup,
  NaRow,
  NaStack,
  NaSwitch,
  NaText,
  NaUpload,
  NaUploadChangeEvent,
} from 'newang';
import { firstValueFrom } from 'rxjs';
import { Cli } from './cli';
import { Clip } from './clip';
import { DecryptError, decrypt, encrypt, findKey, newKey, parseKey } from './e2e';

interface Config {
  maxMb: number;
  extensions: string[];
  shareTtls: string[];
  shareDefaultTtl: string;
}

type Result =
  { type: 'code'; code: string; expiresAt: number; key?: string } | { type: 'link'; url: string };

interface Share {
  code: string;
  kind: 'text' | 'file';
  text?: string;
  name?: string;
  mime?: string;
  size: number;
  expiresAt: number;
  url?: string;
  encrypted?: boolean;
  /** Where the download button points: the server, or a decrypted blob in this tab. */
  download?: string;
}

const CODE_LENGTH = 5;
const MAX_TEXT_BYTES = 1024 * 1024;
const TTL_LABELS: Record<string, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days' };

@Component({
  selector: 'app-root',
  imports: [
    Cli,
    Clip,
    FormsModule,
    NaAlert,
    NaApp,
    NaButton,
    NaCard,
    NaCodeInput,
    NaField,
    NaHeading,
    NaInput,
    NaLink,
    NaPage,
    NaRadioGroup,
    NaRow,
    NaStack,
    NaSwitch,
    NaText,
    NaUpload,
  ],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);

  // `#cli` shows the command line docs and `#clip` the shared clipboard; a hash keeps the server's
  // plain static file serving working, and keeps a pairing code in `#clip=CODE` off the server.
  protected readonly view = signal(viewOf(location.hash));

  protected readonly codeLength = CODE_LENGTH;
  protected readonly maxMb = signal(0);
  protected readonly extensions = signal<string[]>([]);
  protected readonly ttls = signal<{ value: string; label: string }[]>([]);

  // Receive
  private readonly codeInput = viewChild<NaCodeInput>('codeInput');
  protected readonly code = signal('');
  protected readonly opening = signal(false);
  protected readonly receiveError = signal('');
  protected readonly share = signal<Share | null>(null);
  /** An encrypted share that is waiting for its key. */
  protected readonly locked = signal<Share | null>(null);
  protected keyText = '';
  private key = '';

  // Send
  protected kind = 'file';
  protected mode = 'code';
  protected ttl = '24h';
  protected text = '';
  protected encrypted = false;
  protected readonly sendStatus = signal('');
  protected readonly sending = signal(false);
  protected readonly sendError = signal('');
  protected readonly result = signal<Result | null>(null);
  protected readonly copied = signal('');

  protected readonly kinds = [
    { value: 'file', label: 'File' },
    { value: 'text', label: 'Text' },
  ];

  protected readonly modes = [
    { value: 'code', label: 'Short code' },
    { value: 'link', label: 'Direct link' },
  ];

  protected readonly shareLink = computed(() => {
    const r = this.result();
    if (r?.type !== 'code') return '';
    return `${location.origin}/?code=${r.code}` + (r.key ? `#k=${r.key}` : '');
  });

  protected readonly preview = computed(() => {
    const mime = this.share()?.mime ?? '';
    return ['image', 'audio', 'video'].find((p) => mime.startsWith(p + '/')) ?? '';
  });

  ngOnInit() {
    addEventListener('hashchange', () => {
      this.view.set(viewOf(location.hash));
      scrollTo(0, 0);
    });

    this.http.get<Config>('/config').subscribe((c) => {
      this.maxMb.set(c.maxMb);
      this.extensions.set(c.extensions);
      this.ttls.set(c.shareTtls.map((t) => ({ value: t, label: TTL_LABELS[t] ?? t })));
      this.ttl = c.shareDefaultTtl;
    });

    // The key lives in the fragment so the browser never sends it to the server.
    this.key = location.hash.startsWith('#k=') ? location.hash.slice(3) : '';
    const code = new URLSearchParams(location.search).get('code');
    if (code) {
      this.code.set(code.trim().toUpperCase().slice(0, CODE_LENGTH));
      this.open();
    }
  }

  // ---- Receive ----

  protected open() {
    const code = this.code();
    if (code.length !== CODE_LENGTH || this.opening()) return;
    this.receiveError.set('');
    this.opening.set(true);
    this.http.get<Share>(`/share/${encodeURIComponent(code)}`).subscribe({
      next: (s) => {
        if (s.encrypted) {
          this.unlock(s);
          return;
        }
        this.share.set({ ...s, download: s.url && s.url + '?download=1' });
        this.opening.set(false);
        history.replaceState(null, '', `/?code=${s.code}`);
      },
      error: (e) => {
        this.receiveError.set(e.error?.error ?? 'Could not open that code');
        this.opening.set(false);
        // Let the person fix the code straight away.
        this.codeInput()?.focus();
      },
    });
  }

  /** Downloads and decrypts an encrypted share in this tab, or asks for the key if there is none. */
  protected async unlock(s: Share) {
    const key = this.key && (await parseKey(this.key));
    if (!key) {
      this.receiveError.set(this.key ? 'That key is not valid' : '');
      this.key = '';
      this.locked.set(s);
      this.opening.set(false);
      return;
    }
    this.opening.set(true);
    try {
      const blob = await firstValueFrom(
        this.http.get(`/s/${s.code}/file?download=1`, { responseType: 'blob' }),
      );
      const { header, content } = await decrypt(key, blob);
      const kind = header.kind === 'text' ? 'text' : 'file';
      const shared: Share = { ...s, kind, size: content.size };
      if (header.kind === 'text') {
        shared.text = await content.text();
      } else {
        shared.name = header.name || 'file';
        shared.mime = safeType(header.type || guessType(shared.name));
        shared.url = shared.download = URL.createObjectURL(
          content.slice(0, content.size, shared.mime),
        );
      }
      this.locked.set(null);
      this.receiveError.set('');
      this.share.set(shared);
      history.replaceState(null, '', `/?code=${s.code}#k=${this.key}`);
    } catch (e) {
      this.receiveError.set(
        e instanceof DecryptError
          ? e.message
          : ((e as { error?: { error?: string } }).error?.error ?? 'Could not download the share'),
      );
      this.locked.set(s);
    }
    this.opening.set(false);
  }

  protected submitKey() {
    const s = this.locked();
    if (!s || !this.keyText.trim() || this.opening()) return;
    this.key = findKey(this.keyText);
    this.keyText = '';
    this.unlock(s);
  }

  protected onCodeChange() {
    this.receiveError.set('');
  }

  protected closeShare() {
    const url = this.share()?.url;
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    this.share.set(null);
    this.locked.set(null);
    this.receiveError.set('');
    this.key = '';
    this.code.set('');
    history.replaceState(null, '', '/');
  }

  // ---- Send ----

  protected uploadAction() {
    return this.kind === 'file' && this.mode === 'link'
      ? '/upload'
      : `/share?ttl=${encodeURIComponent(this.ttl)}`;
  }

  protected accept() {
    return this.mode === 'link' ? this.extensions().join(',') : '';
  }

  protected canEncrypt() {
    return this.kind === 'text' || this.mode === 'code';
  }

  protected uploadHint() {
    if (this.mode === 'link') {
      return `Images, audio and video · max ${this.maxMb()} MB · the link never expires`;
    }
    return `Max ${this.maxMb()} MB · the code stops working when it expires`;
  }

  protected onUpload(e: NaUploadChangeEvent) {
    if (e.status === 'uploading') {
      this.sendError.set('');
      this.sending.set(true);
      return;
    }
    this.sending.set(false);
    const response = e.response as {
      url?: string;
      code?: string;
      expiresAt?: number;
      error?: string;
    } | null;
    if (e.status === 'done' && response?.code && response.expiresAt) {
      this.result.set({ type: 'code', code: response.code, expiresAt: response.expiresAt });
    } else if (e.status === 'done' && response?.url) {
      this.result.set({ type: 'link', url: response.url });
    } else {
      this.sendError.set(response?.error ?? e.error ?? 'Upload failed');
    }
  }

  protected onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.sendEncrypted({ kind: 'file', name: file.name, type: file.type }, file);
  }

  protected onDrop(e: DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file && !this.sending()) {
      this.sendEncrypted({ kind: 'file', name: file.name, type: file.type }, file);
    }
  }

  /** Encrypts in the browser and uploads ciphertext; the key goes only into the link we show. */
  private async sendEncrypted(
    header: { kind: 'text' | 'file'; name?: string; type?: string },
    content: Blob,
  ) {
    if (this.sending()) return;
    if (content.size > this.maxMb() * 1024 * 1024) {
      this.sendError.set(`File exceeds ${this.maxMb()} MB limit`);
      return;
    }
    this.sendError.set('');
    this.sending.set(true);
    this.sendStatus.set('Encrypting…');
    try {
      const { key, encoded } = await newKey();
      const body = new FormData();
      body.append('file', await encrypt(key, header, content), 'encrypted.bin');
      const url = `/share?ttl=${encodeURIComponent(this.ttl)}&encrypted=1`;
      const events = this.http.post<{ code: string; expiresAt: number }>(url, body, {
        reportProgress: true,
        observe: 'events',
      });
      await new Promise<void>((resolve, reject) =>
        events.subscribe({
          next: (ev) => {
            if (ev.type === HttpEventType.UploadProgress && ev.total) {
              this.sendStatus.set(`Uploading… ${Math.round((ev.loaded / ev.total) * 100)}%`);
            } else if (ev.type === HttpEventType.Response && ev.body) {
              const r = ev.body;
              this.result.set({ type: 'code', code: r.code, expiresAt: r.expiresAt, key: encoded });
            }
          },
          error: reject,
          complete: resolve,
        }),
      );
    } catch (e) {
      this.sendError.set(
        (e as { error?: { error?: string } }).error?.error ?? 'Could not encrypt and upload that',
      );
    }
    this.sending.set(false);
    this.sendStatus.set('');
  }

  protected sendText() {
    if (!this.text.trim() || this.sending()) return;
    if (this.encrypted) {
      const text = this.text.replace(/\r\n/g, '\n');
      if (new Blob([text]).size > MAX_TEXT_BYTES) {
        this.sendError.set('Text exceeds 1 MB limit');
        return;
      }
      this.sendEncrypted({ kind: 'text' }, new Blob([text]));
      return;
    }
    this.sendError.set('');
    this.sending.set(true);
    const body = new FormData();
    body.append('text', this.text);
    this.http
      .post<{ code: string; expiresAt: number }>(`/share?ttl=${encodeURIComponent(this.ttl)}`, body)
      .subscribe({
        next: (r) => {
          this.result.set({ type: 'code', code: r.code, expiresAt: r.expiresAt });
          this.sending.set(false);
        },
        error: (e) => {
          this.sendError.set(e.error?.error ?? 'Could not share the text');
          this.sending.set(false);
        },
      });
  }

  protected codeAndKey(r: { code: string; key?: string }) {
    return `${r.code}.${r.key}`;
  }

  protected sendAnother() {
    this.result.set(null);
    this.sendError.set('');
    this.text = '';
  }

  // ---- Helpers ----

  protected async copy(what: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      this.copied.set(what);
      setTimeout(() => this.copied.set(''), 1500);
    } catch {
      this.copied.set('');
    }
  }

  protected expiresIn(ms: number) {
    const minutes = Math.round((ms - Date.now()) / 60000);
    const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
    const relative =
      minutes < 60
        ? rtf.format(Math.max(minutes, 1), 'minute')
        : minutes < 48 * 60
          ? rtf.format(Math.round(minutes / 60), 'hour')
          : rtf.format(Math.round(minutes / 1440), 'day');
    const at = new Date(ms).toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `Expires ${relative} (${at})`;
  }

  protected size(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}

function viewOf(hash: string) {
  if (hash === '#cli') return 'cli';
  if (hash === '#clip' || hash.startsWith('#clip=')) return 'clip';
  return 'share';
}

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
};

/** `ml` doesn't know types, so encrypted shares from it carry only a name. */
function guessType(name: string) {
  return TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/**
 * The sender picks the type of an encrypted file, and a blob URL runs with this page's origin, so
 * only types that can't carry script (no SVG, no HTML) are kept for the preview.
 */
function safeType(type: string) {
  return /^(image\/(png|jpeg|gif|webp|avif|bmp)|audio\/[\w.+-]+|video\/[\w.+-]+)$/.test(type)
    ? type
    : 'application/octet-stream';
}
