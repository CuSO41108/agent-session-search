import { describe, expect, test } from "vitest";
import { validateWorkflowDefinition } from "./validation";
import { structuredBundledWorkflowDefinitions } from "./bundled-definitions";

describe("structured bundled Workflows", () => {
  test("ships the resume highlight workflow as described multi-field outputs", () => {
    const [workflow] = structuredBundledWorkflowDefinitions("agent-1", 10);
    const discovery = workflow?.nodes.find((node) => node.id === "discover-highlights");

    expect(validateWorkflowDefinition(workflow!, new Set(["agent-1"]))).toEqual([]);
    expect(discovery?.outputs.map((field) => field.key)).toEqual([
      "highlights",
      "scannedProjects",
      "noValueReason",
    ]);
    expect(discovery?.outputs[0]).toMatchObject({
      type: "list",
      description: expect.stringContaining("证据"),
    });
  });

  test("ships several valid examples covering Agent, Script, Review, and Approval nodes", () => {
    const workflows = structuredBundledWorkflowDefinitions("agent-1", 10);

    expect(workflows.map((workflow) => workflow.id)).toEqual([
      "resume-technical-highlights",
      "code-change-review",
      "technical-design-from-code",
      "release-readiness-check",
    ]);
    for (const workflow of workflows) {
      expect(validateWorkflowDefinition(workflow, new Set(["agent-1"])), workflow.id).toEqual([]);
    }
    expect(new Set(workflows.flatMap((workflow) => workflow.nodes.map((node) => node.kind)))).toEqual(
      new Set(["agent", "script", "review", "approval"]),
    );
  });
});
