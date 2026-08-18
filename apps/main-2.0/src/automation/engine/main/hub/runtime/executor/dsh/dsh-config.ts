import { DEFAULT_MODEL_ID } from "../../../../../shared/models";
import type { AgentChannel } from "../../../../../shared/types";

export const DSH_MODEL_CONFIGURATION_ERROR =
  'DSH does not support per-run model selection. Choose "Default" and configure the model in DSH settings.';

export function assertDshDefaultModel(modelId: string): void {
  if (modelId !== DEFAULT_MODEL_ID) throw new Error(DSH_MODEL_CONFIGURATION_ERROR);
}

export function dshEnvironment(channel: AgentChannel | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(channel?.environment ?? {}),
  };
}
