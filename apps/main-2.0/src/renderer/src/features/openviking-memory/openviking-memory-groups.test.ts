import { describe, expect, it } from "vitest";

import type { OpenVikingMemoryItem } from "../../../../core/openviking-memory";
import { groupOpenVikingMemories } from "./openviking-memory-groups";

describe("groupOpenVikingMemories", () => {
  it("keeps decision and open-loop templates in their own groups", () => {
    const memories: OpenVikingMemoryItem[] = [
      memory("viking://user/memories/decisions/中文决策.md"),
      memory("viking://user/memories/open_loops/release.md"),
    ];

    expect(groupOpenVikingMemories(memories).map((group) => group.key)).toEqual([
      "decisions",
      "open_loops",
    ]);
  });
});

function memory(id: string): OpenVikingMemoryItem {
  return {
    id,
    workspaceId: "workspace-1",
    title: id.split("/").at(-1) ?? id,
    content: "content",
  };
}
