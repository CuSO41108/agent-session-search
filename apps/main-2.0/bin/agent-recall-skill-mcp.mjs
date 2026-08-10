#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL_LIBRARY_POINTER = "skill-library-path";
let skillBundle = null;

function resolveAppVersion(packageUrl = new URL("../package.json", import.meta.url)) {
  try {
    const value = JSON.parse(readFileSync(fileURLToPath(packageUrl), "utf8"));
    return typeof value.version === "string" && value.version ? value.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function resolveSkillLibraryPath(env = process.env, home = homedir()) {
  const override = env.AGENT_RECALL_SKILL_LIBRARY?.trim();
  if (override) return override;
  const pointer = path.join(home, ".agent-recall-v2", SKILL_LIBRARY_POINTER);
  try {
    if (!existsSync(pointer)) return null;
    return readFileSync(pointer, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function validateSkillBundle(bundle) {
  for (const name of ["listMcpSkills", "getMcpSkill"]) {
    if (typeof bundle?.[name] !== "function") {
      throw new Error(`Skill bundle is missing ${name}`);
    }
  }
}

async function loadSkillBundle() {
  if (skillBundle) return skillBundle;
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out", "mcp", "skill-entry.js"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "skill-entry.js"),
  ];
  let lastError = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const candidateBundle = await import(pathToFileURL(candidate).href);
      validateSkillBundle(candidateBundle);
      skillBundle = candidateBundle;
      return skillBundle;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "MCP Skill bundle not found. Run `npm run build:mcp` first." +
    (lastError ? ` (${lastError instanceof Error ? lastError.message : String(lastError)})` : ""),
  );
}

function jsonContent(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function registerSkillTools(
  server,
  zod,
  libraryRoot,
  bundle,
  { homeDir = homedir(), codexHome = process.env.CODEX_HOME } = {},
) {
  const libraryOptions = { libraryRoot, homeDir, codexHome };
  server.registerTool(
    "list_skills",
    {
      description:
        "列出 AgentRecall 已管理的 Skill 索引，仅返回 managedId、名称和描述；需要读取完整说明时再调用 get_skill。",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonContent(bundle.listMcpSkills(libraryOptions));
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  );
  server.registerTool(
    "get_skill",
    {
      description: "根据 managedId 读取一个 AgentRecall 已管理 Skill 的完整 Markdown 说明。",
      inputSchema: {
        managedId: zod.string().min(1).describe("list_skills 返回的精确 managedId。"),
      },
    },
    async ({ managedId }) => {
      try {
        const result = bundle.getMcpSkill(managedId, libraryOptions);
        return result ? jsonContent(result) : errorContent("未找到指定的托管 Skill。");
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  );
}

async function runServer() {
  const libraryRoot = resolveSkillLibraryPath();
  if (!libraryRoot) {
    throw new Error(
      "未找到 AgentRecall 托管 Skill 库。请先打开 App，或设置 AGENT_RECALL_SKILL_LIBRARY。",
    );
  }

  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");
  const server = new McpServer({ name: "agent-recall-skills", version: resolveAppVersion() });
  registerSkillTools(server, z, libraryRoot, await loadSkillBundle());
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runServer().catch((error) => {
    process.stderr.write(`AgentRecall Skill MCP 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
