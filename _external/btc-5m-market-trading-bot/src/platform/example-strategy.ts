import type { StrategyPlugin } from "./contracts.js";

/** Minimal loadable plugin; replace onEvent with strategy decisions when ready. */
export function createStrategy(): StrategyPlugin {
  return { id: "observe", onEvent: () => [] };
}
