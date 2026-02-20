import {
  AppError,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

type ValidationDetails = {
  fieldErrors: Record<string, string[]>;
  formErrors: string[];
};

export function invalidRegistration(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: ValidationDetails;
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "AGENT_REGISTRATION_INVALID",
    message: exposeDetails
      ? "Agent registration payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

export function invalidRegistrationChallenge(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: ValidationDetails;
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "AGENT_REGISTRATION_CHALLENGE_INVALID",
    message: exposeDetails
      ? "Agent registration challenge payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

export function registrationProofError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  code:
    | "AGENT_REGISTRATION_CHALLENGE_EXPIRED"
    | "AGENT_REGISTRATION_CHALLENGE_REPLAYED"
    | "AGENT_REGISTRATION_PROOF_MISMATCH"
    | "AGENT_REGISTRATION_PROOF_INVALID";
  message: string;
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: options.code,
    message: exposeDetails ? options.message : "Request could not be processed",
    status: 400,
    expose: true,
  });
}
