import { applyRunHandlersPhaseOne } from "./run-handlers-phase-one.js";
import { applyRunHandlersPhaseTwo } from "./run-handlers-phase-two.js";
import type { FakeDbState } from "./types.js";

export function handleRunQuery(input: {
  query: string;
  normalizedQuery: string;
  params: unknown[];
  state: FakeDbState;
}): D1Result {
  const { query, normalizedQuery, params, state } = input;

  if (
    state.options.failBeginTransaction &&
    normalizedQuery.trim() === "begin"
  ) {
    throw new Error("Failed query: begin");
  }

  let changes = 0;

  changes = applyRunHandlersPhaseOne({
    query,
    normalizedQuery,
    params,
    changes,
    state,
  });
  changes = applyRunHandlersPhaseTwo({
    query,
    normalizedQuery,
    params,
    changes,
    state,
  });

  return { success: true, meta: { changes } } as D1Result;
}
