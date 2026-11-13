/**
 * Deterministic single-pass character-stream lexical analyzer for code indexing.
 * Strictly zero regexes: uses pure charCodeAt state transitions.
 */

export type LexTokenKind = "ident" | "string" | "comment" | "punct";

export interface LexToken {
  kind: LexTokenKind;
  value: string;
  line: number;
  endLine: number;
  braceDepth: number;
  parenDepth: number;
}

export interface LexResult {
  tokens: LexToken[];
  lineOffsets: number[];
  lineCount: number;
  byteLength: number;
}

export function isAsciiAlpha(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
}

export function isAsciiDigit(ch: number): boolean {
  return ch >= 48 && ch <= 57;
}

export function isIdentStart(ch: number): boolean {
  return isAsciiAlpha(ch) || ch === 95 || ch === 36 || ch > 127;
}

export function isIdentPart(ch: number): boolean {
  return isIdentStart(ch) || isAsciiDigit(ch);
}

export function computeCodeLineOffsets(text: string): { lineOffsets: number[]; byteLength: number } {
  const offsets: number[] = [0];
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) offsets.push(i + 1);
  }
  return { lineOffsets: offsets, byteLength: bytes.length };
}

function scanLineComment(text: string, start: number): { end: number; value: string } {
  let i = start;
  while (i < text.length && text.charCodeAt(i) !== 10) i++;
  return { end: i, value: text.slice(start, i).trim() };
}

function scanBlockComment(text: string, start: number, startLine: number): { end: number; endLine: number; value: string } {
  let i = start + 2;
  let line = startLine;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 10) line++;
    if (ch === 42 && i + 1 < text.length && text.charCodeAt(i + 1) === 47) {
      i += 2;
      break;
    }
    i++;
  }
  return { end: i, endLine: line, value: text.slice(start, i) };
}

function scanStringLiteral(text: string, start: number, quote: number, startLine: number): { end: number; endLine: number; value: string } {
  let i = start + 1;
  let line = startLine;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 10) {
      line++;
      if (quote !== 96) { i++; break; }
    }
    if (ch === 92) { i += 2; continue; }
    if (ch === quote) { i++; break; }
    i++;
  }
  return { end: i, endLine: line, value: text.slice(start, i) };
}

function readPunctToken(text: string, idx: number): { end: number; value: string } {
  const ch = text.charCodeAt(idx);
  const next = idx + 1 < text.length ? text.charCodeAt(idx + 1) : 0;
  if ((ch === 61 && next === 62) || (ch === 45 && next === 62) || (ch === 58 && next === 58)) {
    return { end: idx + 2, value: text.slice(idx, idx + 2) };
  }
  return { end: idx + 1, value: text.charAt(idx) };
}

interface LexState {
  i: number;
  line: number;
  braceDepth: number;
  parenDepth: number;
}

function stepLexToken(text: string, st: LexState, isHashCommentLang: boolean, tokens: LexToken[]): void {
  const ch = text.charCodeAt(st.i);
  const next = st.i + 1 < text.length ? text.charCodeAt(st.i + 1) : 0;
  if ((ch === 47 && next === 47) || (ch === 35 && isHashCommentLang)) {
    const c = scanLineComment(text, st.i);
    tokens.push({ kind: "comment", value: c.value, line: st.line, endLine: st.line, braceDepth: st.braceDepth, parenDepth: st.parenDepth });
    st.i = c.end;
    return;
  }
  if (ch === 47 && next === 42) {
    const c = scanBlockComment(text, st.i, st.line);
    tokens.push({ kind: "comment", value: c.value, line: st.line, endLine: c.endLine, braceDepth: st.braceDepth, parenDepth: st.parenDepth });
    st.line = c.endLine;
    st.i = c.end;
    return;
  }
  if (ch === 34 || ch === 39 || ch === 96) {
    const s = scanStringLiteral(text, st.i, ch, st.line);
    tokens.push({ kind: "string", value: s.value, line: st.line, endLine: s.endLine, braceDepth: st.braceDepth, parenDepth: st.parenDepth });
    st.line = s.endLine;
    st.i = s.end;
    return;
  }
  if (isIdentStart(ch)) {
    let end = st.i + 1;
    while (end < text.length && isIdentPart(text.charCodeAt(end))) end++;
    tokens.push({ kind: "ident", value: text.slice(st.i, end), line: st.line, endLine: st.line, braceDepth: st.braceDepth, parenDepth: st.parenDepth });
    st.i = end;
    return;
  }
  if (isAsciiDigit(ch)) {
    let end = st.i + 1;
    while (end < text.length && (isAsciiDigit(text.charCodeAt(end)) || isIdentPart(text.charCodeAt(end)) || text.charCodeAt(end) === 46)) end++;
    st.i = end;
    return;
  }
  const p = readPunctToken(text, st.i);
  let tokenBrace = st.braceDepth;
  let tokenParen = st.parenDepth;
  if (ch === 123) st.braceDepth++;
  else if (ch === 125 && st.braceDepth > 0) tokenBrace = --st.braceDepth;
  else if (ch === 40) st.parenDepth++;
  else if (ch === 41 && st.parenDepth > 0) tokenParen = --st.parenDepth;
  tokens.push({ kind: "punct", value: p.value, line: st.line, endLine: st.line, braceDepth: tokenBrace, parenDepth: tokenParen });
  st.i = p.end;
}

export function tokenizeSource(text: string, isHashCommentLang = false): LexResult {
  const { lineOffsets, byteLength } = computeCodeLineOffsets(text);
  const tokens: LexToken[] = [];
  const st: LexState = { i: 0, line: 1, braceDepth: 0, parenDepth: 0 };
  while (st.i < text.length) {
    const ch = text.charCodeAt(st.i);
    if (ch === 10) { st.line++; st.i++; continue; }
    if (ch === 32 || ch === 9 || ch === 13) { st.i++; continue; }
    stepLexToken(text, st, isHashCommentLang, tokens);
  }
  const lineCount = text.length === 0 ? 0 : lineOffsets.length;
  return { tokens, lineOffsets, lineCount, byteLength };
}

export function splitIdentifierWords(ident: string): string[] {
  const words: string[] = [];
  let current = "";
  for (let i = 0; i < ident.length; i++) {
    const ch = ident.charCodeAt(i);
    if (ch === 95 || ch === 45 || ch === 46 || ch === 58 || ch === 47) {
      if (current.length >= 2) words.push(current.toLowerCase());
      current = "";
      continue;
    }
    const isUpper = ch >= 65 && ch <= 90;
    const prevCode = i > 0 ? ident.charCodeAt(i - 1) : 0;
    const prevLower = prevCode >= 97 && prevCode <= 122;
    if (isUpper && prevLower && current.length >= 2) {
      words.push(current.toLowerCase());
      current = String.fromCharCode(ch);
    } else {
      current += String.fromCharCode(ch);
    }
  }
  if (current.length >= 2) words.push(current.toLowerCase());
  return Array.from(new Set(words));
}

export function cleanCommentText(raw: string): string {
  const cleaned: string[] = [];
  for (const line of raw.split("\n")) {
    let s = line.trim();
    if (s.startsWith("/**")) s = s.slice(3);
    else if (s.startsWith("/*")) s = s.slice(2);
    if (s.endsWith("*/")) s = s.slice(0, -2);
    s = s.trim();
    if (s.startsWith("//")) s = s.slice(2).trim();
    else if (s.startsWith("#")) s = s.slice(1).trim();
    else if (s.startsWith("*")) s = s.slice(1).trim();
    if (s.length > 0) cleaned.push(s);
  }
  return cleaned.join(" ").slice(0, 240);
}

export function unquoteString(raw: string): string {
  if (raw.length >= 2) {
    const first = raw.charCodeAt(0);
    const last = raw.charCodeAt(raw.length - 1);
    if ((first === 34 || first === 39 || first === 96) && first === last) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}
