import { createMiddleware } from "hono/factory";
import { nowIso } from "./datetime.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-context.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

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

export function createLogger(baseFields: LogFields = {}): Logger {
  const emit = (level: LogLevel, message: string, fields: LogFields = {}) => {
    writeLine(level, toLogLine(level, message, fields, baseFields));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ ...baseFields, ...fields }),
  };
}

export function createRequestLoggingMiddleware(logger: Logger) {
  return createMiddleware(async (c, next) => {
    const startedAt = Date.now();
    let caughtError: unknown;

    try {
      await next();
    } catch (error) {
      caughtError = error;
      throw error;
    } finally {
      const get = c.get as (key: string) => string | undefined;
      const requestId =
        get("requestId") ?? resolveRequestId(c.req.header(REQUEST_ID_HEADER));

      logger.info("request.completed", {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: caughtError ? 500 : c.res.status,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}
