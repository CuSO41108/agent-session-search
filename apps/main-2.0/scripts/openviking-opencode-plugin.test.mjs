import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentRecallOpenVikingPlugin } from "../bin/openviking-opencode-plugin.mjs";

test("OpenCode recalls before a managed prompt and captures the completed turn", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-opencode-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 2,
    baseUrl: "http://127.0.0.1:21933",
    stateDir: path.join(root, "state"),
    integrations: { claude: false, codex: false, opencode: true },
    workspaces: [{
      id: "workspace-1",
      rootPath: fs.realpathSync.native(project),
      accountId: "agent-recall-v2",
      userId: "workspace_user",
      apiKey: "workspace-key",
      recallTokenBudget: 1_200,
    }],
  }));
  const requests = [];
  const plugin = createAgentRecallOpenVikingPlugin(manifestPath, {
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/api/v1/search/search")) {
        return Response.json({
          status: "ok",
          result: {
            memories: [{
              uri: "viking://user/memories/preferences/release-notes.md",
              abstract: "Keep release notes concise.",
            }],
          },
        });
      }
      if (String(url).endsWith("/commit")) {
        return Response.json({ status: "ok", result: { task_id: "task-opencode-session-1" } });
      }
      if (String(url).includes("/api/v1/content/read")) return Response.json({ status: "ok", result: { content: "" } });
      return Response.json({ status: "ok", result: {} });
    },
  });
  const hooks = await plugin({ directory: project });
  const output = { parts: [{ type: "text", text: "What was our release note rule?" }] };

  await hooks["chat.message"]({ sessionID: "session-1" }, output);
  assert.match(output.parts[0].text, /Keep release notes concise/);
  await hooks.event({ event: { type: "message.updated", properties: { info: { id: "assistant-message", sessionID: "session-1", role: "assistant" } } } });
  await hooks.event({ event: { type: "message.part.updated", properties: { part: { id: "assistant-part-1", messageID: "assistant-message", sessionID: "session-1", type: "text", text: "Use one clear user-facing bullet." } } } });
  await hooks.event({ event: { type: "message.part.updated", properties: { part: { id: "assistant-part-2", messageID: "assistant-message", sessionID: "session-1", type: "text", text: "Keep the wording concise." } } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });

  assert.equal(requests.filter((request) => request.url.endsWith("/api/v1/search/search")).length, 1);
  const search = requests.find((request) => request.url.endsWith("/api/v1/search/search"));
  assert.match(JSON.parse(search.init.body).session_id, /^opencode-workspace-1-session-1$/);
  assert.equal(requests.filter((request) => request.url.endsWith("/messages/batch")).length, 1);
  const batch = requests.find((request) => request.url.endsWith("/messages/batch"));
  const capturedMessages = JSON.parse(batch.init.body).messages;
  assert.deepEqual(capturedMessages.map((message) => message.role), ["user", "assistant"]);
  assert.match(capturedMessages[1].content, /Use one clear user-facing bullet/);
  assert.match(capturedMessages[1].content, /Keep the wording concise/);

  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "session-1" } } });
  const stateDir = path.join(root, "state");
  const stateFile = fs.readdirSync(stateDir).find((name) => name.endsWith(".json"));
  assert.ok(stateFile);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, stateFile), "utf8"));
  assert.equal(state.sourceSessionId, "session-1");
  assert.equal(state.commitTasks.at(-1).sourceSessionId, "session-1");
  assert.equal(state.commitTasks.at(-1).taskId, "task-opencode-session-1");

  const nextOutput = { parts: [{ type: "text", text: "Continue with that approach." }] };
  await hooks["chat.message"]({ sessionID: "session-1" }, nextOutput);
  const nextSearch = requests.filter((request) => request.url.endsWith("/api/v1/search/search")).at(-1);
  const nextQuery = JSON.parse(nextSearch.init.body).query;
  assert.match(nextQuery, /What was our release note rule/);
  assert.match(nextQuery, /Use one clear user-facing bullet/);

  const clearOutput = { parts: [{ type: "text", text: "Explain the release-note validation rules." }] };
  await hooks["chat.message"]({ sessionID: "session-1" }, clearOutput);
  const clearSearch = requests.filter((request) => request.url.endsWith("/api/v1/search/search")).at(-1);
  assert.equal(JSON.parse(clearSearch.init.body).query, "Explain the release-note validation rules.");
});
