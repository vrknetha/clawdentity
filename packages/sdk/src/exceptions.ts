import type { Context } from "hono";
import type { Logger } from "./logging.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-context.js";

export type ErrorDetails = Record<string, unknown> | undefined;

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: ErrorDetails;
  readonly expose: boolean;

  constructor(options: {
    code: string;
    message: string;
    status: number;
    details?: ErrorDetails;
    expose?: boolean;
  }) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
    this.expose = options.expose ?? options.status < 500;
  }
}

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: ErrorDetails;
  };
};

function normalizeError(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: ErrorDetails;
  expose: boolean;
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
      expose: error.expose,
    };
  }

  return {
    status: 500,
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal Server Error",
    details: undefined,
    expose: false,
  };
}

export function toErrorEnvelope(
  error: unknown,
  requestId: string,
): { status: number; body: ErrorEnvelope } {
  const normalized = normalizeError(error);
  return {
    status: normalized.status,
    body: {
      error: {
        code: normalized.code,
        message: normalized.message,
        requestId,
        details: normalized.expose ? normalized.details : undefined,
      },
    },
  };
}

export function createHonoErrorHandler(logger: Logger) {
  return (error: unknown, c: Context): Response => {
    const get = c.get as (key: string) => string | undefined;
    const requestId =
      get("requestId") ?? resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    const response = toErrorEnvelope(error, requestId);

    logger.error("request.failed", {
      requestId,
      code: response.body.error.code,
      status: response.status,
      message:
        error instanceof Error ? error.message : response.body.error.message,
    });

    c.header(REQUEST_ID_HEADER, requestId);
    return c.json(response.body, response.status as 200);
  };
}
