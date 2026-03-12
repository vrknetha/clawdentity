import { createMiddleware } from "hono/factory";
import { nowUtcMs } from "./datetime.js";

export const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function generateRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  const random = Math.random().toString(36).slice(2, 12);
  return `${nowUtcMs().toString(36)}-${random}`;
}

export function resolveRequestId(requestId?: string): string {
  if (requestId && REQUEST_ID_PATTERN.test(requestId)) {
    return requestId;
  }

  return generateRequestId();
}

export type RequestContextVariables = {
  requestId: string;
};

export function createRequestContextMiddleware() {
  return createMiddleware<{ Variables: RequestContextVariables }>(
    async (c, next) => {
      const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
      c.set("requestId", requestId);
      c.header(REQUEST_ID_HEADER, requestId);
      await next();
    },
  );
}
