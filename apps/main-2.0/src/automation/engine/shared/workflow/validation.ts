import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowOutputField,
  WorkflowReviewNode,
} from "./model";

export interface WorkflowValidationIssue {
  path: string;
  message: string;
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;

function issue(path: string, message: string): WorkflowValidationIssue {
  return { path, message };
}

function requiredText(value: string, path: string, label: string, issues: WorkflowValidationIssue[]): void {
  if (!value.trim()) issues.push(issue(path, `${label} is required.`));
}

function validateKey(value: string, path: string, issues: WorkflowValidationIssue[]): void {
  if (!ID_PATTERN.test(value)) issues.push(issue(path, "Key must start with a letter and contain only letters, numbers, underscores, or hyphens."));
}

function validateOutputField(
  field: WorkflowOutputField,
  path: string,
  compoundDepth: number,
  issues: WorkflowValidationIssue[],
): void {
  requiredText(field.key, `${path}.key`, "Output key", issues);
  validateKey(field.key, `${path}.key`, issues);
  requiredText(field.name, `${path}.name`, "Output name", issues);
  requiredText(field.description, `${path}.description`, "Output description", issues);

  const nextCompoundDepth = field.type === "object" || field.type === "list" ? compoundDepth + 1 : compoundDepth;
  if (nextCompoundDepth > 2) {
    issues.push(issue(path, "Object and list outputs may be nested at most two levels."));
    return;
  }

  if (field.type === "object") {
    if (!field.fields?.length) {
      issues.push(issue(`${path}.fields`, "Object outputs require at least one field."));
    } else {
      validateOutputFields(field.fields, `${path}.fields`, nextCompoundDepth, issues);
    }
    if (field.item !== undefined) issues.push(issue(`${path}.item`, "Only list outputs may declare an item."));
    return;
  }

  if (field.type === "list") {
    if (!field.item) {
      issues.push(issue(`${path}.item`, "List outputs require an item definition."));
    } else {
      validateOutputField(field.item, `${path}.item.${field.item.key}`, nextCompoundDepth, issues);
    }
    if (field.fields !== undefined) issues.push(issue(`${path}.fields`, "Only object outputs may declare fields."));
    return;
  }

  if (field.fields !== undefined) issues.push(issue(`${path}.fields`, "Only object outputs may declare fields."));
  if (field.item !== undefined) issues.push(issue(`${path}.item`, "Only list outputs may declare an item."));
}

function validateOutputFields(
  fields: WorkflowOutputField[],
  path: string,
  compoundDepth: number,
  issues: WorkflowValidationIssue[],
): void {
  const keys = new Set<string>();
  for (const field of fields) {
    const fieldPath = `${path}.${field.key}`;
    if (keys.has(field.key)) issues.push(issue(fieldPath, "Output key must be unique within the node."));
    keys.add(field.key);
    validateOutputField(field, fieldPath, compoundDepth, issues);
  }
}

function nodeDependencies(node: WorkflowNode): string[] {
  return [...new Set(node.inputs.filter((input) => input.source === "node").map((input) => input.nodeId))];
}

function graphHasCycle(nodes: WorkflowNode[]): boolean {
  const dependencies = new Map(nodes.map((node) => [node.id, nodeDependencies(node)]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}

function isUpstream(targetNodeId: string, node: WorkflowNode, nodesById: ReadonlyMap<string, WorkflowNode>): boolean {
  const pending = nodeDependencies(node);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (candidate === targetNodeId) return true;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    const dependency = nodesById.get(candidate);
    if (dependency) pending.push(...nodeDependencies(dependency));
  }
  return false;
}

function validateReviewNode(
  node: WorkflowReviewNode,
  nodesById: ReadonlyMap<string, WorkflowNode>,
  path: string,
  issues: WorkflowValidationIssue[],
): void {
  if (!Number.isInteger(node.maxRevisions) || node.maxRevisions < 0) {
    issues.push(issue(`${path}.maxRevisions`, "Review maxRevisions must be a non-negative integer."));
  }
  if (node.targetNodeIds.length === 0) issues.push(issue(`${path}.targetNodeIds`, "Review nodes require at least one target node."));
  for (const targetNodeId of node.targetNodeIds) {
    if (!nodesById.has(targetNodeId) || !isUpstream(targetNodeId, node, nodesById)) {
      issues.push(issue(`${path}.targetNodeIds.${targetNodeId}`, "Review targets must be upstream nodes."));
      continue;
    }
    const consumesTarget = node.inputs.some((input) => input.source === "node" && input.nodeId === targetNodeId);
    if (!consumesTarget) issues.push(issue(`${path}.targetNodeIds.${targetNodeId}`, "Review nodes must consume at least one output from each target."));
  }
  const verdict = node.outputs.find((output) => output.key === "verdict");
  if (!verdict || verdict.type !== "text" || !verdict.required) {
    issues.push(issue(`${path}.outputs.verdict`, "Review nodes must declare a required text verdict output."));
  }
  const criteriaResults = node.outputs.find((output) => output.key === "criteriaResults");
  if (!criteriaResults || criteriaResults.type !== "list" || !criteriaResults.required) {
    issues.push(issue(`${path}.outputs.criteriaResults`, "Review nodes must declare a required list criteriaResults output."));
  }
  const feedback = node.outputs.find((output) => output.key === "feedback");
  if (!feedback || feedback.type !== "text" || !feedback.required) {
    issues.push(issue(`${path}.outputs.feedback`, "Review nodes must declare a required text feedback output."));
  }
  const criterionKeys = new Set<string>();
  for (const criterion of node.criteria) {
    if (criterionKeys.has(criterion.key)) issues.push(issue(`${path}.criteria.${criterion.key}`, "Review criterion keys must be unique."));
    criterionKeys.add(criterion.key);
  }
}

export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
  configuredAgentIds?: ReadonlySet<string>,
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  requiredText(definition.id, "id", "Workflow id", issues);
  requiredText(definition.name, "name", "Workflow name", issues);
  requiredText(definition.description, "description", "Workflow description", issues);

  const workflowInputKeys = new Set<string>();
  for (const input of definition.inputs) {
    const path = `inputs.${input.key}`;
    if (workflowInputKeys.has(input.key)) issues.push(issue(path, "Workflow input keys must be unique."));
    workflowInputKeys.add(input.key);
    validateKey(input.key, `${path}.key`, issues);
    requiredText(input.name, `${path}.name`, "Input name", issues);
    requiredText(input.description, `${path}.description`, "Input description", issues);
  }

  const nodesById = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (nodesById.has(node.id)) issues.push(issue(`nodes.${node.id}`, "Node ids must be unique."));
    nodesById.set(node.id, node);
  }

  for (const node of definition.nodes) {
    const path = `nodes.${node.id}`;
    validateKey(node.id, `${path}.id`, issues);
    requiredText(node.title, `${path}.title`, "Node title", issues);
    requiredText(node.goal, `${path}.goal`, "Node goal", issues);
    if (node.outputs.length === 0) issues.push(issue(`${path}.outputs`, "Nodes require at least one output field."));
    validateOutputFields(node.outputs, `${path}.outputs`, 0, issues);

    const inputKeys = new Set<string>();
    for (const input of node.inputs) {
      const inputPath = `${path}.inputs.${input.key}`;
      if (inputKeys.has(input.key)) issues.push(issue(inputPath, "Node input keys must be unique."));
      inputKeys.add(input.key);
      validateKey(input.key, `${inputPath}.key`, issues);
      requiredText(input.name, `${inputPath}.name`, "Input name", issues);
      requiredText(input.description, `${inputPath}.description`, "Input description", issues);
      if (input.source === "workflow" && !workflowInputKeys.has(input.workflowInputKey)) {
        issues.push(issue(`${inputPath}.workflowInputKey`, "Referenced workflow input does not exist."));
      }
      if (input.source === "node") {
        const upstream = nodesById.get(input.nodeId);
        if (!upstream) {
          issues.push(issue(`${inputPath}.nodeId`, "Referenced node does not exist."));
        } else if (!upstream.outputs.some((output) => output.key === input.outputKey)) {
          issues.push(issue(`${inputPath}.outputKey`, "Referenced node output does not exist."));
        }
        if (input.nodeId === node.id) issues.push(issue(`${inputPath}.nodeId`, "Nodes cannot consume their own output."));
      }
    }

    if (node.kind === "agent" || node.kind === "review") {
      if (configuredAgentIds && !configuredAgentIds.has(node.agentId)) {
        issues.push(issue(`${path}.agentId`, "Configured agent does not exist."));
      }
    }
    if (node.kind === "script") {
      if (!node.source.trim()) issues.push(issue(`${path}.source`, "Script source is required."));
      if (!Number.isFinite(node.timeoutSeconds) || node.timeoutSeconds <= 0) issues.push(issue(`${path}.timeoutSeconds`, "Script timeout must be positive."));
    }
    if (node.kind === "review") validateReviewNode(node, nodesById, path, issues);
    if (node.kind === "approval") {
      const values = new Set(node.options.map((option) => option.value));
      if (node.options.length < 2 || values.size !== node.options.length) {
        issues.push(issue(`${path}.options`, "Approval nodes require at least two distinct options."));
      }
    }
  }

  if (graphHasCycle(definition.nodes)) issues.push(issue("nodes", "Node input references must form an acyclic graph."));
  return issues;
}
