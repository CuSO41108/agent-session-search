import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveSkillLibraryPath,
  skillLibraryPointerPath,
  writeSkillLibraryPointer,
} from "./app-paths";

const temporaryDirectories: string[] = [];

function createHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "agent-recall-app-paths-"));
  temporaryDirectories.push(home);
  return home;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Skill library pointer", () => {
  it("uses the V2 private pointer directory", () => {
    const home = createHome();

    expect(skillLibraryPointerPath(home)).toBe(
      path.join(home, ".agent-recall-v2", "skill-library-path"),
    );
  });

  it("writes and resolves the Skill library path", () => {
    const home = createHome();
    const libraryRoot = path.join(home, "AgentRecall", "skills");

    writeSkillLibraryPointer(libraryRoot, home);

    expect(resolveSkillLibraryPath({}, home)).toBe(libraryRoot);
  });

  it("prefers the environment override", () => {
    const home = createHome();
    writeSkillLibraryPointer(path.join(home, "pointer-skills"), home);

    expect(
      resolveSkillLibraryPath(
        { AGENT_RECALL_SKILL_LIBRARY: path.join(home, "override-skills") },
        home,
      ),
    ).toBe(path.join(home, "override-skills"));
  });

  it("returns null when no Skill library location is available", () => {
    expect(resolveSkillLibraryPath({}, createHome())).toBeNull();
  });
});
