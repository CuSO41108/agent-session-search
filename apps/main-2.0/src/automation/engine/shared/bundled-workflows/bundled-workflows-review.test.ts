import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { WorkflowV2Definition } from "../workflow-v2/definition";
import { validateWorkflowV2Definition } from "../workflow-v2/validation";

const workflowNames = ["github-daily-ai", "resume", "job-tailored-resume", "code-change-review"];

describe("official Workflow Review configuration", () => {
  test.each(workflowNames)("keeps %s disabled by default with valid critical-node criteria", (name) => {
    const sourcePath = new URL(`./${name}/workflow.json`, import.meta.url);
    const assetPath = new URL(`../../../../../assets/automation/bundled-workflows/${name}/workflow.json`, import.meta.url);
    const source = readFileSync(sourcePath, "utf8");
    const bundled = JSON.parse(source) as { definition: WorkflowV2Definition };
    expect(readFileSync(assetPath, "utf8")).toBe(source);
    expect(bundled.definition.reviewEnabled).toBe(false);
    expect(validateWorkflowV2Definition(bundled.definition)).toMatchObject({ valid: true, errors: [] });
    const reviewedNodes = bundled.definition.nodes.filter((node) => node.reviewLevel && node.reviewLevel !== "none");
    expect(reviewedNodes.length).toBeGreaterThan(0);
    expect(reviewedNodes.every((node) => node.judgeDimensions?.length && node.reviewMaxRetries === 2)).toBe(true);
  });
});
