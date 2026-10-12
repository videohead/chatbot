# Model capability probe

Multi-turn diagnostic that measures whether a chat model can carry a complex
task across several turns, not just answer a single prompt. This answers the
operational question "is this model able to respond through multiple turns
of a hard challenge?" separately from "is this model listed by LiteLLM?"

| Purpose | Location or name |
| --- | --- |
| Probe implementation | [`lib/ai/model-probe.ts`](../lib/ai/model-probe.ts) |
| API endpoint | [`app/(chat)/api/models/probe/route.ts`](../app/(chat)/api/models/probe/route.ts) |
| Method | `POST /api/models/probe` |
| Auth | Same `regular` user session guard as `GET /api/models` |
| Cost | Up to 3 model calls per invocation |
| Route timeout | 300 s (`maxDuration`) |

## What it measures

The probe runs an escalating three-turn conversation against one model and
scores each turn with deterministic checks. No judge model is involved:
every check is a string or numeric test against the model's reply.

| Turn | Challenge | Checks |
| --- | --- | --- |
| 1 | List primes between 10 and 40 | Correct primes present; no composites |
| 2 | Compute `prime:remainder` pairs (mod 4), same order | 8 pairs produced; remainders correct |
| 3 | Filter remainder-3 primes; reply `sum=..., count=...` | Sum is 120; count is 4 |

Turn 2 requires obeying a formatting constraint while reasoning over turn 1's
result. Turn 3 requires reusing turn 2's output. Multi-turn coherence is the
point: each turn builds on the previous one, which is where models that
"cannot return a response when presented with a complex challenge" fail.

A model that fails turn 1 stops the probe early; two further calls would
waste time and tokens.

## Scoring

Composite score is 0-100, weighting later turns more heavily because cross-turn
coherence is the capability being measured:

| Turn | Weight |
| --- | --- |
| 1 | 20% |
| 2 | 30% |
| 3 | 50% |

A fully passed turn earns its full weight. A partially passed turn (some
checks pass) earns half its weight proportional to checks passed. Verdicts:

| Score | Verdict |
| --- | --- |
| >= 70 | `adequate` |
| 30-69 | `degraded` |
| < 30 | `unusable` |

## Usage

The endpoint requires an authenticated session. With a browser session
cookie:

```bash
curl -X POST http://127.0.0.1:3000/api/models/probe \
  -H "Content-Type: application/json" \
  -H "Cookie: <session cookie>" \
  -d '{"modelId": "nvidia/qwen/qwen3.6-27b"}'
```

Only model ids that LiteLLM currently serves are accepted; the endpoint
validates against the deployment list and rejects unknown model strings
rather than forwarding arbitrary provider requests.

Example response:

```json
{
  "modelId": "nvidia/qwen/qwen3.6-27b",
  "probedAt": "2026-10-11T23:40:12.000Z",
  "score": 85,
  "verdict": "adequate",
  "turns": [
    {
      "turn": 1,
      "passed": true,
      "durationMs": 1820,
      "replyPreview": "11, 13, 17, 19, 23, 29, 31, 37",
      "checks": [
        { "description": "contains the correct primes", "passed": true },
        { "description": "includes no composite numbers from the range", "passed": true }
      ]
    }
  ]
}
```

Failures are reported per turn with a `failureReason` of `empty-reply`,
`error`, or `timeout`, plus a `replyPreview` (first 200 characters) for
inspection.

## Known gaps and further discovery

This is a first-cut diagnostic, not a final capability evaluation. Open
items, in rough priority order:

1. **Per-turn timeout is not enforced.** `ProbeTurn.timeoutMs` is defined but
   `runTurn` does not pass an abort signal to `generateText`; only the route
   level 300 s `maxDuration` bounds the whole probe. Fix: pass
   `AbortSignal.timeout(turn.timeoutMs)` to `generateText` and record a
   `timeout` failure reason on abort.
2. **Single probe shape.** The current challenge is math and instruction
   following. A model that aces it may still fail at long-form writing,
   tool-use chains, or code generation. Discovery task: define 2-3
   alternative probe suites (code, tool-use, long-context) and either select
   by suite parameter or run all and report a vector of scores.
3. **No historical tracking.** Each probe is stateless; nothing is persisted,
   so model ability over time or across LiteLLM reroutes is invisible.
   Discovery task: decide on a store (reuse the chat PostgreSQL with a
   `model_probe_results` table, or append to logs only) and whether probes
   should run on a schedule.
4. **No UI surface.** The endpoint is operator-only via curl. Discovery task:
   whether the model selector should show a probe badge, and how stale
   scores are re-probed.
5. **Refusal detection is untested.** The title generator has a refusal
   regex; the probe does not distinguish "cannot answer" from "refused to
   answer". Discovery task: classify refusals separately in `failureReason`.
6. **Token limits unbounded.** No `maxOutputTokens` is set on probe calls; a
   rambling model could inflate cost and duration. Discovery task: cap
   output tokens per turn.
7. **Verification of the deployed endpoint.** The route is deployed behind
   session auth, which curl from the host cannot satisfy without a cookie.
   End-to-end verification needs an authenticated browser session or a
   test harness with credentials.

## Related

- Model discovery and capability catalog: [`lib/ai/litellm.ts`](../lib/ai/litellm.ts)
- Model list endpoint: [`app/(chat)/api/models/route.ts`](../app/(chat)/api/models/route.ts)
- Operations contract: [`operations.md`](operations.md)
