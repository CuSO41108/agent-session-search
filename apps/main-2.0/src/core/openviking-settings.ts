export const OPENVIKING_EXTRACTION_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const DEFAULT_OPENVIKING_CODEX_EXTRACTION_MODEL = "gpt-5.6-terra";
export const DEFAULT_OPENVIKING_RECALL_TOKEN_BUDGET = 1_200;
export const MIN_OPENVIKING_RECALL_TOKEN_BUDGET = 256;
export const MAX_OPENVIKING_RECALL_TOKEN_BUDGET = 8_192;

export type OpenVikingExtractionReasoningEffort =
  typeof OPENVIKING_EXTRACTION_REASONING_EFFORTS[number];

export function normalizeOpenVikingRecallTokenBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OPENVIKING_RECALL_TOKEN_BUDGET;
  return Math.max(
    MIN_OPENVIKING_RECALL_TOKEN_BUDGET,
    Math.min(MAX_OPENVIKING_RECALL_TOKEN_BUDGET, Math.floor(value)),
  );
}
