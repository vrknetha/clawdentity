import type { FakeDbState } from "./types.js";

export type RunHandlerPhaseInput = {
  query: string;
  normalizedQuery: string;
  params: unknown[];
  changes: number;
  state: FakeDbState;
};
