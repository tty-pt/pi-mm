/**
 * First-Touch Module Dossier & Cross-Boundary Isomorphic Pairing (src/code/dossier.ts).
 * Synthesizes a compact, deterministic architectural briefing once per session per module,
 * and resolves cross-boundary pairs (Server C <-> Isomorphic UX WASM, XY_DECL <-> XY_IMPL).
 */

import type { CodeStore } from "./store.ts";
import type { CodeContractMismatch, CodeQueryOptions, CodeSymbolRecord } from "./types.ts";
import { isGenericSingleWordSymbol, verifyLoreBindingsForSymbols } from "./lore_binding.ts";
import { querySwarmStigmergy } from "./stigmergy.ts";
import { isTestOrMockRelPath, normalizeRelPath } from "./payload_codec.ts";

const sessionVisitedModules = new Map<string, Set<string>>();

export function clearSessionVisitedModules(): void {
  sessionVisitedModules.clear();
}

export function isTestFilePath(filePath: string): boolean {
  return isTestOrMockRelPath(filePath);
}

export function deriveModuleKey(filePath: string): string {
  let norm = normalizeRelPath(filePath);
  while (norm.startsWith("/")) norm = norm.slice(1);
  const parts = norm.split("/").filter(Boolean);
  if (parts.length >= 2 && (parts[0] === "mods" || parts[0] === "external" || parts[0] === "packages")) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts.length >= 3 && parts[0] === ".pi" && parts[1] === "extensions") {
    return `.pi/extensions/${parts[2]}`;
  }
  return parts[0] || "";
}

export function buildCodeLoreTopic(sym: CodeSymbolRecord | undefined, opts: CodeQueryOptions): string {
  if (sym) {
    if (sym.parentSymbol) return `${sym.parentSymbol} ${sym.name}`;
    if (isGenericSingleWordSymbol(sym.name)) {
      const modKey = deriveModuleKey(sym.filePath);
      return modKey ? `${modKey} ${sym.name}` : `${sym.filePath} ${sym.name}`;
    }
    return sym.name;
  }
  return opts.symbol || opts.query || opts.file || opts.diagnose || "";
}

export function isLoreRelevantToSymbol(
  summary: string,
  subsystem: string | undefined,
  path: string | undefined,
  sym: CodeSymbolRecord | undefined,
): boolean {
  if (!sym || !isGenericSingleWordSymbol(sym.name)) return true;
  const corpus = `${summary} ${subsystem || ""} ${path || ""}`.toLowerCase();
  if (sym.parentSymbol && corpus.includes(sym.parentSymbol.toLowerCase())) return true;
  const fp = sym.filePath.toLowerCase();
  const slashIdx = fp.lastIndexOf("/");
  const baseName = slashIdx >= 0 ? fp.slice(slashIdx + 1) : fp;
  const modKey = deriveModuleKey(sym.filePath).toLowerCase();
  const modLeaf = modKey.includes("/") ? modKey.slice(modKey.lastIndexOf("/") + 1) : modKey;
  return corpus.includes(fp) || corpus.includes(baseName) || (modLeaf.length >= 3 && corpus.includes(modLeaf));
}

export function inferTier0VerificationGate(modKey: string, filePath: string): { boundary: string; command: string } | null {
  const norm = normalizeRelPath(filePath);
  if (modKey.startsWith("mods/")) {
    const modName = modKey.slice(5);
    if (norm.includes("/ux/") || modName === "site_chrome") {
      return {
        boundary: "Pure-C Isomorphic UX (Dual-compile SSR + Browser WASM; zeroXY_/corm_/source_/axil_ allowed)",
        command: `make -C mods/${modName} && make site-wasm && sh scripts/check-module-boundaries.sh && sh scripts/check-wasm-imports.sh`,
      };
    }
    return {
      boundary: "Server-Side XY Module (Two-header rule: M-types.h + M.h; explicit xy_load DAG)",
      command: `make -C mods/${modName} && make test-mod MOD=${modName}`,
    };
  }
  if (modKey.startsWith("external/")) {
    const extName = modKey.slice("external/".length);
    const cmd = extName.startsWith("lib")
      ? `make ${extName.slice(3)}-lib && make standalone-unit-tests`
      : "make standalone-unit-tests";
    return { boundary: `Core C Library (${modKey})`, command: cmd };
  }
  if (modKey.startsWith(".pi/extensions/")) {
    return {
      boundary: `Pi Extension (${modKey})`,
      command: `deno test --allow-all ${modKey}/tests/ && deno run --allow-all ${modKey}/scripts/check-complexity.ts`,
    };
  }
  if (norm.startsWith("htdocs/") && norm.endsWith(".js")) {
    return {
      boundary: "Generic Client JS Runtime (Zero domain-specific module names or custom logic)",
      command: "sh scripts/check-no-site-specific-js.sh",
    };
  }
  return null;
}

export function resolveCrossBoundaryPairs(store: CodeStore, symbols: CodeSymbolRecord[]): string[] {
  if (symbols.length === 0) return [];
  const allSyms = store.getAllSymbols();
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const sym of symbols.slice(0, 4)) {
    const modKey = deriveModuleKey(sym.filePath);
    if (sym.signature.startsWith("XY_IMPL") || sym.signature.startsWith("XY_DECL")) {
      const targetKind = sym.signature.startsWith("XY_IMPL") ? "XY_DECL" : "XY_IMPL";
      const match = allSyms.find((s) => s.name === sym.name && s.ref !== sym.ref && s.signature.startsWith(targetKind));
      if (match && !seen.has(`xy:${match.qualifiedName}`)) {
        seen.add(`xy:${match.qualifiedName}`);
        lines.push(`  • [XY Contract Pair] ${targetKind} ${match.name} (${match.filePath}:${match.startLine}-${match.endLine})`);
      }
    }
    if (modKey.startsWith("mods/")) {
      const isUx = sym.filePath.includes("/ux/");
      const pairedSyms = allSyms.filter((s) =>
        s.filePath.startsWith(`${modKey}/`) &&
        !isTestFilePath(s.filePath) &&
        (isUx ? !s.filePath.includes("/ux/") : s.filePath.includes("/ux/")) &&
        (s.name === "bud_app_render" || s.name.startsWith("STL_WASM_MODULE") || s.kind === "Route" || s.name === "xy_install")
      );
      for (const p of pairedSyms.slice(0, 2)) {
        if (!seen.has(`iso:${p.qualifiedName}`)) {
          seen.add(`iso:${p.qualifiedName}`);
          const label = isUx ? "Server Route/Entry" : "Isomorphic UX Entry";
          lines.push(`  • [${label}] ${p.name} (${p.filePath}:${p.startLine})`);
        }
      }
    }
  }
  return lines;
}

export function normalizeXyMacroSignature(sig: string): string {
  const openIdx = sig.indexOf("(");
  if (openIdx < 0) return sig.trim();
  let closeIdx = sig.lastIndexOf(")");
  if (closeIdx < openIdx) closeIdx = sig.length;
  const inner = sig.slice(openIdx + 1, closeIdx);
  let out = "";
  let prevSpace = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (!prevSpace && out.length > 0) { out += " "; prevSpace = true; }
    } else {
      if ((ch === "," || ch === ")" || ch === "(") && out.endsWith(" ")) out = out.slice(0, -1);
      out += ch;
      prevSpace = ch === "," || ch === "(";
    }
  }
  return out.trim();
}

export function detectXyContractMismatches(
  store: CodeStore,
  modifiedSymbols: CodeSymbolRecord[],
): CodeContractMismatch[] {
  const mismatches: CodeContractMismatch[] = [];
  const checkedNames = new Set<string>();
  const allSyms = store.getAllSymbols();

  for (const sym of modifiedSymbols) {
    const isDecl = sym.signature.startsWith("XY_DECL");
    const isImpl = sym.signature.startsWith("XY_IMPL");
    if ((!isDecl && !isImpl) || checkedNames.has(sym.name)) continue;
    checkedNames.add(sym.name);

    const decls = allSyms.filter((s) => s.name === sym.name && s.signature.startsWith("XY_DECL") && !isTestFilePath(s.filePath));
    const impls = allSyms.filter((s) => s.name === sym.name && s.signature.startsWith("XY_IMPL") && !isTestFilePath(s.filePath));
    const decl = isDecl ? sym : decls[0];
    const impl = isImpl ? sym : impls[0];

    if (decl && !impl) {
      mismatches.push({ symbolName: sym.name, declSymbol: decl, reason: "missing_impl" });
    } else if (impl && !decl) {
      mismatches.push({ symbolName: sym.name, implSymbol: impl, reason: "missing_decl" });
    } else if (decl && impl) {
      if (normalizeXyMacroSignature(decl.signature) !== normalizeXyMacroSignature(impl.signature)) {
        mismatches.push({ symbolName: sym.name, declSymbol: decl, implSymbol: impl, reason: "signature_mismatch" });
      }
    }
  }
  return mismatches;
}

export function synthesizeFirstTouchModuleDossier(
  store: CodeStore,
  sessionId: string,
  filePath: string,
): string {
  const modKey = deriveModuleKey(filePath);
  if (!modKey || !sessionId) return "";

  let visited = sessionVisitedModules.get(sessionId);
  if (!visited) {
    visited = new Set<string>();
    sessionVisitedModules.set(sessionId, visited);
  }
  if (visited.has(modKey)) return "";
  visited.add(modKey);

  const gate = inferTier0VerificationGate(modKey, filePath);
  const modSyms = store.getAllSymbols().filter((s) => s.filePath.startsWith(`${modKey}/`));
  const entries = modSyms
    .filter((s) =>
      !isTestFilePath(s.filePath) &&
      (s.kind === "Route" || s.name === "xy_install" || s.name === "bud_app_render" || s.name.startsWith("STL_WASM_MODULE"))
    )
    .slice(0, 4)
    .map((s) => `${s.name} (${s.filePath}:${s.startLine})`);

  const drift = verifyLoreBindingsForSymbols(store, modSyms);
  const freshLore = drift.filter((d) => d.status === "fresh").slice(0, 2);
  const staleLore = drift.filter((d) => d.status === "stale_suspect").slice(0, 2);
  const swarm = querySwarmStigmergy(store.indexDir, {
    currentSessionId: sessionId,
    filePaths: [normalizeRelPath(filePath)],
  });

  if (!gate && entries.length === 0 && freshLore.length === 0 && staleLore.length === 0) return "";

  const lines = [`=== 📋 [pi-mm First-Touch Module Dossier: ${modKey}] ===`];
  if (gate) {
    lines.push(`  • Architectural Boundary: ${gate.boundary}`);
    lines.push(`  • Tier-0 Verification Gate: \`${gate.command}\``);
  }
  if (entries.length > 0) {
    lines.push(`  • Key Entry Points: ${entries.join(", ")}`);
  }
  for (const l of freshLore) {
    lines.push(`  • Bound Invariant [Ref ${l.memoryRef} · FRESH]: ${l.summary}`);
  }
  for (const s of staleLore) {
    lines.push(`  • ⚠️ Drifted Invariant [Ref ${s.memoryRef} · STALE_SUSPECT]: ${s.summary}`);
  }
  if (swarm.length > 0) {
    lines.push(`  • Active Swarm Lease: Session ${swarm[0].lease.shortId} (${swarm[0].lease.action} ${swarm[0].lease.filePath})`);
  }
  return lines.join("\n");
}
