type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  error: 40,
  info: 20,
  warn: 30,
};

const configuredLevel = (
  process.env.CHATBOT_LOG_LEVEL ??
  process.env.LOG_LEVEL ??
  "debug"
).toLowerCase() as LogLevel;

const minimumLevel = LEVEL_PRIORITY[configuredLevel]
  ? configuredLevel
  : "debug";

const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|secret|token|api[-_]?key|credential|session/i;

function shouldLog(level: LogLevel) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minimumLevel];
}

function serializeError(error: Error): LogContext {
  return {
    cause: sanitizeValue(error.cause),
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED;
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey),
      ])
    );
  }

  return value;
}

function sanitizeContext(context: LogContext): LogContext {
  return sanitizeValue(context) as LogContext;
}

export function log(level: LogLevel, event: string, context: LogContext = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    event,
    level,
    service: "chatbot",
    timestamp: new Date().toISOString(),
    ...sanitizeContext(context),
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export const logger = {
  debug: (event: string, context?: LogContext) => log("debug", event, context),
  error: (event: string, context?: LogContext) => log("error", event, context),
  info: (event: string, context?: LogContext) => log("info", event, context),
  warn: (event: string, context?: LogContext) => log("warn", event, context),
};
