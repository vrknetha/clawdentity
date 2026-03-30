export const DB_MUTATION_OPERATION = {
  AGENT_REGISTRATION_CHALLENGE_UPDATE: "agents.register.challenge.update",
  AGENT_REISSUE_UPDATE: "agents.reissue.update",
  INVITE_REDEEM_UPDATE: "invites.redeem.update",
  AGENT_AUTH_REFRESH_SESSION_UPDATE: "agentAuth.refresh.session.update",
  AGENT_AUTH_VALIDATE_SESSION_TOUCH: "agentAuth.validate.session.touch",
  ADMIN_BOOTSTRAP_HUMAN_INSERT: "admin.bootstrap.human.insert",
  ONBOARDING_STARTER_PASS_REDEEM_UPDATE: "onboarding.starterPass.redeem.update",
  GROUP_JOIN_TOKEN_USAGE_UPDATE: "groups.join.token.usage.update",
} as const;

export type DbMutationOperation =
  (typeof DB_MUTATION_OPERATION)[keyof typeof DB_MUTATION_OPERATION];
