/** Byte helpers with no Buffer/atob dependency (Hermes-safe). */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_INDEX[clean.charCodeAt(i)] ?? -1;
    if (v < 0) throw new Error('invalid base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.slice(0, o);
}

export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    let cp = 0;
    let need = 0;
    if (b >= 0xc2 && b <= 0xdf) {
      cp = b & 0x1f;
      need = 1;
    } else if (b >= 0xe0 && b <= 0xef) {
      cp = b & 0x0f;
      need = 2;
    } else if (b >= 0xf0 && b <= 0xf4) {
      cp = b & 0x07;
      need = 3;
    } else {
      out += '\ufffd';
      i++;
      continue;
    }
    if (i + need >= bytes.length) {
      // Incomplete tail: one replacement for the whole malformed prefix.
      out += '\ufffd';
      break;
    }
    let ok = true;
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (c & 63);
    }
    if (!ok || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += '\ufffd';
      i++;
      continue;
    }
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

/** Incremental UTF-8 decoder: a code point split across chunks stays intact. */
export class Utf8Stream {
  private tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  push(chunk: Uint8Array): string {
    if (this.tail.length === 0) {
      const [text, rest] = splitComplete(chunk);
      this.tail = rest;
      return text;
    }
    const joined = new Uint8Array(this.tail.length + chunk.length);
    joined.set(this.tail);
    joined.set(chunk, this.tail.length);
    const [text, rest] = splitComplete(joined);
    this.tail = rest;
    return text;
  }

  reset(): void {
    this.tail = new Uint8Array(0);
  }
}

function splitComplete(bytes: Uint8Array): [string, Uint8Array] {
  let end = bytes.length;
  // Walk back at most 3 bytes to include an incomplete trailing sequence.
  for (let start = Math.max(0, bytes.length - 4); start < bytes.length; start++) {
    const b = bytes[start];
    if (b < 0x80) continue;
    let need = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
    if (!need) continue;
    if (start + need >= bytes.length) {
      end = start;
      break;
    }
  }
  return [decodeUtf8(bytes.subarray(0, end)), bytes.subarray(end)];
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
