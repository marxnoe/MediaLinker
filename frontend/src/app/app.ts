import { HttpClient } from '@angular/common/http';
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
  NaText,
  NaUpload,
  NaUploadChangeEvent,
} from 'newang';

interface Config {
  maxMb: number;
  extensions: string[];
  shareTtls: string[];
  shareDefaultTtl: string;
}

type Result = { type: 'code'; code: string; expiresAt: number } | { type: 'link'; url: string };

interface Share {
  code: string;
  kind: 'text' | 'file';
  text?: string;
  name?: string;
  mime?: string;
  size: number;
  expiresAt: number;
  url?: string;
}

const CODE_LENGTH = 5;
const TTL_LABELS: Record<string, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days' };

@Component({
  selector: 'app-root',
  imports: [
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
    NaText,
    NaUpload,
  ],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);

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

  // Send
  protected kind = 'file';
  protected mode = 'code';
  protected ttl = '24h';
  protected text = '';
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
    return r?.type === 'code' ? `${location.origin}/?code=${r.code}` : '';
  });

  protected readonly preview = computed(() => {
    const mime = this.share()?.mime ?? '';
    return ['image', 'audio', 'video'].find((p) => mime.startsWith(p + '/')) ?? '';
  });

  ngOnInit() {
    this.http.get<Config>('/config').subscribe((c) => {
      this.maxMb.set(c.maxMb);
      this.extensions.set(c.extensions);
      this.ttls.set(c.shareTtls.map((t) => ({ value: t, label: TTL_LABELS[t] ?? t })));
      this.ttl = c.shareDefaultTtl;
    });

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
        this.share.set(s);
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

  protected onCodeChange() {
    this.receiveError.set('');
  }

  protected closeShare() {
    this.share.set(null);
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

  protected sendText() {
    if (!this.text.trim() || this.sending()) return;
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
