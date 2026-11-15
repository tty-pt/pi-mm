import { strict as assert } from "node:assert";
import { decodeResult } from "../src/payload.ts";
import { encodeHtokPayload } from "../src/payload.ts";
import type { MemoryEnvelope } from "../src/types.ts";

Deno.test("decodeResult: prefers byte-exact stdoutBytes over stdout", () => {
  const env: MemoryEnvelope = {
    level: "L1",
    type: "note",
    lifecycle: "supported",
    summary: "Byte exact test",
  };
  const htokBytes = encodeHtokPayload("2026-11-06", env);
  
  // Simulated cormd response with stdoutBytes
  const resWithBytes = {
    code: 0,
    stdout: "binary string representation that might get corrupted",
    stdoutBytes: htokBytes,
    stderr: "",
  };

  const decoded = decodeResult(resWithBytes);
  assert.equal(decoded.envelope.level, "L1");
  assert.equal(decoded.envelope.summary, "Byte exact test");

  // Fallback to text stdout when stdoutBytes is absent
  const resWithoutBytes = {
    code: 0,
    stdout: '2026-11-06:{"l":"L2","s":"Fallback test"}',
    stderr: "",
  };
  const decodedFallback = decodeResult(resWithoutBytes);
  assert.equal(decodedFallback.envelope.level, "L2");
  assert.equal(decodedFallback.envelope.summary, "Fallback test");
});
