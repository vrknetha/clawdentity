import { join } from "node:path";
import { getConfigDir } from "../../config/manager.js";

export const AGENTS_DIR_NAME = "agents";
export const AIT_FILE_NAME = "ait.jwt";
export const IDENTITY_FILE_NAME = "identity.json";
export const PUBLIC_KEY_FILE_NAME = "public.key";
export const SECRET_KEY_FILE_NAME = "secret.key";
export const REGISTRY_AUTH_FILE_NAME = "registry-auth.json";
export const FILE_MODE = 0o600;

export const getAgentsDirectory = (): string => {
  return join(getConfigDir(), AGENTS_DIR_NAME);
};

export const getAgentDirectory = (name: string): string => {
  return join(getAgentsDirectory(), name);
};

export const getAgentAitPath = (name: string): string => {
  return join(getAgentDirectory(name), AIT_FILE_NAME);
};

export const getAgentIdentityPath = (name: string): string => {
  return join(getAgentDirectory(name), IDENTITY_FILE_NAME);
};

export const getAgentPublicKeyPath = (name: string): string => {
  return join(getAgentDirectory(name), PUBLIC_KEY_FILE_NAME);
};

export const getAgentSecretKeyPath = (name: string): string => {
  return join(getAgentDirectory(name), SECRET_KEY_FILE_NAME);
};

export const getAgentRegistryAuthPath = (name: string): string => {
  return join(getAgentDirectory(name), REGISTRY_AUTH_FILE_NAME);
};
