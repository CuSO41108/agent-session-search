import path from "node:path";
import { describe, expect, it } from "vitest";
import { databaseUrlPointerPath } from "./app-paths";

describe("agent-recall-v2 database pointer", () => {
  it("uses a V2-specific home directory", () => {
    expect(databaseUrlPointerPath(path.join("home", "user"))).toBe(
      path.join("home", "user", ".agent-recall-v2", "database-url"),
    );
  });
});
