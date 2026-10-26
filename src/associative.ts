/**
 * src/associative.ts
 *
 * Lightweight entity co-occurrence graph for associative memory recall.
 * Enables lateral spreading activation (e.g. "airplane" -> "grandpa", "cherry tree" -> "wolves")
 * without ML overhead, storing associations in .pi/mm/associations.json with atomic file writes.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { debugLog } from "./debug.ts";

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with",
  "by", "about", "against", "between", "into", "through", "during", "before",
  "after", "above", "below", "from", "up", "down", "of", "off", "over", "under",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "can", "could", "shall", "should", "will", "would",
  "may", "might", "must", "it", "its", "that", "this", "these", "those",
  "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "her", "our", "their", "what", "which", "who", "whom",
  "when", "where", "why", "how", "not", "no", "yes", "all", "any", "both",
  "each", "few", "more", "most", "some", "such", "than", "too", "very",
  "just", "like", "also", "then", "there", "here", "remember", "investigation",
]);

export function extractKeyEntities(text: string): string[] {
  if (!text) return [];
  const words = text.toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return Array.from(new Set(words));
}

export type AssociationMap = Record<string, Record<string, number>>;

export function loadAssociations(memDir: string): AssociationMap {
  const filePath = join(memDir, "associations.json");
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed as AssociationMap : {};
  } catch {
    return {};
  }
}

export function saveAssociationsAtomic(memDir: string, map: AssociationMap): void {
  try {
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
    const targetPath = join(memDir, "associations.json");
    const tmpPath = join(memDir, `.associations.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(map, null, 2), "utf-8");
    renameSync(tmpPath, targetPath);
  } catch (err) {
    debugLog("persistence", "Failed to write associations.json atomically", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function recordAssociations(memDir: string, text: string): Promise<void> {
  const entities = extractKeyEntities(text);
  if (entities.length < 2) return Promise.resolve();

  const map = loadAssociations(memDir);

  for (let i = 0; i < entities.length; i++) {
    const e1 = entities[i];
    if (!map[e1]) map[e1] = {};
    for (let j = 0; j < entities.length; j++) {
      if (i === j) continue;
      const e2 = entities[j];
      map[e1][e2] = (map[e1][e2] || 0) + 1;
    }

    // Bounded capacity: keep at most top 12 strongest co-occurring neighbors per entity
    const neighbors = Object.entries(map[e1]);
    if (neighbors.length > 12) {
      neighbors.sort((a, b) => b[1] - a[1]);
      map[e1] = Object.fromEntries(neighbors.slice(0, 12));
    }
  }

  saveAssociationsAtomic(memDir, map);
  return Promise.resolve();
}

export function getAssociatedTokens(memDir: string, queryTokens: string[], maxNeighbors = 2): string[] {
  const map = loadAssociations(memDir);
  const existingSet = new Set(queryTokens.map((t) => t.toLowerCase()));
  const candidates: Array<{ token: string; weight: number }> = [];

  for (const t of queryTokens) {
    const term = t.toLowerCase();
    const neighbors = map[term];
    if (neighbors) {
      for (const [neighbor, weight] of Object.entries(neighbors)) {
        if (!existingSet.has(neighbor) && !STOP_WORDS.has(neighbor)) {
          candidates.push({ token: neighbor, weight });
        }
      }
    }
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const result: string[] = [];
  for (const c of candidates) {
    if (!result.includes(c.token)) {
      result.push(c.token);
      if (result.length >= maxNeighbors) break;
    }
  }
  return result;
}
