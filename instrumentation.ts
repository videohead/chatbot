import { OpenTelemetry } from "@ai-sdk/otel";
import { registerOTel } from "@vercel/otel";
import { registerTelemetry } from "ai";
import { logger } from "@/lib/logger";

export async function register() {
  registerOTel({ serviceName: "chatbot" });
  registerTelemetry(new OpenTelemetry());

  logger.info("runtime.instrumentation.registered", {
    logBodies: process.env.CHATBOT_LOG_BODIES === "true",
    logLevel: process.env.CHATBOT_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "debug",
    nodeEnv: process.env.NODE_ENV,
  });

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeRuntimeLogging } = await import(
      "./instrumentation-node"
    );
    registerNodeRuntimeLogging();
  }
}
