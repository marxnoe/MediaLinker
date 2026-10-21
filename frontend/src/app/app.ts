import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
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
  NaTabs,
  NaText,
  NaUpload,
  NaUploadChangeEvent,
} from 'newang';

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
  protected readonly loading = signal(false);

  protected ytUrl = '';
  protected ytFormat = 'mp4';
  protected tab = 0;

  protected readonly formats = [
    { value: 'mp4', label: 'MP4 (video)' },
    { value: 'mp3', label: 'MP3 (audio)' },
  ];

  ngOnInit() {
    this.http
      .get<{ maxMb: number; extensions: string[] }>('/config')
      .subscribe((c) =>
        this.hint.set(`Max ${c.maxMb} MB · ${c.extensions.map((e) => e.slice(1)).join(', ')}`),
      );
  }

  protected onChange(e: NaUploadChangeEvent) {
    if (e.status === 'uploading') {
      this.url.set('');
      this.error.set('');
    } else if (e.status === 'done') {
      const response = e.response as { url?: string } | null;
      if (response?.url) {
        this.url.set(response.url);
      } else {
        this.error.set('Upload failed');
      }
    } else {
      this.error.set(e.error ?? 'Upload failed');
    }
  }

  protected convert() {
    this.url.set('');
    this.error.set('');
    this.loading.set(true);
    this.http
      .post<{ url: string }>('/youtube', { url: this.ytUrl, format: this.ytFormat })
      .subscribe({
        next: (r) => {
          this.url.set(r.url);
          this.loading.set(false);
        },
        error: (e) => {
          this.error.set(e.error?.error ?? 'Request failed');
          this.loading.set(false);
        },
      });
  }
}
