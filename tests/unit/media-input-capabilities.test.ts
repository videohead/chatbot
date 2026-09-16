import assert from "node:assert/strict";
import test from "node:test";
import {
  getVideoInputCapabilities,
  supportsImageInput,
  supportsVideoFileInput,
  supportsVideoImageInput,
} from "../../lib/ai/media-settings";

test("image editing is enabled only for verified image-edit deployments", () => {
  assert.equal(supportsImageInput("openai/openai/gpt-image-2"), true);
  assert.equal(supportsImageInput("gcp/google/gemini-3-pro-image"), true);
  assert.equal(supportsImageInput("gcp/google/gemini-3.1-flash-image"), true);
  assert.equal(supportsImageInput("azure/openai/gpt-image-2"), false);
});

test("video reference inputs are gated by the exact deployed model", () => {
  assert.deepEqual(getVideoInputCapabilities("gemini-omni-flash-preview"), {
    image: true,
    video: true,
  });
  assert.equal(
    supportsVideoImageInput("gcp/google/veo-3.1-generate-001"),
    true
  );
  assert.equal(
    supportsVideoFileInput("gcp/google/veo-3.1-generate-001"),
    false
  );
  assert.equal(
    supportsVideoImageInput("gcp/google/veo-3.0-generate-001"),
    false
  );
  assert.deepEqual(getVideoInputCapabilities("unknown/video-model"), {
    image: false,
    video: false,
  });
});
