import { describe, expect, it } from "vitest";
import {
  createOpenclawInviteCode,
  decodeOpenclawInviteCode,
} from "../openclaw.js";

describe("openclaw invite helpers", () => {
  it("creates and decodes invite codes", () => {
    const invite = createOpenclawInviteCode({
      did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      proxyUrl: "https://beta.example.com/hooks/agent",
      peerAlias: "beta",
      agentName: "beta",
      humanName: "Ira",
    });

    expect(invite.code.startsWith("clawd1_")).toBe(true);

    const decoded = decodeOpenclawInviteCode(invite.code);
    expect(decoded.v).toBe(1);
    expect(decoded.did).toBe("did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4");
    expect(decoded.proxyUrl).toBe("https://beta.example.com/hooks/agent");
    expect(decoded.alias).toBe("beta");
    expect(decoded.agentName).toBe("beta");
    expect(decoded.humanName).toBe("Ira");
    expect(decoded.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
