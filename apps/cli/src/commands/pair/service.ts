import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { resolveConfig } from "../../config/manager.js";
import { assertValidAgentName } from "../agent-name.js";
import {
  assertTicketIssuerMatchesProxy,
  createCliError,
  DEFAULT_STATUS_POLL_INTERVAL_SECONDS,
  DEFAULT_STATUS_WAIT_SECONDS,
  logger,
  NONCE_SIZE,
  nowUnixSeconds,
  PAIR_CONFIRM_PATH,
  PAIR_START_PATH,
  PAIR_STATUS_PATH,
  parseAitAgentDid,
  parseNonEmptyString,
  parsePairingTicket,
  parsePositiveIntegerOption,
  parseTtlSeconds,
  toPeerProxyOriginFromConfirm,
  toPeerProxyOriginFromStatus,
  toResponderProfile,
} from "./common.js";
import { persistPairedPeer } from "./persistence.js";
import {
  buildSignedHeaders,
  executePairRequest,
  mapConfirmPairError,
  mapStartPairError,
  mapStatusPairError,
  parseJsonResponse,
  parsePairConfirmResponse,
  parsePairStartResponse,
  parsePairStatusResponse,
  readAgentProofMaterial,
  resolveProxyUrl,
  toIssuerProxyRequestUrl,
  toIssuerProxyUrl,
  toProxyRequestUrl,
} from "./proxy.js";
import {
  decodeTicketFromPng,
  persistPairingQr,
  resolveConfirmTicketSource,
} from "./qr.js";
import type {
  PairConfirmOptions,
  PairConfirmResult,
  PairRequestOptions,
  PairStartOptions,
  PairStartResult,
  PairStatusOptions,
  PairStatusResult,
} from "./types.js";

export async function startPairing(
  agentName: string,
  options: PairStartOptions,
  dependencies: PairRequestOptions = {},
): Promise<PairStartResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const nowSecondsImpl = dependencies.nowSecondsImpl ?? nowUnixSeconds;
  const nonceFactoryImpl =
    dependencies.nonceFactoryImpl ??
    (() => randomBytes(NONCE_SIZE).toString("base64url"));

  const ttlSeconds = parseTtlSeconds(options.ttlSeconds);
  const config = await resolveConfigImpl();
  const proxyUrl = await resolveProxyUrl({
    config,
    fetchImpl,
  });
  const normalizedAgentName = assertValidAgentName(agentName);
  const initiatorProfile = toResponderProfile({
    config,
    agentName: normalizedAgentName,
    localProxyUrl: proxyUrl,
  });

  const { ait, secretKey } = await readAgentProofMaterial(
    normalizedAgentName,
    dependencies,
  );

  const requestUrl = toProxyRequestUrl(proxyUrl, PAIR_START_PATH);
  const requestBody = JSON.stringify({
    ttlSeconds,
    initiatorProfile,
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
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const nowSecondsImpl = dependencies.nowSecondsImpl ?? nowUnixSeconds;
  const nonceFactoryImpl =
    dependencies.nonceFactoryImpl ??
    (() => randomBytes(NONCE_SIZE).toString("base64url"));
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const qrDecodeImpl = dependencies.qrDecodeImpl ?? decodeTicketFromPng;

  const config = await resolveConfigImpl();
  const normalizedAgentName = assertValidAgentName(agentName);
  const localProxyUrl = await resolveProxyUrl({
    config,
    fetchImpl,
  });
  const responderProfile = toResponderProfile({
    config,
    agentName: normalizedAgentName,
    localProxyUrl,
  });

  const ticketSource = resolveConfirmTicketSource(options);
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

  ticket = parsePairingTicket(ticket);
  const proxyUrl = toIssuerProxyUrl(ticket);

  const { ait, secretKey } = await readAgentProofMaterial(
    normalizedAgentName,
    dependencies,
  );

  const requestUrl = toIssuerProxyRequestUrl(ticket, PAIR_CONFIRM_PATH);
  const requestBody = JSON.stringify({
    ticket,
    responderProfile,
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
  const peerProxyOrigin = toPeerProxyOriginFromConfirm({
    ticket,
    initiatorProfile: parsed.initiatorProfile,
  });
  const peerAlias = await persistPairedPeer({
    ticket,
    peerDid: parsed.initiatorAgentDid,
    peerProfile: parsed.initiatorProfile,
    peerProxyOrigin,
    dependencies,
  });

  if (ticketSource.source === "qr-file" && ticketSource.qrFilePath) {
    const unlinkImpl = dependencies.unlinkImpl ?? unlink;
    await unlinkImpl(ticketSource.qrFilePath).catch((error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }

      logger.warn("cli.pair.confirm.qr_cleanup_failed", {
        path: ticketSource.qrFilePath,
        reason:
          error instanceof Error && error.message.length > 0
            ? error.message
            : "unknown",
      });
    });
  }

  return {
    ...parsed,
    proxyUrl,
    peerAlias,
  };
}

async function getPairingStatusOnce(
  agentName: string,
  options: { ticket: string },
  dependencies: PairRequestOptions = {},
): Promise<PairStatusResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const nowSecondsImpl = dependencies.nowSecondsImpl ?? nowUnixSeconds;
  const nonceFactoryImpl =
    dependencies.nonceFactoryImpl ??
    (() => randomBytes(NONCE_SIZE).toString("base64url"));

  const config = await resolveConfigImpl();
  const proxyUrl = await resolveProxyUrl({
    config,
    fetchImpl,
  });

  const ticket = parsePairingTicket(options.ticket);
  assertTicketIssuerMatchesProxy({
    ticket,
    proxyUrl,
    context: "status",
  });

  const { ait, secretKey } = await readAgentProofMaterial(
    agentName,
    dependencies,
  );
  const callerAgentDid = parseAitAgentDid(ait);

  const requestUrl = toProxyRequestUrl(proxyUrl, PAIR_STATUS_PATH);
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
      "CLI_PAIR_STATUS_FAILED",
      mapStatusPairError(response.status, responseBody),
    );
  }

  const parsed = parsePairStatusResponse(responseBody);
  let peerAlias: string | undefined;

  if (parsed.status === "confirmed") {
    const responderAgentDid = parsed.responderAgentDid;
    if (!responderAgentDid) {
      throw createCliError(
        "CLI_PAIR_STATUS_INVALID_RESPONSE",
        "Pair status response is invalid",
      );
    }

    const peerDid =
      callerAgentDid === parsed.initiatorAgentDid
        ? responderAgentDid
        : callerAgentDid === responderAgentDid
          ? parsed.initiatorAgentDid
          : undefined;
    const peerProfile =
      callerAgentDid === parsed.initiatorAgentDid
        ? parsed.responderProfile
        : callerAgentDid === responderAgentDid
          ? parsed.initiatorProfile
          : undefined;

    if (!peerDid) {
      throw createCliError(
        "CLI_PAIR_STATUS_FORBIDDEN",
        "Local agent is not a participant in the pairing ticket",
      );
    }

    if (!peerProfile) {
      throw createCliError(
        "CLI_PAIR_STATUS_INVALID_RESPONSE",
        "Pair status response is invalid",
      );
    }

    peerAlias = await persistPairedPeer({
      ticket,
      peerDid,
      peerProfile,
      peerProxyOrigin: toPeerProxyOriginFromStatus({
        callerAgentDid,
        initiatorAgentDid: parsed.initiatorAgentDid,
        responderAgentDid,
        initiatorProfile: parsed.initiatorProfile,
        responderProfile: parsed.responderProfile,
      }),
      dependencies,
    });
  }

  return {
    ...parsed,
    proxyUrl,
    peerAlias,
  };
}

export async function waitForPairingStatus(input: {
  agentName: string;
  ticket: string;
  waitSeconds: number;
  pollIntervalSeconds: number;
  dependencies: PairRequestOptions;
}): Promise<PairStatusResult> {
  const nowSecondsImpl = input.dependencies.nowSecondsImpl ?? nowUnixSeconds;
  const sleepImpl =
    input.dependencies.sleepImpl ??
    (async (ms: number) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    });

  const deadlineSeconds = nowSecondsImpl() + input.waitSeconds;
  while (true) {
    const status = await getPairingStatusOnce(
      input.agentName,
      { ticket: input.ticket },
      input.dependencies,
    );

    if (status.status === "confirmed") {
      return status;
    }

    const nowSeconds = nowSecondsImpl();
    if (nowSeconds >= deadlineSeconds) {
      throw createCliError(
        "CLI_PAIR_STATUS_WAIT_TIMEOUT",
        `Pairing is still pending after ${input.waitSeconds} seconds`,
      );
    }

    const remainingSeconds = Math.max(0, deadlineSeconds - nowSeconds);
    const sleepSeconds = Math.min(input.pollIntervalSeconds, remainingSeconds);
    await sleepImpl(sleepSeconds * 1000);
  }
}

export async function getPairingStatus(
  agentName: string,
  options: PairStatusOptions,
  dependencies: PairRequestOptions = {},
): Promise<PairStatusResult> {
  const ticketRaw = parseNonEmptyString(options.ticket);
  if (ticketRaw.length === 0) {
    throw createCliError(
      "CLI_PAIR_STATUS_TICKET_REQUIRED",
      "Pair status requires --ticket <clwpair1_...>",
    );
  }

  const ticket = parsePairingTicket(ticketRaw);
  if (options.wait !== true) {
    return getPairingStatusOnce(agentName, { ticket }, dependencies);
  }

  const waitSeconds = parsePositiveIntegerOption({
    value: options.waitSeconds,
    optionName: "waitSeconds",
    defaultValue: DEFAULT_STATUS_WAIT_SECONDS,
  });
  const pollIntervalSeconds = parsePositiveIntegerOption({
    value: options.pollIntervalSeconds,
    optionName: "pollIntervalSeconds",
    defaultValue: DEFAULT_STATUS_POLL_INTERVAL_SECONDS,
  });

  return waitForPairingStatus({
    agentName,
    ticket,
    waitSeconds,
    pollIntervalSeconds,
    dependencies,
  });
}
