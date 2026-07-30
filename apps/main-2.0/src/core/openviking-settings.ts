export const OPENVIKING_EXTRACTION_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type OpenVikingExtractionReasoningEffort =
  typeof OPENVIKING_EXTRACTION_REASONING_EFFORTS[number];
