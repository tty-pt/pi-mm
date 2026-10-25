import { BASE_WORDS } from "./vocab_base.ts";

export const BASE_DELIMS: readonly string[] = [
  "  ", "    ", "        ", "\r\n", "\n\n", "/*", "*/", "->", "::",
  "==", "!=", "<=", ">=", "&&", "||", "//", "],", "},", "';", "\",",
  ": ", ", ", " - ", " = ", " — ", " – ", " -- ", " | ", " / ",
];

const wordToId = new Map<string, number>();
for (let i = 0; i < BASE_WORDS.length; i++) {
  wordToId.set(BASE_WORDS[i], 512 + i);
}

const delimToId = new Map<string, number>();
for (let i = 0; i < BASE_DELIMS.length; i++) {
  delimToId.set(BASE_DELIMS[i], 256 + i);
}

function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code >= 128 // UTF-8 multibyte
  );
}

/**
 * Encodes text into 16-bit token IDs losslessly.
 * Words matching the shared Auren Sepal vocabulary emit Word Token IDs (512..),
 * common delimiters emit Delimiter IDs (256..), and byte primitives (0..255)
 * handle arbitrary punctuation/unknown characters.
 * 100% bit-for-bit invertible with lemma_tok_decode() in liblemma.
 */
export function encodeTokens(text: string): Uint16Array {
  const bytes = new TextEncoder().encode(text);
  const out: number[] = [];
  let p = 0;

  while (p < bytes.length) {
    const c = bytes[p];

    if (isWordChar(c)) {
      const start = p;
      while (p < bytes.length && isWordChar(bytes[p])) {
        p++;
      }
      const wordBytes = bytes.subarray(start, p);
      const wordStr = new TextDecoder().decode(wordBytes);
      const tid = wordToId.get(wordStr);

      if (tid !== undefined) {
        out.push(tid);
      } else {
        // Subword longest prefix matching
        let w = 0;
        while (w < wordBytes.length) {
          let matchedSub = false;
          const remain = wordBytes.length - w;
          const maxLen = remain > 48 ? 48 : remain;
          for (let l = maxLen; l >= 2; l--) {
            const sub = new TextDecoder().decode(wordBytes.subarray(w, w + l));
            const subId = wordToId.get(sub);
            if (subId !== undefined) {
              out.push(subId);
              w += l;
              matchedSub = true;
              break;
            }
          }
          if (!matchedSub) {
            out.push(wordBytes[w++]);
          }
        }
      }
    } else {
      // Delimiter matching
      let matched = false;
      const remain = bytes.length - p;
      const maxLen = remain > 8 ? 8 : remain;

      for (let l = maxLen; l >= 2; l--) {
        const sub = new TextDecoder().decode(bytes.subarray(p, p + l));
        const dtid = delimToId.get(sub);
        if (dtid !== undefined) {
          out.push(dtid);
          p += l;
          matched = true;
          break;
        }
      }

      if (!matched) {
        out.push(bytes[p++]);
      }
    }
  }

  return new Uint16Array(out);
}

/**
 * Decodes 16-bit token IDs into the exact original text.
 */
export function decodeTokens(tokens: Uint16Array): string {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let totalLen = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tid = tokens[i];
    if (tid >= 512) {
      const idx = tid - 512;
      if (idx < BASE_WORDS.length) {
        const b = encoder.encode(BASE_WORDS[idx]);
        chunks.push(b);
        totalLen += b.length;
        continue;
      }
    } else if (tid >= 256) {
      const idx = tid - 256;
      if (idx < BASE_DELIMS.length) {
        const b = encoder.encode(BASE_DELIMS[idx]);
        chunks.push(b);
        totalLen += b.length;
        continue;
      }
    }

    // Byte primitive
    chunks.push(new Uint8Array([tid & 0xff]));
    totalLen += 1;
  }

  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(out);
}

export function packTokens(tokens: Uint16Array): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t < 0x80) {
      bytes.push(t);
    } else {
      bytes.push(0x80 | (t & 0x7f));
      bytes.push((t >> 7) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function unpackTokens(bytes: Uint8Array): Uint16Array {
  const tokens: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (!(b & 0x80)) {
      tokens.push(b);
    } else {
      if (i >= bytes.length) break;
      const b2 = bytes[i++];
      tokens.push((b & 0x7f) | (b2 << 7));
    }
  }
  return new Uint16Array(tokens);
}

export function isFfiActive(): boolean {
  return true;
}
