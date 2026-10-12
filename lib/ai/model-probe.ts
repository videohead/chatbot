// Server-only multi-turn model capability probe.
//
// "Is this model listed?" is not the same question as "can this model
// actually carry a complex task across turns?" This probe runs a short,
// escalating conversation against a single model and scores each turn,
// producing a composite measure of how able the model is to respond through
// multiple turns of a challenging interaction.

import { generateText } from "ai";
import { logger } from "@/lib/logger";
import { getLanguageModel } from "./providers";

const PROBE_TIMEOUT_MS = 60_000;

type ProbeTurn = {
  // The user-side challenge for this turn.
  challenge: string;
  // Checks applied to the model's reply. A turn passes only if every check
  // passes. Each check is cheap and deterministic: no judge model needed.
  checks: Array<{
    description: string;
    test: (reply: string) => boolean;
  }>;
  // Maximum seconds before this turn is scored as a timeout failure.
  timeoutMs: number;
};

type TurnResult = {
  checks: Array<{ description: string; passed: boolean }>;
  durationMs: number;
  failureReason?: "empty-reply" | "error" | "timeout";
  passed: boolean;
  replyPreview: string;
  turn: number;
};

export type ModelProbeResult = {
  modelId: string;
  probedAt: string;
  score: number; // 0-100
  turns: TurnResult[];
  verdict: "adequate" | "degraded" | "unusable";
};

// Escalating difficulty: turn 1 is a plain instruction-following task any
// functional model should pass; turn 2 requires obeying a formatting
// constraint while reasoning; turn 3 requires using the result of turn 2,
// which is where weak models fall apart.
const PROBE_TURNS: ProbeTurn[] = [
  {
    challenge:
      "List the prime numbers between 10 and 40 in ascending order, separated by commas. Reply with the list only.",
    checks: [
      {
        description: "contains the correct primes",
        test: (reply) => {
          const numbers = reply.match(/\d+/g) ?? [];
          const found = new Set(numbers.map(Number));
          const expected = [11, 13, 17, 19, 23, 29, 31, 37];
          return expected.every((prime) => found.has(prime));
        },
      },
      {
        description: "includes no composite numbers from the range",
        test: (reply) => {
          const numbers = (reply.match(/\d+/g) ?? []).map(Number);
          const composites = [
            10, 12, 14, 15, 16, 18, 20, 21, 22, 24, 25, 26, 27, 28, 30, 32, 33,
            34, 35, 36, 38, 39, 40,
          ];
          return !numbers.some((n) => composites.includes(n));
        },
      },
    ],
    timeoutMs: PROBE_TIMEOUT_MS,
  },
  {
    challenge:
      "Now take that list and, for each prime, compute its remainder when divided by 4. Reply as 'prime:remainder' pairs separated by commas, in the same order. Nothing else.",
    checks: [
      {
        description: "produces prime:remainder pairs",
        test: (reply) => {
          const pairs = reply.match(/(\d+)\s*:\s*(\d+)/g) ?? [];
          return pairs.length === 8;
        },
      },
      {
        description: "remainders are mathematically correct",
        test: (reply) => {
          const pairs = [...reply.matchAll(/(\d+)\s*:\s*(\d+)/g)];
          const expected: Record<number, number> = {
            11: 3,
            13: 1,
            17: 1,
            19: 3,
            23: 3,
            29: 1,
            31: 3,
            37: 1,
          };
          return pairs.every(([, prime, remainder]) => {
            const p = Number(prime);
            const r = Number(remainder);
            return expected[p] === r;
          });
        },
      },
    ],
    timeoutMs: PROBE_TIMEOUT_MS,
  },
  {
    challenge:
      "Finally, from those pairs select only the primes whose remainder is 3, and reply with their sum and their count as 'sum=<number>, count=<number>'. Nothing else.",
    checks: [
      {
        description: "sums only the remainder-3 primes correctly",
        test: (reply) => /sum\s*=\s*120\b/i.test(reply.replace(/\s/g, "")),
      },
      {
        description: "counts the remainder-3 primes correctly",
        test: (reply) => /count\s*=\s*4\b/i.test(reply.replace(/\s/g, "")),
      },
    ],
    timeoutMs: PROBE_TIMEOUT_MS,
  },
];

function preview(text: string) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

async function runTurn(
  modelId: string,
  history: Array<{ role: "assistant" | "user"; text: string }>,
  turn: ProbeTurn,
  turnIndex: number
): Promise<TurnResult> {
  const startedAt = Date.now();
  const messages = [
    ...history.map((m) => ({
      content: m.text,
      role: m.role,
    })),
    { content: turn.challenge, role: "user" as const },
  ];

  try {
    const { text } = await generateText({
      messages,
      model: getLanguageModel(modelId),
    });

    const durationMs = Date.now() - startedAt;
    const reply = text ?? "";
    if (!reply.trim()) {
      return {
        checks: turn.checks.map((c) => ({
          description: c.description,
          passed: false,
        })),
        durationMs,
        failureReason: "empty-reply",
        passed: false,
        replyPreview: "",
        turn: turnIndex + 1,
      };
    }

    const checks = turn.checks.map((check) => ({
      description: check.description,
      passed: check.test(reply),
    }));

    return {
      checks,
      durationMs,
      passed: checks.every((c) => c.passed),
      replyPreview: preview(reply),
      turn: turnIndex + 1,
    };
  } catch (error) {
    return {
      checks: turn.checks.map((c) => ({
        description: c.description,
        passed: false,
      })),
      durationMs: Date.now() - startedAt,
      failureReason: "error",
      passed: false,
      replyPreview: String(error).slice(0, 200),
      turn: turnIndex + 1,
    };
  }
}

/**
 * Probe a model with a multi-turn escalating challenge. Each turn is scored
 * on deterministic checks. The composite score weights later turns higher
 * because multi-turn coherence is what we are measuring.
 */
export async function probeModel(modelId: string): Promise<ModelProbeResult> {
  const startedAt = Date.now();
  const turns: TurnResult[] = [];
  const history: Array<{ role: "assistant" | "user"; text: string }> = [];

  for (const [index, turn] of PROBE_TURNS.entries()) {
    // Each turn's history depends on the previous turn's reply, so these
    // calls cannot run concurrently.
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design
    const result = await runTurn(modelId, history, turn, index);
    turns.push(result);
    history.push({ role: "user", text: turn.challenge });
    if (result.replyPreview || result.failureReason !== "timeout") {
      history.push({
        role: "assistant",
        text: result.replyPreview,
      });
    }

    // A model that cannot pass turn 1 will not pass turns 2-3; stop early.
    if (!result.passed && index === 0) {
      break;
    }
  }

  // Later turns weigh more: turn 3 is worth 50%, turn 2 30%, turn 1 20%.
  const weights = [0.2, 0.3, 0.5];
  let score = 0;
  for (const [index, result] of turns.entries()) {
    if (result.passed) {
      score += weights[index] ?? 0;
    } else {
      const turnChecks = result.checks.filter((c) => c.passed).length;
      const totalChecks = result.checks.length || 1;
      score += (weights[index] ?? 0) * (turnChecks / totalChecks) * 0.5;
    }
  }
  const composite = Math.round(score * 100);

  const result: ModelProbeResult = {
    modelId,
    probedAt: new Date().toISOString(),
    score: composite,
    turns,
    verdict:
      composite >= 70 ? "adequate" : composite >= 30 ? "degraded" : "unusable",
  };

  logger.info("model.probe.completed", {
    durationMs: Date.now() - startedAt,
    modelId,
    score: composite,
    verdict: result.verdict,
  });

  return result;
}
