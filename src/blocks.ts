/**
 * Content-Addressed Prompt Blocks & Deterministic Memory Assembly.
 *
 * Provides immutable, 64-bit hashed prompt blocks to enable KV cache reuse
 * in LLM backends (like axil-auren). Guarantees stable ordering of recalled
 * memories so floating-point score fluctuations do not bust prompt KV caches.
 */

export interface PromptBlock {
  /** Logical block identifier (e.g. "sys:core", "mem:42", "turn:3:user") */
  id: string;
  /** 16-character hexadecimal 64-bit FNV-1a content hash */
  hash: string;
  /** Canonical textual content of the block */
  text: string;
  /** Optional message role associated with the block */
  role?: "system" | "user" | "assistant";
}

const FNV1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * Computes a deterministic 64-bit FNV-1a hash over a UTF-8 string,
 * returning a 16-character zero-padded lowercase hexadecimal string.
 */
export function fnv1a64(str: string): string {
  let hash = FNV1A_64_OFFSET;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);

  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV1A_64_PRIME) & MASK_64;
  }

  return hash.toString(16).padStart(16, "0");
}

/**
 * Creates a content-addressed prompt block from an identifier and text.
 */
export function createPromptBlock(
  id: string,
  text: string,
  role?: "system" | "user" | "assistant",
): PromptBlock {
  return {
    id,
    hash: fnv1a64(text),
    text,
    role,
  };
}

/**
 * Composes a list of prompt blocks into a single prompt string,
 * alongside the list of constituent block hashes for KV cache verification.
 */
export function composePromptBlocks(blocks: PromptBlock[]): {
  prompt: string;
  hashes: string[];
} {
  const parts: string[] = [];
  const hashes: string[] = [];

  for (const block of blocks) {
    if (block.text) {
      parts.push(block.text);
      hashes.push(block.hash);
    }
  }

  return {
    prompt: parts.join("\n\n"),
    hashes,
  };
}

/**
 * Canonical sorting of records by ascending ref ID.
 * Guarantees deterministic serialization across conversation turns.
 */
export function canonicalSortByRef<T extends { ref: number }>(records: T[]): T[] {
  return [...records].sort((a, b) => a.ref - b.ref);
}
