// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowComposerInput } from "./WorkflowComposerInput";

describe("WorkflowComposerInput", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("reports edits so the owning workflow can retain its local draft", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(
      <WorkflowComposerInput
        initialValue=""
        workflowKey="workflow-a:objective"
        ariaLabel="Task"
        placeholder="Describe the task"
        running={false}
        onChange={onChange}
        onSubmit={() => undefined}
      />,
    ));

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(textarea, "保留这段任务描述");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenLastCalledWith("保留这段任务描述");
  });
});
