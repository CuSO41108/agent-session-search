import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_RECALL_BUILTIN_SKILLS, ManagedSkillLibrary } from "./managed-skill-library";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AgentRecall bundled Skills", () => {
  it("ships aihot as an official built-in Skill", () => {
    expect(AGENT_RECALL_BUILTIN_SKILLS).toContainEqual({
      id: "aihot",
      installId: "aihot",
      sourceUrl: "https://github.com/KKKKhazix/khazix-skills/tree/main/aihot",
    });
    expect(
      existsSync(fileURLToPath(new URL("../../assets/bundled-skills/aihot/SKILL.md", import.meta.url))),
    ).toBe(true);
  });

  it("ships resume-optimization as an official built-in Skill", () => {
    expect(AGENT_RECALL_BUILTIN_SKILLS).toContainEqual({
      id: "resume-optimization",
      installId: "resume-optimization",
      sourceUrl: "https://github.com/melodic-software/claude-code-plugins/tree/main/plugins/soft-skills/skills/resume-optimization",
    });
    const bundledSkillUrl = new URL("../../assets/bundled-skills/resume-optimization/", import.meta.url);
    expect(existsSync(fileURLToPath(new URL("SKILL.md", bundledSkillUrl)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL("SKILL.zh.md", bundledSkillUrl)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL("metadata.json", bundledSkillUrl)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL("LICENSE", bundledSkillUrl)))).toBe(true);
  });

  it("imports aihot into a fresh managed library with built-in origin metadata", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "agent-recall-builtin-skill-"));
    temporaryDirectories.push(fixtureRoot);
    const library = new ManagedSkillLibrary({
      libraryRoot: path.join(fixtureRoot, "skills"),
      homeDir: path.join(fixtureRoot, "home"),
    });
    const bundledRoot = fileURLToPath(new URL("../../assets/bundled-skills", import.meta.url));

    library.ensureBuiltinSkills(bundledRoot);

    expect(library.list().skills.find((skill) => skill.managedId === "aihot")?.origin).toEqual({
      kind: "builtin",
      label: "AgentRecall",
      url: "https://github.com/KKKKhazix/khazix-skills/tree/main/aihot",
    });
    expect(library.list().skills.find((skill) => skill.managedId === "resume-optimization")?.origin).toEqual({
      kind: "builtin",
      label: "AgentRecall",
      url: "https://github.com/melodic-software/claude-code-plugins/tree/main/plugins/soft-skills/skills/resume-optimization",
    });
  });
});
