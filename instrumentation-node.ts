import { logger } from "@/lib/logger";

let runtimeLoggingRegistered = false;

export function registerNodeRuntimeLogging() {
  const processOn = process.on?.bind(process);

  if (runtimeLoggingRegistered || typeof processOn !== "function") {
    return;
  }

  runtimeLoggingRegistered = true;

  processOn("unhandledRejection", (reason) => {
    logger.error("runtime.unhandled_rejection", { reason });
  });

  processOn("uncaughtException", (error) => {
    logger.error("runtime.uncaught_exception", { error });
  });

  processOn("warning", (warning) => {
    logger.warn("runtime.warning", { warning });
  });
}
