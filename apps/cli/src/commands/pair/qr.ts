import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { getConfigDir } from "../../config/manager.js";
import { assertValidAgentName } from "../agent-name.js";
import {
  createCliError,
  PAIRING_QR_DIR_NAME,
  PAIRING_QR_FILENAME_PATTERN,
  PAIRING_QR_MAX_AGE_SECONDS,
  parseNonEmptyString,
  parsePairingTicket,
} from "./common.js";
import type { PairConfirmOptions, PairRequestOptions } from "./types.js";

export async function encodeTicketQrPng(ticket: string): Promise<Uint8Array> {
  const buffer = await QRCode.toBuffer(ticket, {
    type: "png",
    width: 512,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  return new Uint8Array(buffer);
}

export function decodeTicketFromPng(imageBytes: Uint8Array): string {
  let decodedPng: PNG;
  try {
    decodedPng = PNG.sync.read(Buffer.from(imageBytes));
  } catch {
    throw createCliError(
      "CLI_PAIR_CONFIRM_QR_FILE_INVALID",
      "QR image file is invalid or unsupported",
    );
  }

  const imageData = new Uint8ClampedArray(
    decodedPng.data.buffer,
    decodedPng.data.byteOffset,
    decodedPng.data.byteLength,
  );

  const decoded = jsQR(imageData, decodedPng.width, decodedPng.height);
  if (!decoded || parseNonEmptyString(decoded.data).length === 0) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_QR_NOT_FOUND",
      "No pairing QR code was found in the image",
    );
  }

  return parsePairingTicket(decoded.data);
}

export async function persistPairingQr(input: {
  agentName: string;
  qrOutput: string | undefined;
  ticket: string;
  dependencies: PairRequestOptions;
  nowSeconds: number;
}): Promise<string> {
  const mkdirImpl = input.dependencies.mkdirImpl ?? mkdir;
  const readdirImpl = input.dependencies.readdirImpl ?? readdir;
  const unlinkImpl = input.dependencies.unlinkImpl ?? unlink;
  const writeFileImpl = input.dependencies.writeFileImpl ?? writeFile;
  const getConfigDirImpl = input.dependencies.getConfigDirImpl ?? getConfigDir;
  const qrEncodeImpl = input.dependencies.qrEncodeImpl ?? encodeTicketQrPng;

  const baseDir = join(getConfigDirImpl(), PAIRING_QR_DIR_NAME);
  const outputPath = parseNonEmptyString(input.qrOutput)
    ? resolve(input.qrOutput ?? "")
    : join(
        baseDir,
        `${assertValidAgentName(input.agentName)}-pair-${input.nowSeconds}.png`,
      );

  const existingFiles = await readdirImpl(baseDir).catch((error) => {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [] as string[];
    }

    throw error;
  });

  for (const fileName of existingFiles) {
    if (typeof fileName !== "string") {
      continue;
    }

    const match = PAIRING_QR_FILENAME_PATTERN.exec(fileName);
    if (!match) {
      continue;
    }

    const issuedAtSeconds = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(issuedAtSeconds)) {
      continue;
    }

    if (issuedAtSeconds + PAIRING_QR_MAX_AGE_SECONDS > input.nowSeconds) {
      continue;
    }

    const stalePath = join(baseDir, fileName);
    await unlinkImpl(stalePath).catch((error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }

      throw error;
    });
  }

  await mkdirImpl(dirname(outputPath), { recursive: true });
  const imageBytes = await qrEncodeImpl(input.ticket);
  await writeFileImpl(outputPath, imageBytes);

  return outputPath;
}

export function resolveConfirmTicketSource(options: PairConfirmOptions): {
  ticket: string;
  source: "ticket" | "qr-file";
  qrFilePath?: string;
} {
  const inlineTicket = parseNonEmptyString(options.ticket);
  const qrFile = parseNonEmptyString(options.qrFile);

  if (inlineTicket.length > 0 && qrFile.length > 0) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_INPUT_CONFLICT",
      "Provide either --ticket or --qr-file, not both",
    );
  }

  if (inlineTicket.length > 0) {
    return {
      ticket: parsePairingTicket(inlineTicket),
      source: "ticket",
    };
  }

  if (qrFile.length > 0) {
    return {
      ticket: "",
      source: "qr-file",
      qrFilePath: resolve(qrFile),
    };
  }

  throw createCliError(
    "CLI_PAIR_CONFIRM_TICKET_REQUIRED",
    "Pairing ticket is required. Pass --ticket <clwpair1_...> or --qr-file <path>.",
  );
}
