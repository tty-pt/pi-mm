import assert from "node:assert";
import {
  fnv1a64,
  createPromptBlock,
  composePromptBlocks,
  canonicalSortByRef,
} from "../src/blocks.ts";

Deno.test("fnv1a64: produces deterministic 16-hex-digit hash", () => {
  const h1 = fnv1a64("Hello World");
  const h2 = fnv1a64("Hello World");
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, 16);

  const h3 = fnv1a64("Hello World!");
  assert.notStrictEqual(h1, h3);
});

Deno.test("createPromptBlock: generates block with content hash", () => {
  const block = createPromptBlock("sys:directive", "Always be concise.", "system");
  assert.strictEqual(block.id, "sys:directive");
  assert.strictEqual(block.text, "Always be concise.");
  assert.strictEqual(block.role, "system");
  assert.strictEqual(block.hash, fnv1a64("Always be concise."));
});

Deno.test("composePromptBlocks: concatenates texts and lists hashes", () => {
  const b1 = createPromptBlock("b1", "Part 1");
  const b2 = createPromptBlock("b2", "Part 2");
  const comp = composePromptBlocks([b1, b2]);

  assert.strictEqual(comp.prompt, "Part 1\n\nPart 2");
  assert.deepStrictEqual(comp.hashes, [b1.hash, b2.hash]);
});

Deno.test("canonicalSortByRef: stably orders records by ref ascending", () => {
  const records = [
    { ref: 42, score: 0.99 },
    { ref: 7, score: 0.12 },
    { ref: 105, score: 0.85 },
    { ref: 23, score: 0.50 },
  ];

  const sorted = canonicalSortByRef(records);
  assert.deepStrictEqual(sorted.map((r) => r.ref), [7, 23, 42, 105]);

  // Original array remains unmodified
  assert.strictEqual(records[0].ref, 42);
});
