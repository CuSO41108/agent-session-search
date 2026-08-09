import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Bot, Check, ChevronRight, CirclePause, Code2, GitBranch, Plus, RotateCcw, Save, ShieldCheck, Trash2 } from "lucide-react";
import type {
  WorkflowDefinition,
  WorkflowInputDefinition,
  WorkflowNode,
  WorkflowNodeInput,
  WorkflowOutputField,
  WorkflowRun,
  WorkflowValueType,
} from "../../../../automation/engine/shared/workflow/model";
import { validateWorkflowDefinition } from "../../../../automation/engine/shared/workflow/validation";
import { agentRecallAutomationService } from "../../../../automation/engine/renderer/src/app/services/agent-recall-service";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";
import { useAutomationStoreSnapshot } from "./automation-provider";
import { addWorkflowNode, createWorkflowDefinition, workflowConnections, type WorkflowNodeKind } from "./workflow-editor-model";

type EditorMode = "definition" | "run";

const valueTypes: WorkflowValueType[] = ["text", "number", "boolean", "file", "object", "list"];
const nodeKinds: Array<{ kind: WorkflowNodeKind; label: string; icon: typeof Bot }> = [
  { kind: "agent", label: "Agent", icon: Bot },
  { kind: "script", label: "Script", icon: Code2 },
  { kind: "review", label: "Review", icon: ShieldCheck },
  { kind: "approval", label: "Approval", icon: CirclePause },
];

function parseInputValue(type: WorkflowValueType, raw: string): unknown {
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  if (type === "object" || type === "list") return JSON.parse(raw) as unknown;
  return raw;
}

function blankOutput(index: number): WorkflowOutputField {
  return { key: `output${index}`, name: `Output ${index}`, description: "Describe this output", type: "text", required: true };
}

function withOutputType(field: WorkflowOutputField, type: WorkflowValueType): WorkflowOutputField {
  const next: WorkflowOutputField = { key: field.key, name: field.name, description: field.description, type, required: field.required };
  if (type === "object") next.fields = [{ key: "value", name: "Value", description: "Object value", type: "text", required: true }];
  if (type === "list") next.item = { key: "item", name: "Item", description: "List item", type: "text", required: true };
  return next;
}

function updateAt<T>(items: T[], index: number, value: T): T[] {
  return items.map((item, itemIndex) => itemIndex === index ? value : item);
}

function FieldText({ label, value, onChange, multiline = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}): ReactElement {
  return <label className="workflow-core-field"><span>{label}</span>{multiline
    ? <textarea value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    : <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />}</label>;
}

function OutputFieldEditor({ field, depth = 0, onChange, onDelete }: {
  field: WorkflowOutputField;
  depth?: number;
  onChange: (field: WorkflowOutputField) => void;
  onDelete: () => void;
}): ReactElement {
  return <div className={`workflow-core-schema-field depth-${depth}`}>
    <div className="workflow-core-schema-row">
      <input aria-label="Output key" value={field.key} onChange={(event) => onChange({ ...field, key: event.currentTarget.value })} />
      <input aria-label="Output name" value={field.name} onChange={(event) => onChange({ ...field, name: event.currentTarget.value })} />
      <select aria-label="Output type" value={field.type} onChange={(event) => onChange(withOutputType(field, event.currentTarget.value as WorkflowValueType))}>
        {valueTypes.map((type) => <option key={type} value={type}>{type}</option>)}
      </select>
      <label className="workflow-core-check"><input type="checkbox" checked={field.required} onChange={(event) => onChange({ ...field, required: event.currentTarget.checked })} /> required</label>
      <button type="button" className="icon-btn" aria-label="Delete output" onClick={onDelete}><Trash2 size={13} /></button>
    </div>
    <input aria-label="Output description" value={field.description} onChange={(event) => onChange({ ...field, description: event.currentTarget.value })} />
    {field.type === "object" && depth < 2 ? <div className="workflow-core-nested-fields">
      {(field.fields ?? []).map((child, index) => <OutputFieldEditor key={`${child.key}:${index}`} field={child} depth={depth + 1} onChange={(next) => onChange({ ...field, fields: updateAt(field.fields ?? [], index, next) })} onDelete={() => onChange({ ...field, fields: (field.fields ?? []).filter((_, itemIndex) => itemIndex !== index) })} />)}
      <button type="button" className="control-btn compact" onClick={() => onChange({ ...field, fields: [...(field.fields ?? []), blankOutput((field.fields?.length ?? 0) + 1)] })}><Plus size={12} /> Nested field</button>
    </div> : null}
    {field.type === "list" && field.item && depth < 2 ? <div className="workflow-core-nested-fields"><OutputFieldEditor field={field.item} depth={depth + 1} onChange={(item) => onChange({ ...field, item })} onDelete={() => undefined} /></div> : null}
  </div>;
}

function NodeInputEditor({ input, nodes, currentNodeId, workflowInputs, onChange, onDelete }: {
  input: WorkflowNodeInput;
  nodes: WorkflowNode[];
  currentNodeId: string;
  workflowInputs: WorkflowInputDefinition[];
  onChange: (input: WorkflowNodeInput) => void;
  onDelete: () => void;
}): ReactElement {
  const upstreamNodes = nodes.filter((node) => node.id !== currentNodeId);
  const setSource = (source: WorkflowNodeInput["source"]): void => {
    const base = { key: input.key, name: input.name, description: input.description, required: input.required };
    if (source === "workflow") onChange({ ...base, source, workflowInputKey: workflowInputs[0]?.key ?? "" });
    if (source === "workspace") onChange({ ...base, source, path: "." });
    if (source === "literal") onChange({ ...base, source, value: "" });
    if (source === "node") onChange({ ...base, source, nodeId: upstreamNodes[0]?.id ?? "", outputKey: upstreamNodes[0]?.outputs[0]?.key ?? "" });
  };
  const sourceNode = input.source === "node" ? nodes.find((node) => node.id === input.nodeId) : undefined;
  return <div className="workflow-core-schema-field">
    <div className="workflow-core-schema-row">
      <input aria-label="Input key" value={input.key} onChange={(event) => onChange({ ...input, key: event.currentTarget.value })} />
      <input aria-label="Input name" value={input.name} onChange={(event) => onChange({ ...input, name: event.currentTarget.value })} />
      <select aria-label="Input source" value={input.source} onChange={(event) => setSource(event.currentTarget.value as WorkflowNodeInput["source"])}>
        <option value="workflow">Workflow input</option><option value="node">Node output</option><option value="workspace">Workspace</option><option value="literal">Fixed value</option>
      </select>
      <label className="workflow-core-check"><input type="checkbox" checked={input.required} onChange={(event) => onChange({ ...input, required: event.currentTarget.checked })} /> required</label>
      <button type="button" className="icon-btn" aria-label="Delete input" onClick={onDelete}><Trash2 size={13} /></button>
    </div>
    <input aria-label="Input description" value={input.description} onChange={(event) => onChange({ ...input, description: event.currentTarget.value })} />
    {input.source === "workflow" ? <select value={input.workflowInputKey} onChange={(event) => onChange({ ...input, workflowInputKey: event.currentTarget.value })}>{workflowInputs.map((item) => <option key={item.key} value={item.key}>{item.name} · {item.key}</option>)}</select> : null}
    {input.source === "workspace" ? <input value={input.path ?? "."} onChange={(event) => onChange({ ...input, path: event.currentTarget.value })} /> : null}
    {input.source === "literal" ? <input value={String(input.value ?? "")} onChange={(event) => onChange({ ...input, value: event.currentTarget.value })} /> : null}
    {input.source === "node" ? <div className="workflow-core-ref-row">
      <select value={input.nodeId} onChange={(event) => { const node = nodes.find((item) => item.id === event.currentTarget.value); onChange({ ...input, nodeId: event.currentTarget.value, outputKey: node?.outputs[0]?.key ?? "" }); }}>{upstreamNodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select>
      <ChevronRight size={14} />
      <select value={input.outputKey} onChange={(event) => onChange({ ...input, outputKey: event.currentTarget.value })}>{sourceNode?.outputs.map((output) => <option key={output.key} value={output.key}>{output.name} · {output.key}</option>)}</select>
    </div> : null}
  </div>;
}

function NodeInspector({ definition, node, agentIds, onChange, onDelete }: {
  definition: WorkflowDefinition;
  node: WorkflowNode;
  agentIds: Array<{ id: string; name: string }>;
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
}): ReactElement {
  const changeInputs = (inputs: WorkflowNodeInput[]): void => onChange({ ...node, inputs } as WorkflowNode);
  const changeOutputs = (outputs: WorkflowOutputField[]): void => onChange({ ...node, outputs } as WorkflowNode);
  return <div className="workflow-core-inspector-content">
    <div className="workflow-core-inspector-title"><span>{node.kind}</span><button type="button" className="icon-btn" onClick={onDelete} aria-label="Delete node"><Trash2 size={14} /></button></div>
    <FieldText label="Name" value={node.title} onChange={(title) => onChange({ ...node, title } as WorkflowNode)} />
    <FieldText label="Goal" multiline value={node.goal} onChange={(goal) => onChange({ ...node, goal } as WorkflowNode)} />
    {(node.kind === "agent" || node.kind === "review") ? <label className="workflow-core-field"><span>Agent</span><select value={node.agentId} onChange={(event) => onChange({ ...node, agentId: event.currentTarget.value })}>{agentIds.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label> : null}
    {(node.kind === "agent" || node.kind === "review") ? <>
      <FieldText label="Instructions (one per line)" multiline value={node.instructions.join("\n")} onChange={(value) => onChange({ ...node, instructions: value.split("\n").filter(Boolean) })} />
      <FieldText label="Constraints (one per line)" multiline value={node.constraints.join("\n")} onChange={(value) => onChange({ ...node, constraints: value.split("\n").filter(Boolean) })} />
    </> : null}
    {node.kind === "script" ? <>
      <label className="workflow-core-field"><span>Runtime</span><select value={node.runtime} onChange={(event) => onChange({ ...node, runtime: event.currentTarget.value as typeof node.runtime })}><option value="bash">Bash</option><option value="python">Python</option><option value="typescript">TypeScript</option></select></label>
      <FieldText label="Source" multiline value={node.source} onChange={(source) => onChange({ ...node, source })} />
      <label className="workflow-core-field"><span>Timeout (seconds)</span><input type="number" min="1" value={node.timeoutSeconds} onChange={(event) => onChange({ ...node, timeoutSeconds: Number(event.currentTarget.value) })} /></label>
    </> : null}
    {node.kind === "review" ? <>
      <FieldText label="Review criteria (one per line)" multiline value={node.criteria.map((item) => item.description).join("\n")} onChange={(value) => onChange({ ...node, criteria: value.split("\n").filter(Boolean).map((description, index) => ({ key: `criterion${index + 1}`, description })) })} />
      <label className="workflow-core-field"><span>Revision attempts</span><input type="number" min="0" value={node.maxRevisions} onChange={(event) => onChange({ ...node, maxRevisions: Number(event.currentTarget.value) })} /></label>
    </> : null}
    {node.kind === "approval" ? <FieldText label="Decision message" multiline value={node.message} onChange={(message) => onChange({ ...node, message })} /> : null}
    <section className="workflow-core-schema-section"><header><strong>Inputs</strong><button type="button" className="control-btn compact" onClick={() => changeInputs([...node.inputs, { key: `input${node.inputs.length + 1}`, name: `Input ${node.inputs.length + 1}`, description: "Describe this input", required: true, source: "literal", value: "" }])}><Plus size={12} /> Field</button></header>
      {node.inputs.length === 0 ? <p className="workflow-core-muted">No inputs. Add a field to consume Workflow data, workspace context, or another node output.</p> : node.inputs.map((input, index) => <NodeInputEditor key={`${input.key}:${index}`} input={input} nodes={definition.nodes} currentNodeId={node.id} workflowInputs={definition.inputs} onChange={(next) => changeInputs(updateAt(node.inputs, index, next))} onDelete={() => changeInputs(node.inputs.filter((_, itemIndex) => itemIndex !== index))} />)}
    </section>
    <section className="workflow-core-schema-section"><header><strong>Outputs</strong><button type="button" className="control-btn compact" onClick={() => changeOutputs([...node.outputs, blankOutput(node.outputs.length + 1)])}><Plus size={12} /> Field</button></header>
      {node.outputs.map((output, index) => <OutputFieldEditor key={`${output.key}:${index}`} field={output} onChange={(next) => changeOutputs(updateAt(node.outputs, index, next))} onDelete={() => changeOutputs(node.outputs.filter((_, itemIndex) => itemIndex !== index))} />)}
    </section>
    <FieldText label="Completion criteria (one per line)" multiline value={node.acceptanceCriteria.join("\n")} onChange={(value) => onChange({ ...node, acceptanceCriteria: value.split("\n").filter(Boolean) } as WorkflowNode)} />
  </div>;
}

function DefinitionInspector({ definition, onChange }: { definition: WorkflowDefinition; onChange: (definition: WorkflowDefinition) => void }): ReactElement {
  return <div className="workflow-core-inspector-content">
    <div className="workflow-core-inspector-title"><span>Workflow definition</span></div>
    <FieldText label="Name" value={definition.name} onChange={(name) => onChange({ ...definition, name })} />
    <FieldText label="Description" multiline value={definition.description} onChange={(description) => onChange({ ...definition, description })} />
    <section className="workflow-core-schema-section"><header><strong>Workflow inputs</strong><button type="button" className="control-btn compact" onClick={() => onChange({ ...definition, inputs: [...definition.inputs, { key: `input${definition.inputs.length + 1}`, name: `Input ${definition.inputs.length + 1}`, description: "Describe this input", type: "text", required: true }] })}><Plus size={12} /> Field</button></header>
      {definition.inputs.map((input, index) => <div className="workflow-core-schema-field" key={`${input.key}:${index}`}><div className="workflow-core-schema-row">
        <input value={input.key} aria-label="Workflow input key" onChange={(event) => onChange({ ...definition, inputs: updateAt(definition.inputs, index, { ...input, key: event.currentTarget.value }) })} />
        <input value={input.name} aria-label="Workflow input name" onChange={(event) => onChange({ ...definition, inputs: updateAt(definition.inputs, index, { ...input, name: event.currentTarget.value }) })} />
        <select value={input.type} onChange={(event) => onChange({ ...definition, inputs: updateAt(definition.inputs, index, { ...input, type: event.currentTarget.value as WorkflowValueType }) })}>{valueTypes.map((type) => <option key={type}>{type}</option>)}</select>
        <label className="workflow-core-check"><input type="checkbox" checked={input.required} onChange={(event) => onChange({ ...definition, inputs: updateAt(definition.inputs, index, { ...input, required: event.currentTarget.checked }) })} /> required</label>
        <button type="button" className="icon-btn" onClick={() => onChange({ ...definition, inputs: definition.inputs.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={13} /></button>
      </div><input value={input.description} aria-label="Workflow input description" onChange={(event) => onChange({ ...definition, inputs: updateAt(definition.inputs, index, { ...input, description: event.currentTarget.value }) })} /></div>)}
    </section>
  </div>;
}

function RunInspector({ run, selectedNodeId, onRetry, onApprove }: {
  run?: WorkflowRun;
  selectedNodeId?: string;
  onRetry: (nodeId: string) => void;
  onApprove: (nodeId: string, decision: string) => void;
}): ReactElement {
  if (!run) return <div className="workflow-core-empty">Run this Workflow to inspect node inputs, outputs, errors, and approvals.</div>;
  const node = run.definition.nodes.find((item) => item.id === selectedNodeId) ?? run.definition.nodes[0];
  const state = node ? run.nodeRuns[node.id] : undefined;
  if (!node || !state) return <div className="workflow-core-empty">Select a node.</div>;
  return <div className="workflow-core-inspector-content">
    <div className="workflow-core-inspector-title"><span>{node.title}</span><em className={`workflow-core-status is-${state.status}`}>{state.status}</em></div>
    <p className="workflow-core-muted">Attempt {state.attempt}</p>
    {state.error ? <div className="workflow-core-error"><strong>{state.error.code}</strong><p>{state.error.message}</p>{state.error.fieldPath ? <code>{state.error.fieldPath}</code> : null}</div> : null}
    {state.status === "failed" ? <button type="button" className="control-btn" onClick={() => onRetry(node.id)}><RotateCcw size={14} /> Retry this node</button> : null}
    {node.kind === "approval" && state.status === "waiting" ? <section className="workflow-core-approval"><p>{node.message}</p>{node.options.map((option) => <button type="button" className="control-btn" key={option.value} onClick={() => onApprove(node.id, option.value)}>{option.label}<small>{option.description}</small></button>)}</section> : null}
    <section className="workflow-core-run-data"><strong>Resolved inputs</strong>{Object.entries(state.resolvedInputs ?? {}).map(([key, value]) => <div key={key}><span>{key}</span><pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></div>)}</section>
    <section className="workflow-core-run-data"><strong>Validated outputs</strong>{Object.entries(state.outputs ?? {}).map(([key, value]) => <div key={key}><span>{key}</span><pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></div>)}</section>
  </div>;
}

export function WorkflowFeaturePage({ language }: { language: LanguageMode; globalReviewEnabled: boolean; runtimeReviewEnabled: boolean }): ReactElement {
  const api = useMemo(() => agentRecallAutomationService(), []);
  const automation = useAutomationStoreSnapshot();
  const agents = automation.configuredAgents.map((agent) => ({ id: agent.id, name: agent.name }));
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<WorkflowDefinition>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [mode, setMode] = useState<EditorMode>("definition");
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (preferId?: string) => {
    const snapshot = await api.getWorkflowCore(preferId);
    setDefinitions(snapshot.definitions);
    setRuns(snapshot.runs);
    const nextId = preferId ?? selectedId ?? snapshot.definitions[0]?.id;
    setSelectedId(nextId);
    const next = snapshot.definitions.find((item) => item.id === nextId);
    if (next) setDraft(structuredClone(next));
  }, [api, selectedId]);

  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const activeRun = runs.filter((run) => run.workflowId === selectedId).sort((left, right) => right.startedAt - left.startedAt)[0];
  useEffect(() => {
    if (!activeRun || (activeRun.status !== "running" && activeRun.status !== "waiting")) return;
    const timer = window.setInterval(() => void load(selectedId).catch(() => undefined), 1200);
    return () => window.clearInterval(timer);
  }, [activeRun?.id, activeRun?.status, load, selectedId]);

  const issues = draft ? validateWorkflowDefinition(draft, new Set(agents.map((agent) => agent.id))) : [];
  const connections = draft ? workflowConnections(draft) : [];
  const selectedNode = draft?.nodes.find((node) => node.id === selectedNodeId);
  const selectDefinition = (definition: WorkflowDefinition): void => {
    setSelectedId(definition.id); setDraft(structuredClone(definition)); setSelectedNodeId(undefined); setMode("definition"); setError(undefined);
    void load(definition.id).catch(() => undefined);
  };
  const save = async (): Promise<WorkflowDefinition | undefined> => {
    if (!draft) return undefined;
    setBusy(true); setError(undefined);
    try {
      const next = { ...draft, updatedAt: Date.now() };
      const saved = await api.saveWorkflowDefinition(next);
      setDraft(saved);
      await load(saved.id);
      return saved;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return undefined; } finally { setBusy(false); }
  };
  const start = async (): Promise<void> => {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      const inputs = Object.fromEntries(saved.inputs.map((input) => [input.key, parseInputValue(input.type, runInputs[input.key] ?? "") ]));
      const run = await api.startWorkflowRun(saved.id, inputs);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]); setMode("run");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const updateNode = (node: WorkflowNode): void => setDraft((current) => current ? { ...current, nodes: current.nodes.map((item) => item.id === node.id ? node : item) } : current);

  return <div className="automation-page automation-workflow-page workflow-core-page" data-page="workflows">
    <header className="app-page-head automation-page-head"><div><h2>Workflow</h2><p>{localize(language, "Build dependable automations from explicit inputs, nodes, and described outputs.", "用明确的输入、节点和带描述的输出构建可靠自动化。")}</p></div></header>
    <div className="workflow-core-shell">
      <aside className="workflow-core-list"><header><strong>Workflows</strong><button type="button" className="icon-btn" aria-label="New Workflow" onClick={() => { const next = createWorkflowDefinition(agents[0]?.id ?? ""); setDefinitions((current) => [next, ...current]); setDraft(next); setSelectedId(next.id); setSelectedNodeId(undefined); setMode("definition"); }}><Plus size={16} /></button></header>
        <div>{definitions.map((definition) => <button type="button" key={definition.id} className={definition.id === selectedId ? "is-active" : ""} onClick={() => selectDefinition(definition)}><strong>{definition.name}</strong><span>{definition.nodes.length} nodes</span><small>{definition.description}</small></button>)}</div>
      </aside>
      {!draft ? <main className="workflow-core-empty">Create a Workflow to begin.</main> : <main className="workflow-core-main">
        <header className="workflow-core-toolbar"><div className="workflow-core-mode"><button type="button" className={mode === "definition" ? "is-active" : ""} onClick={() => setMode("definition")}>Definition</button><button type="button" className={mode === "run" ? "is-active" : ""} onClick={() => setMode("run")}>Current run{activeRun ? ` · ${activeRun.status}` : ""}</button></div><div>
          <button type="button" className="control-btn compact" disabled={busy} onClick={() => void save()}><Save size={13} /> Save</button>
          {activeRun && (activeRun.status === "running" || activeRun.status === "waiting") ? <button type="button" className="control-btn compact" disabled={busy} onClick={() => void api.cancelWorkflowRun(activeRun.id).then((run) => setRuns((current) => current.map((item) => item.id === run.id ? run : item)))}><CirclePause size={13} /> Cancel</button> : <button type="button" className="send-btn compact" disabled={busy || issues.length > 0} onClick={() => void start()}><GitBranch size={13} /> Run</button>}
          <button type="button" className="icon-btn" aria-label="Delete Workflow" onClick={() => { if (!window.confirm(`Delete ${draft.name}?`)) return; void api.deleteWorkflowDefinition(draft.id).then(() => { setDefinitions((current) => current.filter((item) => item.id !== draft.id)); setDraft(undefined); setSelectedId(undefined); }); }}><Trash2 size={14} /></button>
        </div></header>
        {error ? <div className="workflow-core-banner is-error">{error}</div> : null}
        {issues.length > 0 && mode === "definition" ? <div className="workflow-core-banner"><strong>{issues.length} definition issue{issues.length === 1 ? "" : "s"}</strong><span>{issues[0]!.path}: {issues[0]!.message}</span></div> : null}
        <div className="workflow-core-workbench">
          <section className="workflow-core-canvas" onClick={() => setSelectedNodeId(undefined)}>
            <div className="workflow-core-flow">
              {draft.nodes.map((node, index) => {
                const kind = nodeKinds.find((item) => item.kind === node.kind)!; const Icon = kind.icon; const state = activeRun?.nodeRuns[node.id];
                const incoming = connections.filter((connection) => connection.toNodeId === node.id);
                return <div className="workflow-core-node-wrap" key={node.id}>{index > 0 ? <div className="workflow-core-connector">{incoming.length ? incoming.map((connection) => <span key={`${connection.fromNodeId}:${connection.toInputKey}`}>{connection.fromNodeId}.{connection.fromOutputKey} → {connection.toInputKey}</span>) : <span>independent branch</span>}</div> : null}<button type="button" className={`workflow-core-node ${selectedNodeId === node.id ? "is-active" : ""}`} onClick={(event) => { event.stopPropagation(); setSelectedNodeId(node.id); }}><span className={`workflow-core-kind is-${node.kind}`}><Icon size={14} /> {kind.label}</span><strong>{node.title}</strong><p>{node.goal}</p><footer><span>{node.inputs.length} inputs</span><span>{node.outputs.length} outputs</span>{mode === "run" && state ? <em className={`workflow-core-status is-${state.status}`}>{state.status}</em> : null}</footer></button></div>;
              })}
              {mode === "definition" ? <div className="workflow-core-add-row">{nodeKinds.map(({ kind, label, icon: Icon }) => <button type="button" className="control-btn compact" key={kind} onClick={() => { const next = addWorkflowNode(draft, kind, agents[0]?.id ?? ""); setDraft(next); setSelectedNodeId(next.nodes.at(-1)?.id); }}><Icon size={13} /> {label}</button>)}</div> : null}
            </div>
            {mode === "definition" && draft.inputs.length > 0 ? <section className="workflow-core-run-inputs"><strong>Run inputs</strong>{draft.inputs.map((input) => <label key={input.key}><span>{input.name}<small>{input.description}</small></span>{input.type === "boolean" ? <select value={runInputs[input.key] ?? "false"} onChange={(event) => setRunInputs((current) => ({ ...current, [input.key]: event.currentTarget.value }))}><option value="false">false</option><option value="true">true</option></select> : <input value={runInputs[input.key] ?? ""} placeholder={input.type === "object" || input.type === "list" ? "JSON value" : input.type} onChange={(event) => setRunInputs((current) => ({ ...current, [input.key]: event.currentTarget.value }))} />}</label>)}</section> : null}
          </section>
          <aside className="workflow-core-inspector">{mode === "run" ? <RunInspector run={activeRun} selectedNodeId={selectedNodeId} onRetry={(nodeId) => void api.retryWorkflowNode(activeRun!.id, nodeId).then((run) => setRuns((current) => current.map((item) => item.id === run.id ? run : item)))} onApprove={(nodeId, decision) => void api.resolveWorkflowApproval(activeRun!.id, nodeId, { decision, comment: "" }).then((run) => setRuns((current) => current.map((item) => item.id === run.id ? run : item)))} /> : selectedNode ? <NodeInspector definition={draft} node={selectedNode} agentIds={agents} onChange={updateNode} onDelete={() => { setDraft((current) => current ? { ...current, nodes: current.nodes.filter((item) => item.id !== selectedNode.id).map((item) => ({ ...item, inputs: item.inputs.filter((input) => input.source !== "node" || input.nodeId !== selectedNode.id) } as WorkflowNode)) } : current); setSelectedNodeId(undefined); }} /> : <DefinitionInspector definition={draft} onChange={setDraft} />}</aside>
        </div>
      </main>}
    </div>
  </div>;
}
