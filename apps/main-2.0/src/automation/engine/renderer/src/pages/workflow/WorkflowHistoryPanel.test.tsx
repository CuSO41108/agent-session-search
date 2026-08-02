import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowSidebarItem } from "../../../../shared/types";
import { WorkflowHistoryPanel } from "./WorkflowHistoryPanel";

function workflow(workflowId: string, sourceType: "official" | "user"): WorkflowSidebarItem {
  return {
    workflowId, sourceType, title: workflowId, status: "draft", revision: 1,
    objective: "Objective", nodeCount: 2, createdAt: 1, updatedAt: 1,
  };
}

const common = {
  workflows: [workflow("official", "official"), workflow("personal", "user")],
  onNewWorkflow: () => undefined,
  onSelectWorkflow: () => undefined,
};

describe("WorkflowHistoryPanel portable actions", () => {
  test("places import immediately after New workflow", () => {
    const html = renderToStaticMarkup(<WorkflowHistoryPanel {...common} />);
    expect(html.indexOf("New workflow")).toBeLessThan(html.indexOf("Import workflow"));
    expect(html.indexOf("Import workflow")).toBeLessThan(html.indexOf("Workflow history"));
  });

  test("shows only clone for an official workflow context menu", () => {
    const html = renderToStaticMarkup(<WorkflowHistoryPanel {...common} contextMenu={{ workflowId: "official", x: 1, y: 1 }} />);
    expect(html).toContain("Clone to my workflows");
    expect(html).not.toContain("Export workflow");
    expect(html).not.toContain("Rename workflow");
  });

  test("shows export for a personal workflow and derives the needs-configuration badge", () => {
    const html = renderToStaticMarkup(<WorkflowHistoryPanel {...common} contextMenu={{ workflowId: "personal", x: 1, y: 1 }} readinessByWorkflowId={{ personal: { ready: false, issues: [] } }} />);
    expect(html).toContain("Export workflow");
    expect(html).toContain("Rename workflow");
    expect(html).not.toContain("Clone to my workflows");
    expect(html).toContain("待配置");
  });

  test("keeps summaries visible while workflow details are loading", () => {
    const html = renderToStaticMarkup(<WorkflowHistoryPanel {...common} detailsLoading detailsAvailable={false} />);
    expect(html).toContain("official");
    expect(html).toContain("2 nodes");
    expect(html).toContain("Loading workflow details");
    expect(html).toContain("disabled");
  });
});
