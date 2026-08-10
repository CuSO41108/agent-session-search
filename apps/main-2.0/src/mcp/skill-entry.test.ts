import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getMcpSkill, listMcpSkills } from "./skill-entry";

const temporaryDirectories: string[] = [];

function createFixture(): { homeDir: string; libraryRoot: string } {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "agent-recall-skill-mcp-"));
  temporaryDirectories.push(fixtureRoot);

  const homeDir = path.join(fixtureRoot, "home");
  const libraryRoot = path.join(fixtureRoot, "skills");
  mkdirSync(homeDir, { recursive: true });

  const firstSkill = path.join(libraryRoot, "alpha-skill");
  mkdirSync(firstSkill, { recursive: true });
  writeFileSync(
    path.join(firstSkill, "SKILL.md"),
    [
      "---",
      "name: Alpha Skill",
      "description: Handles alpha tasks.",
      "---",
      "",
      "# Alpha",
      "",
      "Alpha instructions.",
      "",
    ].join("\n"),
    "utf8",
  );

  const secondSkill = path.join(libraryRoot, "beta-skill");
  mkdirSync(secondSkill, { recursive: true });
  writeFileSync(
    path.join(secondSkill, "SKILL.md"),
    [
      "---",
      "name: Beta Skill",
      "description: Handles beta tasks.",
      "---",
      "",
      "# Beta",
      "",
      "Beta instructions.",
      "",
    ].join("\n"),
    "utf8",
  );

  return { homeDir, libraryRoot };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Skill MCP entry", () => {
  it("lists only the managed Skill index fields", () => {
    const options = createFixture();

    expect(listMcpSkills(options)).toEqual([
      {
        managedId: "alpha-skill",
        name: "Alpha Skill",
        description: "Handles alpha tasks.",
      },
      {
        managedId: "beta-skill",
        name: "Beta Skill",
        description: "Handles beta tasks.",
      },
    ]);
  });

  it("returns one managed Skill with its markdown", () => {
    const options = createFixture();

    expect(getMcpSkill("beta-skill", options)).toEqual({
      managedId: "beta-skill",
      name: "Beta Skill",
      description: "Handles beta tasks.",
      markdown: [
        "---",
        "name: Beta Skill",
        "description: Handles beta tasks.",
        "---",
        "",
        "# Beta",
        "",
        "Beta instructions.",
        "",
      ].join("\n"),
    });
  });

  it("returns null for an unknown managed Skill", () => {
    const options = createFixture();

    expect(getMcpSkill("missing-skill", options)).toBeNull();
  });
});
