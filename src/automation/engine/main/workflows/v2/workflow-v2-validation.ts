import type {
  WorkflowV2LLMNode,
  WorkflowV2Node,
  WorkflowV2NodeValidationResult,
  WorkflowV2ScriptNode,
} from "../../../shared/workflow-v2/definition";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";

export interface ValidateWorkflowV2NodeOutputInput {
  node: WorkflowV2Node;
  output: WorkflowV2WorkerOutput;
  attempt: number;
}

export function validateWorkflowV2NodeOutput(
  input: ValidateWorkflowV2NodeOutputInput,
): WorkflowV2NodeValidationResult {
  if (input.output.nodeId !== input.node.id) {
    return invalidResult("fail", `Output packet belongs to ${input.output.nodeId}, not ${input.node.id}.`);
  }

  if (input.node.execModel === "llm") {
    return validateLlmNodeOutput(input.node, input.output, input.attempt);
  }
  return validateScriptNodeOutput(input.node, input.output);
}

function validateLlmNodeOutput(
  node: WorkflowV2LLMNode,
  output: WorkflowV2WorkerOutput,
  attempt: number,
): WorkflowV2NodeValidationResult {
  const failures = collectStructuralFailures(node, output);
  if (failures.reasons.length === 0) return passResult();

  const maxRetry = node.maxRetry ?? 0;
  if (attempt <= maxRetry) {
    return {
      outcome: "retry",
      ...failures,
    };
  }
  return {
    outcome: node.onExhausted === "ask_human" ? "ask_human" : "fail",
    ...failures,
  };
}

function validateScriptNodeOutput(
  node: WorkflowV2ScriptNode,
  output: WorkflowV2WorkerOutput,
): WorkflowV2NodeValidationResult {
  const failures = collectStructuralFailures(node, output);
  if (failures.reasons.length === 0) return passResult();
  return {
    outcome: node.onError === "ask_human" ? "ask_human" : "fail",
    ...failures,
  };
}

function collectStructuralFailures(
  node: WorkflowV2Node,
  output: WorkflowV2WorkerOutput,
): Pick<WorkflowV2NodeValidationResult, "reasons" | "missingOutputFields"> {
  const reasons: string[] = [];
  if (typeof output.summary !== "string" || output.summary.trim().length === 0) {
    reasons.push("Output summary is required.");
  }

  const outputs = isRecord(output.outputs) ? output.outputs : {};
  const missingOutputFields = node.outputFields
    .filter((field) => field.required !== false && !Object.hasOwn(outputs, field.key))
    .map((field) => field.key);
  if (missingOutputFields.length > 0) {
    reasons.push(`Missing required output fields: ${missingOutputFields.join(", ")}.`);
  }
  for (const field of node.outputFields) {
    if (!Object.hasOwn(outputs, field.key)) continue;
    const value = outputs[field.key];
    if (value === null || value === undefined) {
      reasons.push(`Output field ${field.key} must not be null or undefined.`);
      continue;
    }
    if (field.valueType && !matchesOutputType(value, field.valueType)) {
      reasons.push(`Output field ${field.key} must match value type ${field.valueType}.`);
    }
  }
  if (node.execModel === "script" && node.script.outputSchema) {
    for (const key of node.script.outputSchema.required ?? []) {
      if (!Object.hasOwn(outputs, key) || outputs[key] === null || outputs[key] === undefined) reasons.push(`Script output schema requires non-null field ${key}.`);
    }
    for (const [key, property] of Object.entries(node.script.outputSchema.properties ?? {})) {
      const value = outputs[key];
      if (value === undefined) continue;
      if (value === null) {
        if (!property.nullable && property.type !== "null") reasons.push(`Script output field ${key} must not be null.`);
        continue;
      }
      if (!matchesJsonSchemaType(value, property.type)) reasons.push(`Script output field ${key} must be ${property.type}.`);
      else if (property.type === "array" && property.items && !(value as unknown[]).every((item) => matchesJsonSchemaType(item, property.items!.type))) reasons.push(`Script output field ${key} contains an invalid array item.`);
    }
  }
  return { reasons, missingOutputFields };
}

function matchesOutputType(value: unknown, valueType: NonNullable<WorkflowV2Node["outputFields"][number]["valueType"]>): boolean {
  if (valueType === "number") return typeof value === "number" && Number.isFinite(value);
  if (valueType === "boolean") return typeof value === "boolean";
  if (valueType === "json") return isFiniteJsonValue(value, new WeakSet<object>());
  return typeof value === "string";
}

function isFiniteJsonValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isFiniteJsonValue(item, seen))
    : Object.values(value as Record<string, unknown>).every((item) => isFiniteJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function matchesJsonSchemaType(value: unknown, type: "string" | "number" | "boolean" | "object" | "array" | "null"): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function passResult(): WorkflowV2NodeValidationResult {
  return { outcome: "pass", reasons: [], missingOutputFields: [] };
}

function invalidResult(
  outcome: WorkflowV2NodeValidationResult["outcome"],
  reason: string,
): WorkflowV2NodeValidationResult {
  return { outcome, reasons: [reason], missingOutputFields: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
