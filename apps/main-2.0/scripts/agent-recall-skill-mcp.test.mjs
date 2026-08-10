import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { z } from "zod";

import {
  registerSkillTools,
  resolveSkillLibraryPath,
} from "../bin/agent-recall-skill-mcp.mjs";

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

test("resolves the app-written managed Skill library pointer", (context) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-recall-skill-mcp-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const libraryRoot = path.join(home, "AgentRecall", "skills");
  mkdirSync(path.join(home, ".agent-recall-v2"), { recursive: true });
  writeFileSync(path.join(home, ".agent-recall-v2", "skill-library-path"), `${libraryRoot}\n`);

  assert.equal(resolveSkillLibraryPath({}, home), libraryRoot);
  assert.equal(
    resolveSkillLibraryPath({ AGENT_RECALL_SKILL_LIBRARY: "/override/skills" }, home),
    "/override/skills",
  );
});

test("registers list_skills and get_skill against the managed library", async (context) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "agent-recall-skill-tools-"));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const homeDir = path.join(fixtureRoot, "home");
  const libraryRoot = path.join(fixtureRoot, "skills");
  const skillDir = path.join(libraryRoot, "example-skill");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  const markdown = [
    "---",
    "name: Example Skill",
    "description: Example MCP fixture.",
    "---",
    "",
    "# Example",
    "",
    "Use the fixture.",
    "",
  ].join("\n");
  writeFileSync(path.join(skillDir, "SKILL.md"), markdown);

  const skillBundle = await import("../out/mcp/skill-entry.js");
  const tools = new Map();
  const server = {
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };

  registerSkillTools(server, z, libraryRoot, skillBundle, { homeDir });

  assert.deepEqual([...tools.keys()], ["list_skills", "get_skill"]);
  assert.equal(
    tools.get("list_skills").definition.description,
    "列出 AgentRecall 已管理的 Skill 索引，仅返回 managedId、名称和描述；需要读取完整说明时再调用 get_skill。",
  );
  assert.equal(
    tools.get("get_skill").definition.description,
    "根据 managedId 读取一个 AgentRecall 已管理 Skill 的完整 Markdown 说明。",
  );
  assert.deepEqual(parseToolResult(await tools.get("list_skills").handler({})), [
    {
      managedId: "example-skill",
      name: "Example Skill",
      description: "Example MCP fixture.",
    },
  ]);
  assert.deepEqual(parseToolResult(await tools.get("get_skill").handler({ managedId: "example-skill" })), {
    managedId: "example-skill",
    name: "Example Skill",
    description: "Example MCP fixture.",
    markdown,
  });

  const missing = await tools.get("get_skill").handler({ managedId: "missing-skill" });
  assert.equal(missing.isError, true);
  assert.equal(missing.content[0].text, "未找到指定的托管 Skill。");
});
