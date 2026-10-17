import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  callAgentFramework,
  createAgentFrameworkTool,
} from "../../lib/ai/tools/delegate-agent-framework";

test("forwards the model and session and reports only evidenced completion", async () => {
  const fetch = mock.method(
    globalThis,
    "fetch",
    (_url: string | URL | Request, init?: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        message: "Implement the change",
        model: "test-model",
        session_id: "test-session",
      });
      return Promise.resolve(
        Response.json({
          finish_reason: "stop",
          pending_tasks: [],
          response: "Updated the component; typecheck passed.",
          status: "completed",
        })
      );
    }
  );
  try {
    const result = await callAgentFramework(
      "Implement the change",
      "test-session",
      "test-model"
    );
    assert.match(result, /run finished/);
    assert.match(result, /typecheck passed/);
    assert.doesNotMatch(result, /completed successfully|authoritative/);
  } finally {
    fetch.mock.restore();
  }
});

for (const [index, response] of [
  {
    finish_reason: "stop",
    pending_tasks: ["Wire the component", "Run the build"],
    response: "Let me continue.",
    status: "incomplete",
  },
  { response: "Let me start by exploring the project." },
  {
    finish_reason: "stop",
    pending_tasks: ["Run the build"],
    response: "Done",
    status: "completed",
  },
  {
    finish_reason: "length",
    pending_tasks: [],
    response: "Partial report",
    status: "completed",
  },
].entries()) {
  test(`does not present incomplete or legacy response ${index + 1} as completed work`, async () => {
    const fetch = mock.method(globalThis, "fetch", () =>
      Promise.resolve(Response.json(response))
    );
    try {
      const result = await callAgentFramework("Implement", "session");
      assert.match(result, /incomplete or its completion is unverified/);
      assert.match(result, /Host changes may already have been applied/);
      assert.doesNotMatch(result, /run finished|completed successfully/);
      if (response.pending_tasks?.length) {
        assert.match(result, new RegExp(response.pending_tasks[0]));
      }
    } finally {
      fetch.mock.restore();
    }
  });
}

test("surfaces HTTP failure details instead of claiming the harness is down", async () => {
  const fetch = mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      Response.json(
        { detail: "The selected model does not support tools" },
        { status: 502 }
      )
    )
  );
  try {
    const result = await callAgentFramework("Implement", "session");
    assert.match(result, /HTTP 502/);
    assert.match(result, /does not support tools/);
    assert.match(result, /host changes may already have been applied/);
  } finally {
    fetch.mock.restore();
  }
});

test("warns about partial changes on timeout", async () => {
  const fetch = mock.method(globalThis, "fetch", () => {
    throw new DOMException("Request timed out", "TimeoutError");
  });
  try {
    const result = await callAgentFramework("Implement", "session");
    assert.match(result, /timed out/);
    assert.match(result, /Host changes may already have been applied/);
  } finally {
    fetch.mock.restore();
  }
});

for (const [index, body] of [
  { response: "" },
  { status: "completed" },
].entries()) {
  test(`rejects empty or malformed success response ${index + 1}`, async () => {
    const fetch = mock.method(globalThis, "fetch", () =>
      Promise.resolve(Response.json(body))
    );
    try {
      const result = await callAgentFramework("Implement", "session");
      assert.match(result, /invalid response/);
      assert.doesNotMatch(result, /run finished|completed successfully/);
    } finally {
      fetch.mock.restore();
    }
  });
}

test("executes only one delegation per turn even for parallel or repeated calls", async () => {
  const fetch = mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      Response.json({
        finish_reason: "stop",
        pending_tasks: [],
        response: "Verified once",
        status: "completed",
      })
    )
  );
  try {
    const tool = createAgentFrameworkTool("duplicate-test");
    assert.ok(tool.execute);
    const first = tool.execute(
      { request: "Do the work" },
      { context: {}, messages: [], toolCallId: "one" }
    );
    const second = tool.execute(
      { request: "Retry the work with a simpler request" },
      { context: {}, messages: [], toolCallId: "two" }
    );
    assert.deepEqual(await first, await second);
    await tool.execute(
      { request: "Try again" },
      { context: {}, messages: [], toolCallId: "three" }
    );
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    fetch.mock.restore();
  }
});

test("reports an active conversation as busy, not an outage", async () => {
  const fetch = mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      Response.json({ detail: "Already active" }, { status: 409 })
    )
  );
  try {
    const result = await callAgentFramework("Implement", "busy-test");
    assert.match(result, /already has an active/);
    assert.match(result, /do not retry/);
    assert.doesNotMatch(result, /request failed|run finished/);
  } finally {
    fetch.mock.restore();
  }
});
