import type { WorkflowDefinition, WorkflowNode } from "../../../../automation/engine/shared/workflow/model";

export interface WorkflowGraphPosition { x: number; y: number }

function dependencies(node: WorkflowNode): string[] {
  return [...new Set(node.inputs.filter((input) => input.source === "node").map((input) => input.nodeId))];
}

export function layoutWorkflowNodes(
  definition: WorkflowDefinition,
  options: { force?: boolean } = {},
): Record<string, WorkflowGraphPosition> {
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (node: WorkflowNode): number => {
    const known = depthMemo.get(node.id);
    if (known !== undefined) return known;
    if (visiting.has(node.id)) return 0;
    visiting.add(node.id);
    const value = dependencies(node).reduce((maximum, dependencyId) => {
      const dependency = nodesById.get(dependencyId);
      return dependency ? Math.max(maximum, depth(dependency) + 1) : maximum;
    }, 0);
    visiting.delete(node.id);
    depthMemo.set(node.id, value);
    return value;
  };
  const layers = new Map<number, WorkflowNode[]>();
  for (const node of definition.nodes) {
    const layer = depth(node);
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }
  const largestLayer = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const result: Record<string, WorkflowGraphPosition> = {};
  for (const [layerIndex, layer] of layers) {
    const top = 90 + (largestLayer - layer.length) * 70;
    layer.forEach((node, rowIndex) => {
      result[node.id] = !options.force && node.position
        ? { ...node.position }
        : { x: 90 + layerIndex * 270, y: top + rowIndex * 140 };
    });
  }
  return result;
}
