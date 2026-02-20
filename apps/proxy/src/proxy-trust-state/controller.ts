import { nowUtcMs } from "@clawdentity/sdk";
import { TRUST_STORE_ROUTES } from "../proxy-trust-store.js";
import { ProxyTrustStateHandlers } from "./handlers.js";
import { ProxyTrustStateStorage } from "./storage.js";

export class ProxyTrustState {
  private readonly handlers: ProxyTrustStateHandlers;
  private readonly storage: ProxyTrustStateStorage;

  constructor(state: DurableObjectState) {
    this.storage = new ProxyTrustStateStorage(state);
    this.handlers = new ProxyTrustStateHandlers(this.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === TRUST_STORE_ROUTES.createPairingTicket) {
      return this.handlers.handleCreatePairingTicket(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.confirmPairingTicket) {
      return this.handlers.handleConfirmPairingTicket(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.getPairingTicketStatus) {
      return this.handlers.handleGetPairingTicketStatus(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.upsertPair) {
      return this.handlers.handleUpsertPair(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.isPairAllowed) {
      return this.handlers.handleIsPairAllowed(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.isAgentKnown) {
      return this.handlers.handleIsAgentKnown(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.storage.runAlarmCleanup(nowUtcMs());
  }
}
