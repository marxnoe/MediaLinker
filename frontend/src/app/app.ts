import { HttpClient } from '@angular/common/http';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  NaAlert,
  NaApp,
  NaButton,
  NaCard,
  NaField,
  NaHeading,
  NaInput,
  NaLink,
  NaPage,
  NaRadioGroup,
  NaStack,
  NaTab,
  NaTabKey,
  NaTabs,
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

interface Created {
  code: string;
  expiresAt: number;
}

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

const TTL_LABELS: Record<string, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days' };

@Component({
  selector: 'app-root',
  imports: [
    FormsModule,
    NaAlert,
    NaApp,
    NaButton,
    NaCard,
    NaField,
    NaHeading,
    NaInput,
    NaLink,
    NaPage,
    NaRadioGroup,
    NaStack,
    NaTab,
    NaTabs,
    NaText,
    NaUpload,
  ],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly url = signal('');
  protected readonly error = signal('');
  protected readonly hint = signal('');
  protected readonly maxMb = signal(0);
  protected readonly loading = signal(false);

  protected readonly created = signal<Created | null>(null);
  protected readonly share = signal<Share | null>(null);
  protected readonly ttls = signal<{ value: string; label: string }[]>([]);

  protected tab: NaTabKey | null = 'upload';
  protected shareKind = 'file';
  protected shareTtl = '24h';
  protected shareText = '';
  protected code = '';

  protected readonly shareKinds = [
    { value: 'file', label: 'File' },
    { value: 'text', label: 'Text' },
  ];

  protected readonly shareLink = computed(() => {
    const c = this.created();
    return c ? `${location.origin}/?code=${c.code}` : '';
  });

  protected readonly preview = computed(() => {
    const mime = this.share()?.mime ?? '';
    return ['image', 'audio', 'video'].find((p) => mime.startsWith(p + '/')) ?? '';
  });

  ngOnInit() {
    this.http.get<Config>('/config').subscribe((c) => {
      this.maxMb.set(c.maxMb);
      this.hint.set(`Max ${c.maxMb} MB · ${c.extensions.map((e) => e.slice(1)).join(', ')}`);
      this.ttls.set(c.shareTtls.map((t) => ({ value: t, label: TTL_LABELS[t] ?? t })));
      this.shareTtl = c.shareDefaultTtl;
    });

    const code = new URLSearchParams(location.search).get('code');
    if (code) {
      this.tab = 'code';
      this.code = code;
      this.open();
    }
  }

  protected shareAction() {
    return `/share?ttl=${encodeURIComponent(this.shareTtl)}`;
  }

  private reset() {
    this.url.set('');
    this.error.set('');
    this.created.set(null);
    this.share.set(null);
  }

  protected onChange(e: NaUploadChangeEvent) {
    if (e.status === 'uploading') {
      this.reset();
    } else if (e.status === 'done') {
      const response = e.response as { url?: string } | null;
      if (response?.url) {
        this.url.set(response.url);
      } else {
        this.error.set('Upload failed');
      }
    } else {
      this.error.set(
        (e.response as { error?: string } | null)?.error ?? e.error ?? 'Upload failed',
      );
    }
  }

  protected onShareChange(e: NaUploadChangeEvent) {
    if (e.status === 'uploading') {
      this.reset();
    } else if (e.status === 'done') {
      const response = e.response as Created | null;
      if (response?.code) {
        this.created.set(response);
      } else {
        this.error.set('Upload failed');
      }
    } else {
      this.error.set(
        (e.response as { error?: string } | null)?.error ?? e.error ?? 'Upload failed',
      );
    }
  }

  protected shareTextNow() {
    this.reset();
    this.loading.set(true);
    const body = new FormData();
    body.append('text', this.shareText);
    this.http.post<Created>(this.shareAction(), body).subscribe({
      next: (r) => {
        this.created.set(r);
        this.loading.set(false);
      },
      error: (e) => this.fail(e),
    });
  }

  protected open() {
    const code = this.code.trim().toUpperCase();
    if (!code) return;
    this.reset();
    this.loading.set(true);
    this.http.get<Share>(`/share/${encodeURIComponent(code)}`).subscribe({
      next: (s) => {
        this.share.set(s);
        this.loading.set(false);
        history.replaceState(null, '', `/?code=${s.code}`);
      },
      error: (e) => this.fail(e),
    });
  }

  private fail(e: { error?: { error?: string } }) {
    this.error.set(e.error?.error ?? 'Request failed');
    this.loading.set(false);
  }

  protected copy(text: string) {
    navigator.clipboard?.writeText(text);
  }

  protected expires(ms: number) {
    return new Date(ms).toLocaleString();
  }

  protected size(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}
