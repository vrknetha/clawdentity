import type { Logger } from "@clawdentity/sdk";
import { type EnqueueFrame, enqueueFrameSchema } from "../frames.js";
import { sanitizeErrorReason } from "./helpers.js";
import type { ConnectorOutboundQueuePersistence } from "./types.js";

export type OutboundQueueMetricsSnapshot = {
  currentDepth: number;
  loadedFromPersistence: boolean;
  maxDepth: number;
  persistenceEnabled: boolean;
};

export class ConnectorOutboundQueueManager {
  private readonly persistence: ConnectorOutboundQueuePersistence | undefined;
  private readonly logger: Logger;

  private readonly queue: EnqueueFrame[] = [];
  private maxObservedDepth = 0;
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(input: {
    persistence: ConnectorOutboundQueuePersistence | undefined;
    logger: Logger;
  }) {
    this.persistence = input.persistence;
    this.logger = input.logger;
  }

  isPersistenceEnabled(): boolean {
    return this.persistence !== undefined;
  }

  getDepth(): number {
    return this.queue.length;
  }

  getMetricsSnapshot(): OutboundQueueMetricsSnapshot {
    return {
      currentDepth: this.queue.length,
      maxDepth: this.maxObservedDepth,
      loadedFromPersistence: this.loaded,
      persistenceEnabled: this.persistence !== undefined,
    };
  }

  enqueue(frame: EnqueueFrame): void {
    this.queue.push(frame);
    this.recordDepth();
    this.persist();
  }

  flush(input: {
    isConnected: () => boolean;
    sendFrame: (frame: EnqueueFrame) => boolean;
  }): void {
    if (!input.isConnected()) {
      return;
    }

    while (this.queue.length > 0 && input.isConnected()) {
      const nextFrame = this.queue[0];
      const sent = input.sendFrame(nextFrame);
      if (!sent) {
        return;
      }

      this.queue.shift();
      this.persist();
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (this.persistence === undefined) {
      this.loaded = true;
      return;
    }

    if (this.loadPromise !== undefined) {
      await this.loadPromise;
      return;
    }

    this.loadPromise = (async () => {
      try {
        const loadedFrames = await this.persistence?.load();
        if (!loadedFrames || loadedFrames.length === 0) {
          return;
        }

        const existingIds = new Set(this.queue.map((item) => item.id));
        const validLoadedFrames: EnqueueFrame[] = [];

        for (const candidate of loadedFrames) {
          const parsed = enqueueFrameSchema.safeParse(candidate);
          if (!parsed.success) {
            continue;
          }
          if (existingIds.has(parsed.data.id)) {
            continue;
          }

          validLoadedFrames.push(parsed.data);
          existingIds.add(parsed.data.id);
        }

        if (validLoadedFrames.length === 0) {
          return;
        }

        this.queue.unshift(...validLoadedFrames);
        this.recordDepth();
      } catch (error) {
        this.logger.warn("connector.outbound.persistence_load_failed", {
          reason: sanitizeErrorReason(error),
        });
      } finally {
        this.loaded = true;
      }
    })();

    await this.loadPromise;
  }

  private recordDepth(): void {
    this.maxObservedDepth = Math.max(this.maxObservedDepth, this.queue.length);
  }

  private persist(): void {
    if (this.persistence === undefined) {
      return;
    }

    this.saveChain = this.saveChain
      .then(async () => {
        await this.ensureLoaded();
        await this.persistence?.save([...this.queue]);
      })
      .catch((error) => {
        this.logger.warn("connector.outbound.persistence_save_failed", {
          reason: sanitizeErrorReason(error),
        });
      });
  }
}
