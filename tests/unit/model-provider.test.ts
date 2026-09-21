import assert from "node:assert/strict";
import test from "node:test";
import { getModelProvider } from "../../lib/ai/models";

test("groups the bare GPT OSS deployment with local models", () => {
  assert.equal(getModelProvider("gpt-oss-20b"), "local");
  assert.equal(getModelProvider("local/qwen3.8-27b-nvfp4"), "local");
});

test("keeps NVIDIA's hosted GPT OSS deployment in the NVIDIA group", () => {
  assert.equal(getModelProvider("nvidia/openai/gpt-oss-20b"), "nvidia");
});
