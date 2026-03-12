import { createMiddleware } from "hono/factory";
import { nowIso, nowUtcMs } from "./datetime.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-context.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;
type LoggerOptions = {
  minLevel?: LogLevel;
};
type RequestLoggingOptions = {
  onlyErrors?: boolean;
  slowThresholdMs?: number;
  errorOrSlowLogLevel?: LogLevel;
};

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function writeLine(level: LogLevel, line: string): void {
  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
    default:
      console.log(line);
  }
}

function toLogLine(
  level: LogLevel,
  message: string,
  fields: LogFields,
  baseFields: LogFields,
): string {
  return JSON.stringify({
    timestamp: nowIso(),
    level,
    message,
    ...baseFields,
    ...fields,
  });
}

export type Logger = {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
  child: (fields: LogFields) => Logger;
};

export function createLogger(
  baseFields: LogFields = {},
  options: LoggerOptions = {},
): Logger {
  const minLevel = options.minLevel ?? "debug";
  const minPriority = LOG_LEVEL_PRIORITY[minLevel];
  const emit = (level: LogLevel, message: string, fields: LogFields = {}) => {
    if (LOG_LEVEL_PRIORITY[level] < minPriority) {
      return;
    }

    writeLine(level, toLogLine(level, message, fields, baseFields));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ ...baseFields, ...fields }, options),
  };
}

export function createRequestLoggingMiddleware(
  logger: Logger,
  options: RequestLoggingOptions = {},
) {
  const onlyErrors = options.onlyErrors ?? false;
  const slowThresholdMs = options.slowThresholdMs ?? 5_000;
  const errorOrSlowLogLevel = options.errorOrSlowLogLevel;

  return createMiddleware(async (c, next) => {
    const startedAt = nowUtcMs();
    let caughtError: unknown;

    try {
      await next();
    } catch (error) {
      caughtError = error;
    }

    const get = c.get as (key: string) => string | undefined;
    const requestId =
      get("requestId") ?? resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    const durationMs = nowUtcMs() - startedAt;
    const status = caughtError ? 500 : c.res.status;
    const isSlow = durationMs >= slowThresholdMs;
    const isError = status >= 400;

    if (!(onlyErrors && !isSlow && !isError)) {
      const completionLogLevel =
        (isSlow || isError) && errorOrSlowLogLevel
          ? errorOrSlowLogLevel
          : "info";

      logger[completionLogLevel]("request.completed", {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status,
        durationMs,
        ...(isSlow ? { slow: true } : {}),
      });
    }

    if (caughtError) {
      throw caughtError;
    }
  });
}
