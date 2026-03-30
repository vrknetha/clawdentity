import { parseAgentDid, parseGroupId } from "@clawdentity/protocol";
import { AppError, createRegistryIdentityClient } from "@clawdentity/sdk";

export type GroupTrustAuthorizer = (input: {
  groupId: string;
  senderAgentDid: string;
  recipientAgentDid: string;
}) => Promise<void>;

function toMembershipDependencyError(error: unknown): AppError {
  if (
    error instanceof AppError &&
    (error.code === "PROXY_AUTH_FORBIDDEN" ||
      error.code === "PROXY_HOOK_GROUP_INVALID")
  ) {
    return error;
  }

  if (
    error instanceof AppError &&
    error.code === "IDENTITY_SERVICE_UNAUTHORIZED"
  ) {
    return new AppError({
      code: "PROXY_INTERNAL_AUTH_UNAUTHORIZED",
      message: "Proxy internal service authorization failed",
      status: 503,
      expose: true,
    });
  }

  if (
    error instanceof AppError &&
    error.code === "IDENTITY_SERVICE_INVALID_INPUT"
  ) {
    return new AppError({
      code: "PROXY_HOOK_GROUP_INVALID",
      message: "X-Claw-Group-Id must be a valid group ID",
      status: 400,
      expose: true,
    });
  }

  return new AppError({
    code: "PROXY_GROUP_MEMBERSHIP_UNAVAILABLE",
    message: "Group membership verification is unavailable",
    status: 503,
    expose: true,
  });
}

export function createRegistryGroupTrustAuthorizer(input: {
  fetchImpl?: typeof fetch;
  registryUrl: string;
  serviceId: string;
  serviceSecret: string;
}): GroupTrustAuthorizer {
  const identityClient = createRegistryIdentityClient({
    fetchImpl: input.fetchImpl,
    registryUrl: input.registryUrl,
    serviceId: input.serviceId,
    serviceSecret: input.serviceSecret,
  });

  return async ({
    groupId,
    senderAgentDid,
    recipientAgentDid,
  }): Promise<void> => {
    let normalizedGroupId: string;
    try {
      normalizedGroupId = parseGroupId(groupId);
      parseAgentDid(senderAgentDid);
      parseAgentDid(recipientAgentDid);
    } catch {
      throw new AppError({
        code: "PROXY_HOOK_GROUP_INVALID",
        message: "X-Claw-Group-Id must be a valid group ID",
        status: 400,
        expose: true,
      });
    }

    try {
      const [senderMembership, recipientMembership] = await Promise.all([
        identityClient.checkGroupMembership({
          groupId: normalizedGroupId,
          memberAgentDid: senderAgentDid,
        }),
        identityClient.checkGroupMembership({
          groupId: normalizedGroupId,
          memberAgentDid: recipientAgentDid,
        }),
      ]);

      if (!senderMembership.isMember || !recipientMembership.isMember) {
        throw new AppError({
          code: "PROXY_AUTH_FORBIDDEN",
          message: "Verified caller is not trusted for recipient",
          status: 403,
          expose: true,
        });
      }
    } catch (error) {
      throw toMembershipDependencyError(error);
    }
  };
}
