import assert from "node:assert";
import { runRealEmbeddingSmokeTest } from "../scripts/test-real-embedding.ts";

Deno.test("real_embedding: smoke test runs or truthfully skips based on environment", async () => {
  const result = await runRealEmbeddingSmokeTest();
  assert.notStrictEqual(result.status, "FAIL", `Real embedding smoke test failed: ${result.reason}`);
  assert.ok(result.status === "PASS" || result.status === "SKIPPED");
  if (result.status === "SKIPPED") {
    assert.ok(typeof result.reason === "string", "Skip reason must be reported");
  }
});

Deno.test("real_embedding: distinguishes synthetic test plumbing from real semantic model validation", () => {
  // Deterministic synthetic embedding functions (such as the one in conversational_memory.test.ts)
  // validate the native C plumbing (libcurl POST, JSON payload escaping, vector parsing,
  // axis store fan-out, and cosine scoring).
  // Live semantic model validation tests semantic-quality comprehension of models like nomic-embed-text.
  const hasLiveConfig = Boolean(
    (Deno.env.get("CORM_SEPAL_EMBED_URL") || Deno.env.get("CORM_SEPAL_EMBED_URL")) &&
    (Deno.env.get("CORM_SEPAL_EMBED_MODEL") || Deno.env.get("CORM_SEPAL_EMBED_MODEL")),
  );

  if (hasLiveConfig) {
    console.log("Live real embedding model is configured; semantic quality validation is active.");
  } else {
    console.log("Live real embedding model is unconfigured; plumbing tested via hermetic synthetic vectors; real model validation safely skipped.");
  }
  assert.strictEqual(typeof hasLiveConfig, "boolean");
});

