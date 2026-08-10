import { homedir } from "node:os";

import { ManagedSkillLibrary, type ManagedSkill } from "../core/managed-skill-library";

export interface McpSkillLibraryOptions {
  libraryRoot: string;
  homeDir?: string;
  codexHome?: string;
}

export interface McpSkillIndexEntry {
  managedId: string;
  name: string;
  description: string;
}

export interface McpSkillDetail extends McpSkillIndexEntry {
  markdown: string;
}

function openLibrary(options: McpSkillLibraryOptions): ManagedSkillLibrary {
  return new ManagedSkillLibrary({
    libraryRoot: options.libraryRoot,
    homeDir: options.homeDir ?? homedir(),
    codexHome: options.codexHome,
  });
}

function toIndexEntry(skill: ManagedSkill): McpSkillIndexEntry {
  return {
    managedId: skill.managedId,
    name: skill.name,
    description: skill.description,
  };
}

export function listMcpSkills(options: McpSkillLibraryOptions): McpSkillIndexEntry[] {
  return openLibrary(options).list().skills.map(toIndexEntry);
}

export function getMcpSkill(managedId: string, options: McpSkillLibraryOptions): McpSkillDetail | null {
  const normalizedId = managedId.trim();
  if (!normalizedId) return null;

  const skill = openLibrary(options).list().skills.find((candidate) => candidate.managedId === normalizedId);
  if (!skill) return null;

  return {
    ...toIndexEntry(skill),
    markdown: skill.markdown,
  };
}
