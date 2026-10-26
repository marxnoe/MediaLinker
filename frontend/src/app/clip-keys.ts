// Keys for the shared clipboard, matching `ml clip` byte for byte.
//
// A room key is 32 random bytes that only the paired devices hold. The server knows the room by an
// ID derived from it, and every clip is sealed in the MLE1 format of e2e.ts under keys derived from
// the room key and the clip's random ID.
//
// Pairing codes look like K7X-42PQ: the server picks the first three characters to put two devices
// in touch, and the rest never leaves them. The devices run CPace over ristretto255, so only one
// that knows the whole code ends up with the same session key, and the server gets at most one
// guess per pairing.

import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { importKey, toBase64Url } from './e2e';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PLATE_LEN = 3;
const CODE_LEN = 7;
/** The order of the ristretto255 group. */
const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

const text = (s: string) => new TextEncoder().encode(s);

/** Takes K7X-42PQ in any case, with or without the dash, or a link ending in #clip=CODE. */
export function parseCode(input: string): string | null {
  const raw = input.trim().split('#clip=').pop() ?? '';
  const code = raw.replace(/[-\s]/g, '').toUpperCase();
  return code.length === CODE_LEN && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

export function showCode(code: string) {
  return `${code.slice(0, PLATE_LEN)}-${code.slice(PLATE_LEN)}`;
}

export function plateOf(code: string) {
  return code.slice(0, PLATE_LEN);
}

async function hmac(key: Uint8Array<ArrayBuffer>, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, text(label)));
}

export async function roomId(roomKey: Uint8Array<ArrayBuffer>) {
  return toBase64Url((await hmac(roomKey, 'ml-clip room')).slice(0, 16));
}

export async function metaKey(roomKey: Uint8Array<ArrayBuffer>, clipId: string) {
  return importKey(await hmac(roomKey, `ml-clip meta ${clipId}`));
}

export async function blobKey(roomKey: Uint8Array<ArrayBuffer>, clipId: string) {
  return importKey(await hmac(roomKey, `ml-clip blob ${clipId}`));
}

export function newClipId() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function littleEndian(bytes: Uint8Array) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/** One side of a CPace exchange. */
export class Pake {
  private constructor(
    private readonly scalar: bigint,
    private readonly sid: string,
    readonly publicKey: Uint8Array,
  ) {}

  static async start(code: string, sid: string): Promise<Pake> {
    const seed = concat(text('ml-clip pake v1\0'), text(sid), text('\0'), text(code));
    const uniform = new Uint8Array(await crypto.subtle.digest('SHA-512', seed));
    const generator = ristretto255_hasher.deriveToCurve!(uniform);
    let scalar = 0n;
    while (scalar === 0n) {
      scalar = littleEndian(crypto.getRandomValues(new Uint8Array(64))) % ORDER;
    }
    return new Pake(scalar, sid, generator.multiply(scalar).toBytes());
  }

  /** Mixes in the host's share; a wrong code gives keys that don't match rather than an error. */
  async finish(host: Uint8Array) {
    const theirs = ristretto255.Point.fromBytes(host);
    if (theirs.is0()) throw new Error('The other device sent a broken pairing message');
    const shared = theirs.multiply(this.scalar).toBytes();
    const transcript = concat(
      text('ml-clip pake v1 key\0'),
      text(this.sid),
      host,
      this.publicKey,
      shared,
    );
    const session = new Uint8Array(await crypto.subtle.digest('SHA-256', transcript));
    return {
      toJoiner: await importKey(await hmac(session, 'ml-clip host to joiner')),
      toHost: await importKey(await hmac(session, 'ml-clip joiner to host')),
    };
  }
}
