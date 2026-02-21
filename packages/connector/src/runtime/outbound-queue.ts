import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nowUtcMs } from "@clawdentity/sdk";
import type { ConnectorOutboundQueuePersistence } from "../client.js";
import { type EnqueueFrame, enqueueFrameSchema } from "../frames.js";
import {
  AGENTS_DIR_NAME,
  OUTBOUND_QUEUE_DIR_NAME,
  OUTBOUND_QUEUE_FILENAME,
} from "./constants.js";
import { sanitizeErrorReason } from "./errors.js";

function resolveOutboundQueuePath(input: {
  agentName: string;
  configDir: string;
}): string {
  return join(
    input.configDir,
    AGENTS_DIR_NAME,
    input.agentName,
    OUTBOUND_QUEUE_DIR_NAME,
    OUTBOUND_QUEUE_FILENAME,
  );
}

export function createOutboundQueuePersistence(input: {
  agentName: string;
  configDir: string;
  logger: {
    warn: (event: string, payload?: Record<string, unknown>) => void;
  };
}): ConnectorOutboundQueuePersistence {
  const queuePath = resolveOutboundQueuePath({
    configDir: input.configDir,
    agentName: input.agentName,
  });

  const load = async (): Promise<EnqueueFrame[]> => {
    let raw: string;
    try {
      raw = await readFile(queuePath, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return [];
      }

      input.logger.warn("connector.outbound.persistence_read_failed", {
        queuePath,
        reason: sanitizeErrorReason(error),
      });
      return [];
    }

    if (raw.trim().length === 0) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      input.logger.warn("connector.outbound.persistence_invalid_json", {
        queuePath,
        reason: sanitizeErrorReason(error),
      });
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const frames: EnqueueFrame[] = [];
    for (const candidate of parsed) {
      const parsedFrame = enqueueFrameSchema.safeParse(candidate);
      if (parsedFrame.success) {
        frames.push(parsedFrame.data);
      }
    }
    return frames;
  };

  const save = async (frames: EnqueueFrame[]): Promise<void> => {
    await mkdir(dirname(queuePath), { recursive: true });
    const tmpPath = `${queuePath}.tmp-${nowUtcMs()}-${Math.random().toString(16).slice(2)}`;
    await writeFile(tmpPath, `${JSON.stringify(frames, null, 2)}\n`, "utf8");
    await rename(tmpPath, queuePath);
  };

  return { load, save };
}
