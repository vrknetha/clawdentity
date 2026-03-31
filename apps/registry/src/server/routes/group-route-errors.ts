import { AppError } from "@clawdentity/sdk";
import { MAX_GROUP_MEMBERS } from "../../group-lifecycle.js";

export function groupNotFoundError(): AppError {
  return new AppError({
    code: "GROUP_NOT_FOUND",
    message: "Group was not found",
    status: 404,
    expose: true,
  });
}

export function groupManageForbiddenError(): AppError {
  return new AppError({
    code: "GROUP_MANAGE_FORBIDDEN",
    message: "Group management access is forbidden",
    status: 403,
    expose: true,
  });
}

export function groupReadForbiddenError(): AppError {
  return new AppError({
    code: "GROUP_READ_FORBIDDEN",
    message: "Group read access is forbidden",
    status: 403,
    expose: true,
  });
}

export function groupJoinTokenInvalidError(): AppError {
  return new AppError({
    code: "GROUP_JOIN_TOKEN_INVALID",
    message: "Group join token is invalid",
    status: 400,
    expose: true,
  });
}

export function groupJoinTokenExpiredError(): AppError {
  return new AppError({
    code: "GROUP_JOIN_TOKEN_EXPIRED",
    message: "Group join token has expired",
    status: 400,
    expose: true,
  });
}

export function groupJoinTokenExhaustedError(): AppError {
  return new AppError({
    code: "GROUP_JOIN_TOKEN_EXHAUSTED",
    message: "Group join token has already been used",
    status: 409,
    expose: true,
  });
}

export function groupMemberLimitReachedError(): AppError {
  return new AppError({
    code: "GROUP_MEMBER_LIMIT_REACHED",
    message: `Group cannot have more than ${MAX_GROUP_MEMBERS} members`,
    status: 409,
    expose: true,
  });
}

export function groupCreateInvalidError(): AppError {
  return new AppError({
    code: "GROUP_CREATE_INVALID",
    message: "Group create payload is invalid",
    status: 400,
    expose: true,
  });
}

export function groupJoinTokenIssueInvalidError(): AppError {
  return new AppError({
    code: "GROUP_JOIN_TOKEN_ISSUE_INVALID",
    message: "Group join token payload is invalid",
    status: 400,
    expose: true,
  });
}

export function groupMemberNotFoundError(): AppError {
  return new AppError({
    code: "GROUP_MEMBER_NOT_FOUND",
    message: "Agent was not found",
    status: 404,
    expose: true,
  });
}

export function groupJoinForbiddenError(): AppError {
  return new AppError({
    code: "GROUP_JOIN_FORBIDDEN",
    message: "Agent is not allowed to join this group",
    status: 403,
    expose: true,
  });
}
