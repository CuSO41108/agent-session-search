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
      item: { type: "object", fields: expect.arrayContaining([expect.objectContaining({ key: "evidence" })]) },
    });
  });
});
