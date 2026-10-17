import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { getCapabilities } from "../../lib/ai/litellm";
import { systemPrompt } from "../../lib/ai/prompts";

test("enables verified Flash Next function calls despite stale catalog metadata", async () => {
  const fetch = mock.method(
    globalThis,
    "fetch",
    (url: string | URL | Request) =>
      Promise.resolve(
        Response.json(
          String(url).endsWith("/models")
            ? { data: [{ id: "nvidia/qwen/qwen3.8-flash-next" }] }
            : { unhealthy_endpoints: [] }
        )
      )
  );
  try {
    const capabilities = await getCapabilities();
    assert.deepEqual(capabilities["nvidia/qwen/qwen3.8-flash-next"], {
      reasoning: true,
      tools: true,
      vision: false,
    });
  } finally {
    fetch.mock.restore();
  }
});

test("tool-disabled models are not instructed to use unavailable tools", () => {
  const prompt = systemPrompt({
    requestHints: {
      city: undefined,
      country: undefined,
      latitude: undefined,
      longitude: undefined,
    },
    supportsTools: false,
  });
  assert.match(prompt, /no active tools/);
  assert.match(prompt, /Do not call tools/);
  assert.doesNotMatch(prompt, /delegateToAgentFramework|call execute_command/);
});
