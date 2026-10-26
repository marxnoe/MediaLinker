// End-to-end encryption for shares, matching `ml send --encrypt` byte for byte.
//
// Ciphertext: "MLE1", then the plaintext in 64 KiB chunks, each sealed with AES-256-GCM. The nonce is
// an 11-byte big-endian chunk counter plus a flag byte that is 1 only on the last chunk (the STREAM
// construction age uses), so reordered, dropped or truncated chunks fail to decrypt.
// Plaintext: a 4-byte big-endian header length, a JSON header, then the content.
// The key is fresh per share and only ever travels in the link fragment, which browsers never send.

export interface Header {
  /** `text` or `file` for shares; the shared clipboard also seals `clip` and `pair` messages. */
  kind: string;
  name?: string;
  type?: string;
}

const MAGIC = 'MLE1';
const CHUNK = 64 * 1024;
const TAG = 16;
const KEY_BYTES = 32;

export class DecryptError extends Error {}

export async function newKey(): Promise<{ key: CryptoKey; encoded: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return { key: await importKey(raw), encoded: toBase64Url(raw) };
}

/** Turns the base64url key from a link or `CODE.KEY` into a CryptoKey, or null if it isn't one. */
export async function parseKey(encoded: string): Promise<CryptoKey | null> {
  const raw = fromBase64Url(encoded.trim());
  return raw?.length === KEY_BYTES ? importKey(raw) : null;
}

/** Pulls a key out of whatever was pasted: a full link, `CODE.KEY`, or the key on its own. */
export function findKey(input: string): string {
  const s = input.trim();
  const fragment = s.match(/#k=([A-Za-z0-9_-]+)/);
  if (fragment) return fragment[1];
  const token = s.match(/^[A-Za-z0-9]{5}\.([A-Za-z0-9_-]+)$/);
  return token ? token[1] : s;
}

export async function encrypt(key: CryptoKey, header: Header, content: Blob): Promise<Blob> {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.length);
  const plain = new Blob([length, json, content]);

  const parts: BlobPart[] = [new TextEncoder().encode(MAGIC)];
  for (let i = 0, start = 0; ; i++) {
    const end = Math.min(start + CHUNK, plain.size);
    const last = end === plain.size;
    const chunk = await plain.slice(start, end).arrayBuffer();
    parts.push(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(i, last) }, key, chunk));
    if (last) break;
    start = end;
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

export async function decrypt(
  key: CryptoKey,
  blob: Blob,
): Promise<{ header: Header; content: Blob }> {
  const magic = new TextDecoder().decode(await blob.slice(0, MAGIC.length).arrayBuffer());
  if (magic !== MAGIC) throw new DecryptError('This share is not in a format MediaLinker knows');
  const body = blob.slice(MAGIC.length);
  const count = Math.ceil(body.size / (CHUNK + TAG));
  if (count === 0) throw new DecryptError('The share is empty or damaged');

  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < count; i++) {
    const sealed = await body.slice(i * (CHUNK + TAG), (i + 1) * (CHUNK + TAG)).arrayBuffer();
    try {
      parts.push(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: nonce(i, i === count - 1) },
          key,
          sealed,
        ),
      );
    } catch {
      throw new DecryptError('Wrong key, or the share was damaged');
    }
  }

  const plain = new Blob(parts);
  const length = new DataView(await plain.slice(0, 4).arrayBuffer()).getUint32(0);
  let header: Header;
  try {
    header = JSON.parse(new TextDecoder().decode(await plain.slice(4, 4 + length).arrayBuffer()));
  } catch {
    throw new DecryptError('The share is damaged');
  }
  return { header, content: plain.slice(4 + length) };
}

function nonce(counter: number, last: boolean): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  // Bytes 0..10 hold the counter big-endian; JS numbers are exact far past any real chunk count.
  view.setUint32(3, Math.floor(counter / 2 ** 32));
  view.setUint32(7, counter >>> 0);
  iv[11] = last ? 1 : 0;
  return iv;
}

export function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
