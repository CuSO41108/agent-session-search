import type { AgentChannel, ConfiguredAgent } from "../../../../shared/types";
import { useEffect, useRef, useState } from "react";

export function WorkflowNodeAgentSelect(props: {
  nodeTitle: string;
  configuredAgentId?: string;
  modelId?: string;
  configuredAgents: ConfiguredAgent[];
  channels: AgentChannel[];
  onSelect: (configuredAgentId: string | undefined) => void | Promise<void>;
  onSelectModel: (modelId: string | undefined) => void | Promise<void>;
}) {
  const [pendingValue, setPendingValue] = useState<string | undefined>(undefined);
  const requestRef = useRef(0);
  const selectedValue = pendingValue ?? props.configuredAgentId ?? "";
  const configuredAgent = props.configuredAgents.find((agent) => agent.id === selectedValue);
  const channel = props.channels.find((candidate) => candidate.id === configuredAgent?.channelId);
  const selectedModelId = props.modelId ?? configuredAgent?.modelId ?? "";
  useEffect(() => {
    if (pendingValue !== undefined && pendingValue !== "" && pendingValue === (props.configuredAgentId ?? "")) setPendingValue(undefined);
  }, [pendingValue, props.configuredAgentId]);
  return <><select
    className="workflow-node-agent-select nodrag nopan"
    aria-label={`Agent for ${props.nodeTitle}`}
    value={selectedValue}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.stopPropagation()}
    onChange={(event) => {
      event.stopPropagation();
      const next = event.currentTarget.value || undefined;
      const request = ++requestRef.current;
      setPendingValue(event.currentTarget.value);
      Promise.resolve(props.onSelect(next)).catch(() => {
        if (request === requestRef.current) setPendingValue(undefined);
      });
    }}
  >
    <option value="" disabled>Select Agent</option>
    {props.configuredAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.modelId}</option>)}
  </select>
  <select
    className="workflow-node-agent-select workflow-node-model-select nodrag nopan"
    aria-label={`Model for ${props.nodeTitle}`}
    value={selectedModelId}
    disabled={!configuredAgent || !channel?.models.length}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.stopPropagation()}
    onChange={(event) => {
      event.stopPropagation();
      void props.onSelectModel(event.currentTarget.value || undefined);
    }}
  >
    {!selectedModelId ? <option value="">Select Model</option> : null}
    {(channel?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
  </select></>;
}
