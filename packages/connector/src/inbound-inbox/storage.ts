import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { nowIso, nowUtcMs } from "@clawdentity/sdk";
import {
  DEFAULT_INDEX_LOCK_RETRY_MS,
  DEFAULT_INDEX_LOCK_STALE_MS,
  DEFAULT_INDEX_LOCK_TIMEOUT_MS,
  INBOUND_INBOX_SCHEMA_VERSION,
} from "./constants.js";
import { normalizeIndexFile, toDefaultIndexFile } from "./schema.js";
import type { InboundInboxEvent, InboundInboxIndexFile } from "./types.js";

type ReleaseLock = () => Promise<void>;

type InboundInboxStorageOptions = {
  eventsMaxBytes: number;
  eventsMaxFiles: number;
  eventsPath: string;
  inboxDir: string;
  indexLockPath: string;
  indexPath: string;
};

export class InboundInboxStorage {
  private readonly eventsMaxBytes: number;
  private readonly eventsMaxFiles: number;
  private readonly eventsPath: string;
  private readonly inboxDir: string;
  private readonly indexLockPath: string;
  private readonly indexPath: string;

  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: InboundInboxStorageOptions) {
    this.inboxDir = options.inboxDir;
    this.indexPath = options.indexPath;
    this.indexLockPath = options.indexLockPath;
    this.eventsPath = options.eventsPath;
    this.eventsMaxBytes = options.eventsMaxBytes;
    this.eventsMaxFiles = options.eventsMaxFiles;
  }

  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release: (() => void) | undefined;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    const releaseFileLock = await this.acquireIndexFileLock();
    try {
      return await fn();
    } finally {
      await releaseFileLock();
      release?.();
    }
  }

  async loadIndex(): Promise<InboundInboxIndexFile> {
    await mkdir(this.inboxDir, { recursive: true });

    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return toDefaultIndexFile();
      }

      throw error;
    }

    if (raw.trim().length === 0) {
      return toDefaultIndexFile();
    }

    const parsed = JSON.parse(raw) as unknown;
    return normalizeIndexFile(parsed);
  }

  async saveIndex(index: InboundInboxIndexFile): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });

    const payload = {
      ...index,
      version: INBOUND_INBOX_SCHEMA_VERSION,
      updatedAt: nowIso(),
    } satisfies InboundInboxIndexFile;

    const tmpPath = `${this.indexPath}.tmp-${nowUtcMs()}`;
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.indexPath);
  }

  async appendEvent(event: InboundInboxEvent): Promise<void> {
    await mkdir(dirname(this.eventsPath), { recursive: true });
    await appendFile(
      this.eventsPath,
      `${JSON.stringify({ ...event, at: nowIso() })}\n`,
      "utf8",
    );
    await this.rotateEventsIfNeeded();
  }

  private async acquireIndexFileLock(): Promise<ReleaseLock> {
    const startedAt = nowUtcMs();
    await mkdir(this.inboxDir, { recursive: true });

    while (true) {
      try {
        await writeFile(
          this.indexLockPath,
          `${JSON.stringify({ pid: process.pid, createdAt: nowIso() })}\n`,
          {
            encoding: "utf8",
            flag: "wx",
          },
        );

        let released = false;
        return async () => {
          if (released) {
            return;
          }
          released = true;
          try {
            await unlink(this.indexLockPath);
          } catch {
            // ignore
          }
        };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? (error as { code?: string }).code
            : undefined;
        if (code !== "EEXIST") {
          throw error;
        }

        const lockStats = await this.readLockStats();
        if (
          lockStats !== undefined &&
          nowUtcMs() - lockStats.mtimeMs > DEFAULT_INDEX_LOCK_STALE_MS
        ) {
          try {
            await unlink(this.indexLockPath);
          } catch {
            // ignore stale lock unlink race
          }
          continue;
        }

        if (nowUtcMs() - startedAt >= DEFAULT_INDEX_LOCK_TIMEOUT_MS) {
          throw new Error("Timed out waiting for inbound inbox index lock");
        }

        await this.sleep(DEFAULT_INDEX_LOCK_RETRY_MS);
      }
    }
  }

  private async readLockStats(): Promise<{ mtimeMs: number } | undefined> {
    try {
      const lockStat = await stat(this.indexLockPath);
      return { mtimeMs: lockStat.mtimeMs };
    } catch {
      return undefined;
    }
  }

  private async rotateEventsIfNeeded(): Promise<void> {
    if (this.eventsMaxBytes <= 0 || this.eventsMaxFiles <= 0) {
      return;
    }

    let currentSize: number;
    try {
      const current = await stat(this.eventsPath);
      currentSize = current.size;
    } catch {
      return;
    }

    if (currentSize <= this.eventsMaxBytes) {
      return;
    }

    for (let index = this.eventsMaxFiles; index >= 1; index -= 1) {
      const fromPath =
        index === 1 ? this.eventsPath : `${this.eventsPath}.${index - 1}`;
      const toPath = `${this.eventsPath}.${index}`;

      const fromExists = await this.pathExists(fromPath);
      if (!fromExists) {
        continue;
      }

      const toExists = await this.pathExists(toPath);
      if (toExists) {
        await unlink(toPath);
      }

      await rename(fromPath, toPath);
    }

    await writeFile(this.eventsPath, "", "utf8");
  }

  private async pathExists(pathValue: string): Promise<boolean> {
    try {
      await stat(pathValue);
      return true;
    } catch {
      return false;
    }
  }

  private async sleep(durationMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }
}
