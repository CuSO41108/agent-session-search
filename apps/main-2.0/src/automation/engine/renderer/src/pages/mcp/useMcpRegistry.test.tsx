// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { McpServerDefinition } from "../../../../shared/mcp/types";
import { useMcpRegistry } from "./useMcpRegistry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];

function server(overrides: Partial<McpServerDefinition>): McpServerDefinition {
  return {
    id: "team-docs",
    name: "Team docs",
    transport: "stdio",
    command: "npx",
    args: [],
    env: {},
    enabled: true,
    tools: [],
    disabledTools: [],
    status: "untested",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let listMcpServers: ReturnType<typeof vi.fn>;
let saveMcpServer: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listMcpServers = vi.fn(async () => [] as McpServerDefinition[]);
  saveMcpServer = vi.fn(async (value: McpServerDefinition) => value);
  (window as unknown as { sessionSearch: { automation: unknown } }).sessionSearch = {
    automation: { listMcpServers, saveMcpServer },
  };
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

type Registry = ReturnType<typeof useMcpRegistry>;

async function mountRegistry(): Promise<{ ref: { current: Registry } }> {
  const ref = { current: undefined as unknown as Registry };
  function Harness(): ReactElement | null {
    ref.current = useMcpRegistry();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(async () => root.render(<Harness />));
  // let the initial load() effect resolve
  await act(async () => {});
  return { ref };
}

describe("useMcpRegistry.toggleServerEnabled", () => {
  test("disables a server straight from the list without changing selection", async () => {
    const docs = server({ id: "team-docs", name: "Team docs", enabled: true });
    const other = server({ id: "team-wiki", name: "Team wiki", enabled: true });
    listMcpServers.mockResolvedValue([docs, other]);
    const { ref } = await mountRegistry();

    // "team-docs" is selected first (first non-managed). Toggle the OTHER one.
    const selectedBefore = ref.current.draft?.id;
    await act(async () => ref.current.toggleServerEnabled("team-wiki"));

    expect(saveMcpServer).toHaveBeenCalledTimes(1);
    expect(saveMcpServer.mock.calls[0][0]).toMatchObject({ id: "team-wiki", enabled: false });
    // selection and the open draft are unchanged
    expect(ref.current.draft?.id).toBe(selectedBefore);
    expect(ref.current.servers.find((item) => item.id === "team-wiki")?.enabled).toBe(false);
  });

  test("preserves unsaved edits when toggling the server being edited", async () => {
    const docs = server({ id: "team-docs", name: "Team docs", enabled: true, command: "npx" });
    listMcpServers.mockResolvedValue([docs]);
    saveMcpServer.mockImplementation(async (value: McpServerDefinition) => value);
    const { ref } = await mountRegistry();

    // edit the draft (dirty) but don't save
    await act(async () => ref.current.update({ ...ref.current.draft!, command: "uvx" }));
    expect(ref.current.dirty).toBe(true);

    await act(async () => ref.current.toggleServerEnabled("team-docs"));

    // the in-flight command edit is carried into the saved payload
    expect(saveMcpServer).toHaveBeenCalledTimes(1);
    expect(saveMcpServer.mock.calls[0][0]).toMatchObject({ command: "uvx", enabled: false });
    expect(ref.current.dirty).toBe(false);
  });
});
