import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { decodeBase64url } from "@clawdentity/protocol";
import { AppError, createLogger, signHttpRequest } from "@clawdentity/sdk";
import { Command } from "commander";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import {
  type CliConfig,
  getConfigDir,
  resolveConfig,
} from "../config/manager.js";
import { writeStdoutLine } from "../io.js";
import { assertValidAgentName } from "./agent-name.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "pair" });

const AGENTS_DIR_NAME = "agents";
const AIT_FILE_NAME = "ait.jwt";
const SECRET_KEY_FILE_NAME = "secret.key";
const PAIRING_QR_DIR_NAME = "pairing";

const PAIR_START_PATH = "/pair/start";
const PAIR_CONFIRM_PATH = "/pair/confirm";
const OWNER_PAT_HEADER = "x-claw-owner-pat";
const NONCE_SIZE = 24;
const PAIRING_TICKET_PREFIX = "clwpair1_";

export type PairStartOptions = {
  ownerPat?: string;
  proxyUrl?: string;
  ttlSeconds?: string;
  qr?: boolean;
  qrOutput?: string;
};

export type PairConfirmOptions = {
  proxyUrl?: string;
  qrFile?: string;
  ticket?: string;
};

type PairRequestOptions = {
  fetchImpl?: typeof fetch;
  getConfigDirImpl?: typeof getConfigDir;
  nowSecondsImpl?: () => number;
  nonceFactoryImpl?: () => string;
  readFileImpl?: typeof readFile;
  writeFileImpl?: typeof writeFile;
  mkdirImpl?: typeof mkdir;
  resolveConfigImpl?: () => Promise<CliConfig>;
  qrEncodeImpl?: (ticket: string) => Promise<Uint8Array>;
  qrDecodeImpl?: (imageBytes: Uint8Array) => string;
};

type PairCommandDependencies = PairRequestOptions;

type PairStartResult = {
  initiatorAgentDid: string;
  ticket: string;
  expiresAt: string;
  proxyUrl: string;
  qrPath?: string;
};

type PairConfirmResult = {
  paired: boolean;
  initiatorAgentDid: string;
  responderAgentDid: string;
  proxyUrl: string;
};

type RegistryErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};

type LocalAgentProofMaterial = {
  ait: string;
  secretKey: Uint8Array;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

function createCliError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    status: 400,
  });
}

function parseNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function parsePairingTicket(value: unknown): string {
  const ticket = parseNonEmptyString(value);
  if (!ticket.startsWith(PAIRING_TICKET_PREFIX)) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  return ticket;
}

function parseTtlSeconds(value: string | undefined): number | undefined {
  const raw = parseNonEmptyString(value);
  if (raw.length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw createCliError(
      "CLI_PAIR_START_INVALID_TTL",
      "ttlSeconds must be a positive integer",
    );
  }

  return parsed;
}

function resolveProxyUrl(overrideProxyUrl: string | undefined): string {
  const candidate =
    parseNonEmptyString(overrideProxyUrl) ||
    parseNonEmptyString(process.env.CLAWDENTITY_PROXY_URL);

  if (candidate.length === 0) {
    throw createCliError(
      "CLI_PAIR_PROXY_URL_REQUIRED",
      "Proxy URL is required. Pass --proxy-url <url> or set CLAWDENTITY_PROXY_URL.",
    );
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("invalid protocol");
    }

    return parsed.toString();
  } catch {
    throw createCliError("CLI_PAIR_INVALID_PROXY_URL", "Proxy URL is invalid");
  }
}

function toProxyRequestUrl(proxyUrl: string, path: string): string {
  const normalizedBase = proxyUrl.endsWith("/") ? proxyUrl : `${proxyUrl}/`;
  return new URL(path.slice(1), normalizedBase).toString();
}

function toPathWithQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function extractErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const envelope = payload as RegistryErrorEnvelope;
  if (!envelope.error || typeof envelope.error.code !== "string") {
    return undefined;
  }

  const code = envelope.error.code.trim();
  return code.length > 0 ? code : undefined;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const envelope = payload as RegistryErrorEnvelope;
  if (!envelope.error || typeof envelope.error.message !== "string") {
    return undefined;
  }

  const message = envelope.error.message.trim();
  return message.length > 0 ? message : undefined;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function executePairRequest(input: {
  fetchImpl: typeof fetch;
  init: RequestInit;
  url: string;
}): Promise<Response> {
  try {
    return await input.fetchImpl(input.url, input.init);
  } catch {
    throw createCliError(
      "CLI_PAIR_REQUEST_FAILED",
      "Unable to connect to proxy URL. Check network access and proxyUrl.",
    );
  }
}

function mapStartPairError(status: number, payload: unknown): string {
  const code = extractErrorCode(payload);
  const message = extractErrorMessage(payload);

  if (code === "PROXY_PAIR_OWNER_PAT_INVALID" || status === 401) {
    return message
      ? `Owner PAT is invalid (401): ${message}`
      : "Owner PAT is invalid or expired (401).";
  }

  if (code === "PROXY_PAIR_OWNER_PAT_FORBIDDEN" || status === 403) {
    return message
      ? `Owner PAT does not control initiator agent DID (403): ${message}`
      : "Owner PAT does not control initiator agent DID (403).";
  }

  if (status === 400) {
    return message
      ? `Pair start request is invalid (400): ${message}`
      : "Pair start request is invalid (400).";
  }

  if (status >= 500) {
    return `Proxy pairing service is unavailable (${status}).`;
  }

  if (message) {
    return `Pair start failed (${status}): ${message}`;
  }

  return `Pair start failed (${status})`;
}

function mapConfirmPairError(status: number, payload: unknown): string {
  const code = extractErrorCode(payload);
  const message = extractErrorMessage(payload);

  if (code === "PROXY_PAIR_TICKET_NOT_FOUND" || status === 404) {
    return "Pairing ticket is invalid or expired";
  }

  if (code === "PROXY_PAIR_TICKET_EXPIRED" || status === 410) {
    return "Pairing ticket has expired";
  }

  if (status === 400) {
    return message
      ? `Pair confirm request is invalid (400): ${message}`
      : "Pair confirm request is invalid (400).";
  }

  if (status >= 500) {
    return `Proxy pairing service is unavailable (${status}).`;
  }

  if (message) {
    return `Pair confirm failed (${status}): ${message}`;
  }

  return `Pair confirm failed (${status})`;
}

function parsePairStartResponse(
  payload: unknown,
): Omit<PairStartResult, "proxyUrl" | "qrPath"> {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_PAIR_START_INVALID_RESPONSE",
      "Pair start response is invalid",
    );
  }

  const ticket = parsePairingTicket(payload.ticket);
  const initiatorAgentDid = parseNonEmptyString(payload.initiatorAgentDid);
  const expiresAt = parseNonEmptyString(payload.expiresAt);

  if (initiatorAgentDid.length === 0 || expiresAt.length === 0) {
    throw createCliError(
      "CLI_PAIR_START_INVALID_RESPONSE",
      "Pair start response is invalid",
    );
  }

  return {
    ticket,
    initiatorAgentDid,
    expiresAt,
  };
}

function parsePairConfirmResponse(
  payload: unknown,
): Omit<PairConfirmResult, "proxyUrl"> {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_INVALID_RESPONSE",
      "Pair confirm response is invalid",
    );
  }

  const paired = payload.paired === true;
  const initiatorAgentDid = parseNonEmptyString(payload.initiatorAgentDid);
  const responderAgentDid = parseNonEmptyString(payload.responderAgentDid);

  if (
    !paired ||
    initiatorAgentDid.length === 0 ||
    responderAgentDid.length === 0
  ) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_INVALID_RESPONSE",
      "Pair confirm response is invalid",
    );
  }

  return {
    paired,
    initiatorAgentDid,
    responderAgentDid,
  };
}

async function readAgentProofMaterial(
  agentName: string,
  dependencies: PairRequestOptions,
): Promise<LocalAgentProofMaterial> {
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const getConfigDirImpl = dependencies.getConfigDirImpl ?? getConfigDir;
  const normalizedAgentName = assertValidAgentName(agentName);

  const agentDir = join(
    getConfigDirImpl(),
    AGENTS_DIR_NAME,
    normalizedAgentName,
  );
  const aitPath = join(agentDir, AIT_FILE_NAME);
  const secretKeyPath = join(agentDir, SECRET_KEY_FILE_NAME);

  let ait: string;
  try {
    ait = (await readFileImpl(aitPath, "utf-8")).trim();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw createCliError(
        "CLI_PAIR_AGENT_NOT_FOUND",
        `Agent "${normalizedAgentName}" is missing ${AIT_FILE_NAME}. Run agent create first.`,
      );
    }

    throw error;
  }

  if (ait.length === 0) {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      `Agent "${normalizedAgentName}" has an empty ${AIT_FILE_NAME}`,
    );
  }

  let encodedSecretKey: string;
  try {
    encodedSecretKey = (await readFileImpl(secretKeyPath, "utf-8")).trim();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw createCliError(
        "CLI_PAIR_AGENT_NOT_FOUND",
        `Agent "${normalizedAgentName}" is missing ${SECRET_KEY_FILE_NAME}. Run agent create first.`,
      );
    }

    throw error;
  }

  if (encodedSecretKey.length === 0) {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      `Agent "${normalizedAgentName}" has an empty ${SECRET_KEY_FILE_NAME}`,
    );
  }

  let secretKey: Uint8Array;
  try {
    secretKey = decodeBase64url(encodedSecretKey);
  } catch {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      `Agent "${normalizedAgentName}" has invalid ${SECRET_KEY_FILE_NAME}`,
    );
  }

  return {
    ait,
    secretKey,
  };
}

function resolveOwnerPat(options: {
  explicitOwnerPat: string | undefined;
  config: CliConfig;
}): string {
  const ownerPat =
    parseNonEmptyString(options.explicitOwnerPat) ||
    parseNonEmptyString(options.config.apiKey);

  if (ownerPat.length > 0) {
    return ownerPat;
  }

  throw createCliError(
    "CLI_PAIR_START_OWNER_PAT_REQUIRED",
    "Owner PAT is required. Pass --owner-pat <token> or configure API key with `clawdentity invite redeem` / `clawdentity config set apiKey <token>`.",
  );
}

async function buildSignedHeaders(input: {
  bodyBytes?: Uint8Array;
  method: string;
  requestUrl: string;
  secretKey: Uint8Array;
  timestampSeconds: number;
  nonce: string;
}): Promise<Record<string, string>> {
  const signed = await signHttpRequest({
    method: input.method,
    pathWithQuery: toPathWithQuery(input.requestUrl),
    timestamp: String(input.timestampSeconds),
    nonce: input.nonce,
    body: input.bodyBytes,
    secretKey: input.secretKey,
  });

  return signed.headers;
}

async function encodeTicketQrPng(ticket: string): Promise<Uint8Array> {
  const buffer = await QRCode.toBuffer(ticket, {
    type: "png",
    width: 512,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  return new Uint8Array(buffer);
}

function decodeTicketFromPng(imageBytes: Uint8Array): string {
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

async function persistPairingQr(input: {
  agentName: string;
  qrOutput: string | undefined;
  ticket: string;
  dependencies: PairRequestOptions;
  nowSeconds: number;
}): Promise<string> {
  const mkdirImpl = input.dependencies.mkdirImpl ?? mkdir;
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

  await mkdirImpl(dirname(outputPath), { recursive: true });
  const imageBytes = await qrEncodeImpl(input.ticket);
  await writeFileImpl(outputPath, imageBytes);

  return outputPath;
}

function resolveConfirmTicketSource(options: PairConfirmOptions): {
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

export async function startPairing(
  agentName: string,
  options: PairStartOptions,
  dependencies: PairRequestOptions = {},
): Promise<PairStartResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const nowSecondsImpl =
    dependencies.nowSecondsImpl ?? (() => Math.floor(Date.now() / 1000));
  const nonceFactoryImpl =
    dependencies.nonceFactoryImpl ??
    (() => randomBytes(NONCE_SIZE).toString("base64url"));

  const ttlSeconds = parseTtlSeconds(options.ttlSeconds);
  const proxyUrl = resolveProxyUrl(options.proxyUrl);

  const config = await resolveConfigImpl();
  const ownerPat = resolveOwnerPat({
    explicitOwnerPat: options.ownerPat,
    config,
  });

  const { ait, secretKey } = await readAgentProofMaterial(
    agentName,
    dependencies,
  );

  const requestUrl = toProxyRequestUrl(proxyUrl, PAIR_START_PATH);
  const requestBody = JSON.stringify({
    ttlSeconds,
  });
  const bodyBytes = new TextEncoder().encode(requestBody);

  const timestampSeconds = nowSecondsImpl();
  const nonce = nonceFactoryImpl();
  const signedHeaders = await buildSignedHeaders({
    method: "POST",
    requestUrl,
    bodyBytes,
    secretKey,
    timestampSeconds,
    nonce,
  });

  const response = await executePairRequest({
    fetchImpl,
    url: requestUrl,
    init: {
      method: "POST",
      headers: {
        authorization: `Claw ${ait}`,
        "content-type": "application/json",
        [OWNER_PAT_HEADER]: ownerPat,
        ...signedHeaders,
      },
      body: requestBody,
    },
  });

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw createCliError(
      "CLI_PAIR_START_FAILED",
      mapStartPairError(response.status, responseBody),
    );
  }

  const parsed = parsePairStartResponse(responseBody);
  const result: PairStartResult = {
    ...parsed,
    proxyUrl,
  };

  if (options.qr === true) {
    result.qrPath = await persistPairingQr({
      agentName,
      qrOutput: options.qrOutput,
      ticket: parsed.ticket,
      dependencies,
      nowSeconds: timestampSeconds,
    });
  }

  return result;
}

export async function confirmPairing(
  agentName: string,
  options: PairConfirmOptions,
  dependencies: PairRequestOptions = {},
): Promise<PairConfirmResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const nowSecondsImpl =
    dependencies.nowSecondsImpl ?? (() => Math.floor(Date.now() / 1000));
  const nonceFactoryImpl =
    dependencies.nonceFactoryImpl ??
    (() => randomBytes(NONCE_SIZE).toString("base64url"));
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const qrDecodeImpl = dependencies.qrDecodeImpl ?? decodeTicketFromPng;

  const ticketSource = resolveConfirmTicketSource(options);
  const proxyUrl = resolveProxyUrl(options.proxyUrl);

  let ticket = ticketSource.ticket;
  if (ticketSource.source === "qr-file") {
    if (!ticketSource.qrFilePath) {
      throw createCliError(
        "CLI_PAIR_CONFIRM_QR_FILE_REQUIRED",
        "QR file path is required",
      );
    }

    let imageBytes: Uint8Array;
    try {
      imageBytes = await readFileImpl(ticketSource.qrFilePath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        throw createCliError(
          "CLI_PAIR_CONFIRM_QR_FILE_NOT_FOUND",
          `QR file not found: ${ticketSource.qrFilePath}`,
        );
      }

      throw error;
    }

    ticket = parsePairingTicket(qrDecodeImpl(new Uint8Array(imageBytes)));
  }

  const { ait, secretKey } = await readAgentProofMaterial(
    agentName,
    dependencies,
  );

  const requestUrl = toProxyRequestUrl(proxyUrl, PAIR_CONFIRM_PATH);
  const requestBody = JSON.stringify({ ticket });
  const bodyBytes = new TextEncoder().encode(requestBody);

  const timestampSeconds = nowSecondsImpl();
  const nonce = nonceFactoryImpl();
  const signedHeaders = await buildSignedHeaders({
    method: "POST",
    requestUrl,
    bodyBytes,
    secretKey,
    timestampSeconds,
    nonce,
  });

  const response = await executePairRequest({
    fetchImpl,
    url: requestUrl,
    init: {
      method: "POST",
      headers: {
        authorization: `Claw ${ait}`,
        "content-type": "application/json",
        ...signedHeaders,
      },
      body: requestBody,
    },
  });

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_FAILED",
      mapConfirmPairError(response.status, responseBody),
    );
  }

  const parsed = parsePairConfirmResponse(responseBody);

  return {
    ...parsed,
    proxyUrl,
  };
}

export const createPairCommand = (
  dependencies: PairCommandDependencies = {},
): Command => {
  const pairCommand = new Command("pair").description(
    "Manage proxy trust pairing between agents",
  );

  pairCommand
    .command("start <agentName>")
    .description("Start pairing and issue one-time pairing ticket")
    .option(
      "--proxy-url <url>",
      "Initiator proxy base URL (or set CLAWDENTITY_PROXY_URL)",
    )
    .option(
      "--owner-pat <token>",
      "Owner PAT override (defaults to configured API key)",
    )
    .option("--ttl-seconds <seconds>", "Pairing ticket expiry in seconds")
    .option("--qr", "Generate a local QR file for sharing")
    .option("--qr-output <path>", "Write QR PNG to a specific file path")
    .action(
      withErrorHandling(
        "pair start",
        async (agentName: string, options: PairStartOptions) => {
          const result = await startPairing(agentName, options, dependencies);

          logger.info("cli.pair_started", {
            initiatorAgentDid: result.initiatorAgentDid,
            proxyUrl: result.proxyUrl,
            expiresAt: result.expiresAt,
            qrPath: result.qrPath,
          });

          writeStdoutLine("Pairing ticket created");
          writeStdoutLine(`Ticket: ${result.ticket}`);
          writeStdoutLine(`Initiator Agent DID: ${result.initiatorAgentDid}`);
          writeStdoutLine(`Expires At: ${result.expiresAt}`);
          if (result.qrPath) {
            writeStdoutLine(`QR File: ${result.qrPath}`);
          }
        },
      ),
    );

  pairCommand
    .command("confirm <agentName>")
    .description("Confirm pairing using one-time pairing ticket")
    .option("--ticket <ticket>", "One-time pairing ticket (clwpair1_...)")
    .option("--qr-file <path>", "Path to pairing QR PNG file")
    .option(
      "--proxy-url <url>",
      "Responder proxy base URL (or set CLAWDENTITY_PROXY_URL)",
    )
    .action(
      withErrorHandling(
        "pair confirm",
        async (agentName: string, options: PairConfirmOptions) => {
          const result = await confirmPairing(agentName, options, dependencies);

          logger.info("cli.pair_confirmed", {
            initiatorAgentDid: result.initiatorAgentDid,
            responderAgentDid: result.responderAgentDid,
            proxyUrl: result.proxyUrl,
          });

          writeStdoutLine("Pairing confirmed");
          writeStdoutLine(`Initiator Agent DID: ${result.initiatorAgentDid}`);
          writeStdoutLine(`Responder Agent DID: ${result.responderAgentDid}`);
          writeStdoutLine(`Paired: ${result.paired ? "true" : "false"}`);
        },
      ),
    );

  return pairCommand;
};
