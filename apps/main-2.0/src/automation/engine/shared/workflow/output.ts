import type { WorkflowNode, WorkflowOutputField } from "./model";
import type { WorkflowValidationIssue } from "./validation";

function issue(path: string, message: string): WorkflowValidationIssue {
  return { path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativeFilePath(value: string): boolean {
  if (!value.trim() || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  const segments = value.replace(/\\/g, "/").split("/");
  return !segments.some((segment) => segment === "..");
}

function validateFieldValue(
  field: WorkflowOutputField,
  value: unknown,
  path: string,
  issues: WorkflowValidationIssue[],
): void {
  if (field.type === "text") {
    if (typeof value !== "string") issues.push(issue(path, "Expected text output."));
    return;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) issues.push(issue(path, "Expected number output."));
    return;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") issues.push(issue(path, "Expected boolean output."));
    return;
  }
  if (field.type === "file") {
    if (typeof value !== "string" || !isSafeRelativeFilePath(value)) {
      issues.push(issue(path, "File output must be a safe relative path inside the Run output directory."));
    }
    return;
  }
  if (field.type === "object") {
    if (!isRecord(value)) {
      issues.push(issue(path, "Expected object output."));
      return;
    }
    validateFields(field.fields ?? [], value, path, issues);
    return;
  }
  if (!Array.isArray(value)) {
    issues.push(issue(path, "Expected list output."));
    return;
  }
  if (field.item) value.forEach((item, index) => validateFieldValue(field.item!, item, `${path}.${index}`, issues));
}

function validateFields(
  fields: WorkflowOutputField[],
  values: Record<string, unknown>,
  path: string,
  issues: WorkflowValidationIssue[],
): void {
  const declared = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) issues.push(issue(`${path}.${key}`, "Output field is not declared by the node."));
  }
  for (const field of fields) {
    if (!Object.hasOwn(values, field.key) || values[field.key] === undefined) {
      if (field.required) issues.push(issue(`${path}.${field.key}`, "Required output is missing."));
      continue;
    }
    validateFieldValue(field, values[field.key], `${path}.${field.key}`, issues);
  }
}

export function validateWorkflowNodeOutputs(node: WorkflowNode, outputs: unknown): WorkflowValidationIssue[] {
  if (!isRecord(outputs)) return [issue("outputs", "Node outputs must be an object.")];
  const issues: WorkflowValidationIssue[] = [];
  validateFields(node.outputs, outputs, "outputs", issues);
  if (node.kind === "review" && outputs.verdict !== "pass" && outputs.verdict !== "revise") {
    issues.push(issue("outputs.verdict", "Review verdict must be pass or revise."));
  }
  return issues;
}

