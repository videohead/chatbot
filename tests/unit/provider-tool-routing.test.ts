import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { generateText, tool } from "ai";
import { z } from "zod";
import { getLanguageModel } from "../../lib/ai/providers";

for (const mode of ["app", "none", "disabled"] as const) {
  test(`never injects unowned gateway tools (mode: ${mode})`, async () => {
    let request: { tools?: { type: string; function?: { name: string } }[] } =
      {};
    const fetch = mock.method(
      globalThis,
      "fetch",
      (_url: string | URL | Request, init?: RequestInit) => {
        request = JSON.parse(String(init?.body));
        return Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: { content: "Synthetic probe", role: "assistant" },
              },
            ],
            created: 0,
            id: "probe",
            model: "probe",
            object: "chat.completion",
            usage: { completion_tokens: 2, prompt_tokens: 2, total_tokens: 4 },
          })
        );
      }
    );
    try {
      await generateText({
        model: getLanguageModel("probe"),
        prompt: "Synthetic tool routing test",
        ...(mode === "none"
          ? {}
          : {
              tools: {
                delegateToAgentFramework: tool({
                  description: "Application-owned tool",
                  inputSchema: z.object({ request: z.string() }),
                }),
              },
            }),
        ...(mode === "disabled" ? { activeTools: [] } : {}),
      });
      const types = request.tools?.map((entry) => entry.type);
      if (mode === "app") {
        assert.deepEqual(types, ["function"]);
        assert.equal(
          request.tools?.[0].function?.name,
          "delegateToAgentFramework"
        );
      } else {
        assert.equal(types?.length ?? 0, 0);
      }
    } finally {
      fetch.mock.restore();
    }
  });
}
