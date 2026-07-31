import assert from "node:assert/strict";
import test from "node:test";
import { parseLlamaTimingLog } from "../src/llamaTimings.js";

test("llama timing parser separates prompt, decode, and total measurements", () => {
  const parsed = parseLlamaTimingLog(`
prompt eval time =   43469.54 ms /    75 tokens ( 579.59 ms per token, 1.73 tokens per second)
       eval time =    4149.85 ms /     8 tokens ( 518.73 ms per token, 1.93 tokens per second)
      total time =   47619.40 ms /    83 tokens
  `);
  assert.deepEqual(parsed, {
    prompt: { milliseconds: 43469.54, tokens: 75, tokens_per_second: 1.73 },
    decode: { milliseconds: 4149.85, tokens: 8, tokens_per_second: 1.93 },
    total: { milliseconds: 47619.4, tokens: 83 }
  });
});

test("llama timing parser makes incomplete logs explicit", () => {
  assert.deepEqual(parseLlamaTimingLog("model loading"), {
    prompt: null,
    decode: null,
    total: null
  });
});
