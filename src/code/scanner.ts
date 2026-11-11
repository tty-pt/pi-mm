/**
 * Deterministic structural code scanner (src/code/scanner.ts).
 * Zero regexes: uses token stream and brace/line state transitions.
 */

import type { CodeSymbolKind, ScannedFileResult, ScannedSymbol } from "./types.ts";
import { cleanCommentText, type LexToken, tokenizeSource, unquoteString } from "./lexer.ts";

const CONTROL_KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "try", "catch", "finally", "throw", "new", "delete",
  "typeof", "sizeof", "alignof", "instanceof", "in", "of", "void", "yield",
  "await", "import", "export", "from", "as", "static", "const", "let", "var",
  "public", "private", "protected", "readonly", "abstract", "async", "function",
  "class", "interface", "type", "enum", "struct", "typedef", "union", "extern",
  "inline", "register", "volatile", "unsigned", "signed", "short", "long",
  "super", "this", "self", "fn", "func", "def", "pub", "mod", "use", "impl",
  "where", "match", "loop", "elif", "except", "with", "assert", "pass",
]);

const STDLIB_CALLEE_DENYLIST = new Set([
  "malloc", "calloc", "realloc", "free", "strdup", "strndup",
  "memcpy", "memmove", "memset", "memcmp",
  "strlen", "strcmp", "strncmp", "strcpy", "strncpy", "strcat", "strncat", "strchr", "strrchr", "strstr",
  "printf", "fprintf", "sprintf", "snprintf", "vsnprintf", "perror", "puts", "fputs",
  "fopen", "fclose", "fread", "fwrite", "fflush", "fseek", "ftell",
  "atoi", "atol", "atof", "strtol", "strtoul", "strtod", "exit", "abort", "qsort", "bsearch",
  "String", "Number", "Boolean", "Array", "Object", "Map", "Set", "Promise", "Error", "RegExp",
  "parseInt", "parseFloat", "isNaN", "isFinite", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "len", "range", "print", "isinstance", "getattr", "setattr", "hasattr", "dict", "list", "set", "tuple", "int", "str", "float", "bool",
]);

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

function findMatchingBraceEnd(tokens: LexToken[], openIdx: number): { endIdx: number; endLine: number } {
  const targetDepth = tokens[openIdx].braceDepth;
  for (let i = openIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "punct" && t.value === "}" && t.braceDepth === targetDepth) {
      return { endIdx: i, endLine: t.endLine };
    }
  }
  const last = tokens[tokens.length - 1];
  return { endIdx: tokens.length - 1, endLine: last ? last.endLine : tokens[openIdx].endLine };
}

function findMatchingParenEnd(tokens: LexToken[], openIdx: number): number {
  const targetDepth = tokens[openIdx].parenDepth;
  for (let i = openIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "punct" && t.value === ")" && t.parenDepth === targetDepth) return i;
  }
  return Math.min(openIdx + 1, tokens.length - 1);
}

function findStatementEndLine(tokens: LexToken[], startIdx: number): { endIdx: number; endLine: number } {
  const startBrace = tokens[startIdx].braceDepth;
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "punct" && t.value === "{" && t.braceDepth === startBrace) return findMatchingBraceEnd(tokens, i);
    if (t.kind === "punct" && t.value === ";" && t.braceDepth === startBrace && t.parenDepth === 0) {
      return { endIdx: i, endLine: t.endLine };
    }
  }
  return { endIdx: startIdx, endLine: tokens[startIdx].endLine };
}

function extractLeadingDoc(tokens: LexToken[], idx: number, declLine: number): string | undefined {
  for (let i = idx - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.endLine < declLine - 2) break;
    if (t.kind === "comment") {
      const cleaned = cleanCommentText(t.value);
      return cleaned.length > 0 ? cleaned : undefined;
    }
    if (t.line < declLine && t.kind !== "ident" && t.value !== "@") break;
  }
  return undefined;
}

function collectCalleesInRange(tokens: LexToken[], startIdx: number, endIdx: number, selfName: string): string[] {
  const callees: string[] = [];
  const seen = new Set<string>();
  for (let i = startIdx; i <= endIdx && i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (t.kind === "ident" && tokens[i + 1].kind === "punct" && tokens[i + 1].value === "(") {
      if (i > 0 && tokens[i - 1].value === "->") continue;
      if (
        t.value !== selfName &&
        !CONTROL_KEYWORDS.has(t.value) &&
        !STDLIB_CALLEE_DENYLIST.has(t.value) &&
        !seen.has(t.value)
      ) {
        seen.add(t.value);
        callees.push(t.value);
      }
    }
  }
  return callees;
}

function extractImports(tokens: LexToken[]): string[] {
  const imports: string[] = [];
  const seen = new Set<string>();
  const addImport = (val: string) => {
    const clean = unquoteString(val).trim();
    if (clean && !seen.has(clean)) { seen.add(clean); imports.push(clean); }
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "punct" && t.value === "#" && i + 2 < tokens.length && tokens[i + 1].value === "include") {
      const target = tokens[i + 2];
      if (target.kind === "string") addImport(target.value);
      else if (target.value === "<") {
        let path = "";
        for (let j = i + 3; j < tokens.length && tokens[j].value !== ">" && tokens[j].line === t.line; j++) path += tokens[j].value;
        if (path) addImport(path);
      }
    }
    if (t.kind === "ident" && (t.value === "import" || t.value === "export")) {
      for (let j = i + 1; j < Math.min(i + 30, tokens.length); j++) {
        if (tokens[j].kind === "string" && (tokens[j - 1]?.value === "from" || tokens[j - 1]?.value === "import")) {
          addImport(tokens[j].value);
          break;
        }
        if (tokens[j].value === ";" || (tokens[j].value === "{" && j > i + 2)) break;
      }
    }
    if (t.kind === "ident" && (t.value === "xy_load" || t.value === "require") && i + 2 < tokens.length) {
      if (tokens[i + 1].value === "(" && tokens[i + 2].kind === "string") addImport(tokens[i + 2].value);
    }
  }
  return imports;
}

function buildSignatureLine(sourceLines: string[], startLine: number, endLine: number): string {
  const first = (sourceLines[startLine - 1] || "").trim();
  const second = startLine < endLine ? (sourceLines[startLine] || "").trim() : "";
  const combined = (!first.includes("(") && second.includes("(")) ? `${first} ${second}` : first;
  const openBrace = combined.indexOf("{");
  return (openBrace > 0 ? combined.slice(0, openBrace).trim() : combined).slice(0, 180);
}

function tryParseXyMacro(tokens: LexToken[], idx: number, filePath: string, sourceLines: string[]): { symbol: ScannedSymbol; nextIdx: number } | null {
  const t = tokens[idx];
  if (t.kind !== "ident" || (t.value !== "XY_DECL" && t.value !== "XY_IMPL")) return null;
  if (idx + 4 >= tokens.length || tokens[idx + 1].value !== "(") return null;
  const parenEnd = findMatchingParenEnd(tokens, idx + 1);
  let commaCount = 0;
  let funcName = "";
  for (let i = idx + 2; i < parenEnd; i++) {
    if (tokens[i].value === "," && tokens[i].parenDepth === tokens[idx + 1].parenDepth + 1) {
      if (++commaCount === 1 && i + 1 < parenEnd && tokens[i + 1].kind === "ident") {
        funcName = tokens[i + 1].value;
        break;
      }
    }
  }
  if (!funcName) return null;
  const stmt = findStatementEndLine(tokens, parenEnd);
  let openBraceIdx = stmt.endIdx;
  for (let i = parenEnd + 1; i <= stmt.endIdx && i < tokens.length; i++) {
    if (tokens[i].kind === "punct" && tokens[i].value === "{") {
      openBraceIdx = i;
      break;
    }
  }
  return {
    symbol: {
      name: funcName,
      qualifiedName: `${filePath}:${funcName}`,
      kind: "Function",
      filePath,
      startLine: t.line,
      endLine: stmt.endLine,
      signature: buildSignatureLine(sourceLines, t.line, stmt.endLine),
      docComment: extractLeadingDoc(tokens, idx, t.line),
      rawCallees: collectCalleesInRange(tokens, parenEnd + 1, stmt.endIdx, funcName),
    },
    nextIdx: openBraceIdx,
  };
}

function tryParseKeywordDecl(
  tokens: LexToken[],
  idx: number,
  filePath: string,
  sourceLines: string[],
): { symbol: ScannedSymbol; isContainer: boolean; openBraceIdx: number; endIdx: number } | null {
  const t = tokens[idx];
  if (t.kind !== "ident" || t.parenDepth !== 0 || t.braceDepth !== 0) return null;
  const kindMap: Record<string, CodeSymbolKind> = {
    class: "Class", interface: "Interface", struct: "Struct", enum: "Enum",
    type: "Type", function: "Function", fn: "Function", func: "Function", def: "Function",
  };
  const kind = kindMap[t.value];
  if (!kind) return null;
  const isContainer = kind === "Class" || kind === "Interface" || kind === "Struct";
  let nameIdx = idx + 1;
  if (nameIdx < tokens.length && tokens[nameIdx].value === "*") nameIdx++;
  if (nameIdx >= tokens.length || tokens[nameIdx].kind !== "ident") return null;
  const name = tokens[nameIdx].value;
  if (CONTROL_KEYWORDS.has(name)) return null;
  if ((kind === "Struct" || kind === "Enum") && (nameIdx + 1 >= tokens.length || tokens[nameIdx + 1].value !== "{")) return null;

  const stmt = findStatementEndLine(tokens, nameIdx);
  let openBraceIdx = -1;
  for (let i = nameIdx + 1; i <= stmt.endIdx && i < tokens.length; i++) {
    if (tokens[i].kind === "punct" && tokens[i].value === "{" && tokens[i].braceDepth === t.braceDepth) { openBraceIdx = i; break; }
  }
  return {
    symbol: {
      name,
      qualifiedName: `${filePath}:${name}`,
      kind,
      filePath,
      startLine: t.line,
      endLine: stmt.endLine,
      signature: buildSignatureLine(sourceLines, t.line, stmt.endLine),
      docComment: extractLeadingDoc(tokens, idx, t.line),
      rawCallees: kind === "Function" ? collectCalleesInRange(tokens, nameIdx + 1, stmt.endIdx, name) : [],
    },
    isContainer: isContainer && openBraceIdx >= 0,
    openBraceIdx,
    endIdx: stmt.endIdx,
  };
}

function tryParseArrowFunc(tokens: LexToken[], idx: number, filePath: string, sourceLines: string[]): { symbol: ScannedSymbol; openBraceIdx: number } | null {
  const t = tokens[idx];
  if (idx < 1 || (tokens[idx - 1].value !== "const" && tokens[idx - 1].value !== "let")) return null;
  if (idx + 2 >= tokens.length || tokens[idx + 1].value !== "=") return null;
  for (let j = idx + 2; j < Math.min(idx + 35, tokens.length); j++) {
    if (tokens[j].value === ";" && tokens[j].braceDepth === 0) break;
    if (tokens[j].value === "=>" && j + 1 < tokens.length && tokens[j + 1].value === "{") {
      const body = findMatchingBraceEnd(tokens, j + 1);
      return {
        symbol: {
          name: t.value,
          qualifiedName: `${filePath}:${t.value}`,
          kind: "Function",
          filePath,
          startLine: t.line,
          endLine: body.endLine,
          signature: buildSignatureLine(sourceLines, t.line, body.endLine),
          docComment: extractLeadingDoc(tokens, idx - 1, t.line),
          rawCallees: collectCalleesInRange(tokens, j + 1, body.endIdx, t.value),
        },
        openBraceIdx: j + 1,
      };
    }
  }
  return null;
}

function tryParseCallableOrMethod(
  tokens: LexToken[],
  idx: number,
  filePath: string,
  sourceLines: string[],
  enclosingClass?: { name: string; braceDepth: number },
): { symbol: ScannedSymbol; openBraceIdx: number } | null {
  const t = tokens[idx];
  if (t.kind !== "ident" || CONTROL_KEYWORDS.has(t.value)) return null;
  const expectedDepth = enclosingClass ? enclosingClass.braceDepth + 1 : 0;
  if (t.braceDepth !== expectedDepth || t.parenDepth !== 0) return null;

  if (!enclosingClass) {
    const arrow = tryParseArrowFunc(tokens, idx, filePath, sourceLines);
    if (arrow) return arrow;
  }
  if (idx + 1 >= tokens.length || tokens[idx + 1].value !== "(") return null;
  if (idx > 0 && (tokens[idx - 1].value === "." || tokens[idx - 1].value === "->" || tokens[idx - 1].value === "=")) return null;
  if (!enclosingClass) {
    if (idx === 0) return null;
    const prev = tokens[idx - 1];
    if (prev.kind !== "ident" && prev.value !== "*" && prev.value !== ">") return null;
  }

  const parenEnd = findMatchingParenEnd(tokens, idx + 1);
  let braceIdx = -1;
  for (let j = parenEnd + 1; j < Math.min(parenEnd + 25, tokens.length); j++) {
    if (tokens[j].value === ";" && tokens[j].braceDepth === expectedDepth) return null;
    if (tokens[j].value === "{" && tokens[j].braceDepth === expectedDepth) { braceIdx = j; break; }
  }
  if (braceIdx < 0) return null;
  const body = findMatchingBraceEnd(tokens, braceIdx);
  const parentName = enclosingClass?.name;
  return {
    symbol: {
      name: t.value,
      qualifiedName: parentName ? `${filePath}:${parentName}.${t.value}` : `${filePath}:${t.value}`,
      kind: parentName ? "Method" : "Function",
      filePath,
      startLine: t.line,
      endLine: body.endLine,
      signature: buildSignatureLine(sourceLines, t.line, body.endLine),
      parentSymbol: parentName,
      docComment: extractLeadingDoc(tokens, idx, t.line),
      rawCallees: collectCalleesInRange(tokens, braceIdx + 1, body.endIdx, t.value),
    },
    openBraceIdx: braceIdx,
  };
}

function tryParseRouteOrMacro(tokens: LexToken[], idx: number, filePath: string, sourceLines: string[]): ScannedSymbol | null {
  const t = tokens[idx];
  if (t.kind === "punct" && t.value === "#" && idx + 2 < tokens.length &&
      tokens[idx + 1].value === "define" && tokens[idx + 2].kind === "ident" && tokens[idx + 2].line === t.line) {
    const m = tokens[idx + 2];
    return {
      name: m.value, qualifiedName: `${filePath}:${m.value}`, kind: "Macro",
      filePath, startLine: t.line, endLine: t.endLine,
      signature: buildSignatureLine(sourceLines, t.line, t.endLine), rawCallees: [],
    };
  }
  if (t.kind === "ident" && !CONTROL_KEYWORDS.has(t.value) &&
      idx + 2 < tokens.length && tokens[idx + 1].value === "(") {
    const parenEnd = findMatchingParenEnd(tokens, idx + 1);
    const args: LexToken[] = [];
    for (let i = idx + 2; i < parenEnd; i++) {
      if (tokens[i].value !== ",") args.push(tokens[i]);
    }
    let method = "";
    let routePath = "";
    let handlerIdx = -1;
    if (HTTP_METHODS.has(t.value.toLowerCase()) && idx >= 2 && tokens[idx - 1].value === "." &&
        args.length >= 1 && args[0].kind === "string") {
      method = t.value.toUpperCase();
      routePath = unquoteString(args[0].value);
      handlerIdx = 1;
    } else if (args.length >= 2 && args[0].kind === "string" && args[1].kind === "string") {
      const m = unquoteString(args[0].value).toLowerCase();
      if (HTTP_METHODS.has(m)) {
        method = m.toUpperCase();
        routePath = unquoteString(args[1].value);
        handlerIdx = 2;
      }
    } else if (args.length >= 1 && args[0].kind === "string") {
      const s = unquoteString(args[0].value);
      const sep = s.indexOf(":/");
      const sp = s.indexOf(" /");
      const splitAt = sep > 0 && (sp < 0 || sep < sp) ? sep : sp;
      if (splitAt > 0) {
        const m = s.slice(0, splitAt).toLowerCase();
        if (HTTP_METHODS.has(m)) {
          method = m.toUpperCase();
          routePath = s.slice(splitAt + 1);
          handlerIdx = 1;
        }
      }
    }
    if (method && routePath.startsWith("/")) {
      const handler = handlerIdx >= 0 && args[handlerIdx]?.kind === "ident" ? [args[handlerIdx].value] : [];
      const name = `${method} ${routePath}`;
      return {
        name, qualifiedName: `${filePath}:${name}`, kind: "Route",
        filePath, startLine: t.line, endLine: t.endLine,
        signature: buildSignatureLine(sourceLines, t.line, t.endLine),
        routePath, routeMethod: method, rawCallees: handler,
      };
    }
  }
  return null;
}

export function scanSourceFile(filePath: string, text: string): ScannedFileResult {
  const isHashLang = filePath.endsWith(".py") || filePath.endsWith(".sh");
  const lex = tokenizeSource(text, isHashLang);
  const tokens = lex.tokens;
  const sourceLines = text.split("\n");
  const imports = extractImports(tokens);
  const symbols: ScannedSymbol[] = [];
  const classStack: Array<{ name: string; braceDepth: number; endIdx: number }> = [];

  for (let i = 0; i < tokens.length; i++) {
    while (classStack.length > 0 && i > classStack[classStack.length - 1].endIdx) classStack.pop();
    const xy = tryParseXyMacro(tokens, i, filePath, sourceLines);
    if (xy) { symbols.push(xy.symbol); i = xy.nextIdx; continue; }
    const rm = tryParseRouteOrMacro(tokens, i, filePath, sourceLines);
    if (rm) symbols.push(rm);
    const kw = tryParseKeywordDecl(tokens, i, filePath, sourceLines);
    if (kw) {
      symbols.push(kw.symbol);
      if (kw.isContainer && kw.openBraceIdx >= 0) {
        classStack.push({ name: kw.symbol.name, braceDepth: tokens[kw.openBraceIdx].braceDepth, endIdx: kw.endIdx });
        i = kw.openBraceIdx;
      } else if (kw.openBraceIdx >= 0) i = kw.openBraceIdx;
      continue;
    }
    const activeClass = classStack.length > 0 ? classStack[classStack.length - 1] : undefined;
    const callable = tryParseCallableOrMethod(tokens, i, filePath, sourceLines, activeClass);
    if (callable) { symbols.push(callable.symbol); i = callable.openBraceIdx; }
  }
  return { filePath, lineCount: lex.lineCount, byteLength: lex.byteLength, lineOffsets: lex.lineOffsets, imports, symbols };
}
