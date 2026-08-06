import { describe, expect, it } from "vitest";

import { tryCanonicalOpenVikingMemoryUri } from "./openviking-memory-uri";

describe("tryCanonicalOpenVikingMemoryUri", () => {
  it("keeps canonical memory URIs editable", () => {
    expect(tryCanonicalOpenVikingMemoryUri("viking://user/memories/preferences/editor.md")).toBe(
      "viking://user/memories/preferences/editor.md",
    );
  });

  it("normalizes workspace-qualified memory URIs", () => {
    expect(
      tryCanonicalOpenVikingMemoryUri("viking://user/workspace_123/memories/preferences/editor.md"),
    ).toBe("viking://user/memories/preferences/editor.md");
  });

  it.each([
    "",
    "viking://user/memories",
    "viking://user/memories/../identity.md",
    "viking://user/memories/preferences//editor.md",
    "viking://user/memories/preferences/editor.md?raw=1",
    "viking://resources/memories/preferences/editor.md",
  ])("rejects unsafe or out-of-scope URI %s", (uri) => {
    expect(tryCanonicalOpenVikingMemoryUri(uri)).toBeNull();
  });
});
