import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  memoryEvidence,
  memoryFeedback,
  memoryRead,
  memorySearch,
  resolveOpenVikingManifestPath,
} from "../bin/agent-recall-mcp.mjs";

async function memoryDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA agent_recall;
    CREATE TABLE agent_recall.openviking_memories (
      workspace_id text NOT NULL,
      uri text NOT NULL,
      memory_type text NOT NULL,
      authority text NOT NULL,
      lifecycle text NOT NULL,
      locked boolean NOT NULL,
      evidence_status text NOT NULL,
      source text NOT NULL,
      title text,
      locked_content text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (workspace_id, uri)
    );
    CREATE TABLE agent_recall.openviking_memory_evidence (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      memory_uri text NOT NULL,
      source_session_id text,
      source_agent text,
      source_turn_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      archive_uri text,
      memory_diff_uri text,
      remote_task_id text,
      model_snapshot jsonb,
      policy_snapshot jsonb,
      state text NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE agent_recall.openviking_memory_feedback (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      memory_uri text NOT NULL,
      feedback text NOT NULL,
      actor text NOT NULL,
      note text,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE agent_recall.openviking_operation_events (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      phase text NOT NULL,
      status text NOT NULL,
      session_id text,
      task_id text,
      started_at timestamptz NOT NULL,
      completed_at timestamptz,
      duration_ms integer,
      details jsonb
    );
    CREATE TABLE agent_recall.openviking_recall_traces (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agent text NOT NULL,
      query text NOT NULL,
      contextual_query text NOT NULL,
      searched_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      searched_types jsonb NOT NULL DEFAULT '[]'::jsonb,
      candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
      injected_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
      injected_token_count integer NOT NULL DEFAULT 0,
      duration_ms integer NOT NULL DEFAULT 0,
      degraded_reason text,
      created_at timestamptz NOT NULL
    );
  `);
  return db;
}

function manifest(policyPath) {
  return {
    version: 2,
    baseUrl: "http://127.0.0.1:21933",
    workspaces: [{
      id: "workspace-1",
      displayName: "app",
      rootPath: "/projects/app",
      accountId: "agent-recall-v2",
      userId: "workspace_user",
      apiKey: "workspace-key",
      ...(policyPath ? { policyPath } : {}),
    }],
  };
}

test("resolves the app-written OpenViking manifest pointer", (context) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-recall-memory-mcp-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const manifestPath = path.join(home, "runtime", "hook-manifest.json");
  mkdirSync(path.join(home, ".agent-recall-v2"), { recursive: true });
  writeFileSync(path.join(home, ".agent-recall-v2", "openviking-manifest-path"), `${manifestPath}\n`);

  assert.equal(resolveOpenVikingManifestPath({}, home), manifestPath);
});

test("memory_search filters invalid memories and returns user-locked content first", async (context) => {
  const db = await memoryDatabase();
  context.after(() => db.close());
  await db.query(
    `INSERT INTO agent_recall.openviking_memories
      (workspace_id, uri, memory_type, authority, lifecycle, locked,
       evidence_status, source, locked_content, created_at, updated_at)
     VALUES
      ('workspace-1', 'viking://user/memories/preferences/editor.md', 'preferences', 'user', 'active', true,
       'verified', 'user-edit', 'Prefer concise diffs.', now(), now()),
      ('workspace-1', 'viking://user/memories/events/obsolete.md', 'events', 'model', 'invalidated', false,
       'invalid', 'openviking', null, now(), now())`,
  );
  const requests = [];
  const result = await memorySearch(db, { query: "diff policy", scope: "workspace-1" }, {
    manifest: manifest(),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({
        status: "ok",
        result: {
          memories: [
            { uri: "viking://user/workspace_user/memories/events/obsolete.md", abstract: "obsolete", score: 0.99 },
            { uri: "viking://user/workspace_user/memories/preferences/editor.md", abstract: "model version", score: 0.2 },
          ],
        },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => item.uri), [
    "viking://user/memories/preferences/editor.md",
  ]);
  assert.equal(result.results[0].content, "Prefer concise diffs.");
  assert.equal(requests[0].init.headers["X-OpenViking-User"], "workspace_user");
  const trace = (await db.query(
    "SELECT agent, query, candidates, injected_uris FROM agent_recall.openviking_recall_traces",
  )).rows[0];
  const event = (await db.query(
    "SELECT phase, status, details FROM agent_recall.openviking_operation_events",
  )).rows[0];
  assert.equal(trace.agent, "mcp");
  assert.equal(trace.query, "diff policy");
  assert.deepEqual(trace.injected_uris, ["viking://user/memories/preferences/editor.md"]);
  assert.deepEqual(trace.candidates.map((candidate) => [candidate.uri, candidate.decision, candidate.reason]), [
    ["viking://user/memories/events/obsolete.md", "filtered", "lifecycle:invalidated"],
    ["viking://user/memories/preferences/editor.md", "injected", "returned"],
  ]);
  assert.equal(event.phase, "recall");
  assert.equal(event.status, "completed");
  assert.equal(event.details.source, "mcp");
});

test("memory_read returns the locked user version without a manifest or OpenViking request", async (context) => {
  const db = await memoryDatabase();
  context.after(() => db.close());
  const uri = "viking://user/memories/preferences/editor.md";
  await db.query(
    `INSERT INTO agent_recall.openviking_memories
      (workspace_id, uri, memory_type, authority, lifecycle, locked,
       evidence_status, source, locked_content, created_at, updated_at)
     VALUES ($1, $2, 'preferences', 'user', 'active', true,
       'verified', 'user-edit', 'Prefer concise diffs.', now(), now())`,
    ["workspace-1", uri],
  );
  let fetched = false;

  const result = await memoryRead(db, {
    workspaceId: "workspace-1",
    uri: "viking://user/workspace_user/memories/preferences/editor.md",
  }, {
    fetchImpl: async () => {
      fetched = true;
      return Response.json({ status: "ok", result: { content: "model version" } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.content, "Prefer concise diffs.");
  assert.equal(result.source, "locked-user-version");
  assert.equal(fetched, false);
});

test("memory_feedback invalidates active evidence and is visible through memory_evidence", async (context) => {
  const db = await memoryDatabase();
  context.after(() => db.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-recall-memory-policy-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const policyPath = path.join(home, "memory-policies", "workspace-1.json");
  const uri = "viking://user/memories/events/release.md";
  await db.query(
    `INSERT INTO agent_recall.openviking_memories
      (workspace_id, uri, memory_type, authority, lifecycle, locked,
       evidence_status, source, created_at, updated_at)
     VALUES ($1, $2, 'events', 'model', 'active', false,
       'verified', 'openviking', now(), now())`,
    ["workspace-1", uri],
  );
  await db.query(
    `INSERT INTO agent_recall.openviking_memory_evidence
      (id, workspace_id, memory_uri, source_session_id, source_agent,
       source_turn_ids, state, created_at, updated_at)
     VALUES ('evidence-1', $1, $2, 'session-1', 'codex', '["turn-1"]', 'active', now(), now())`,
    ["workspace-1", uri],
  );

  const result = await memoryFeedback(db, {
    workspaceId: "workspace-1",
    uri: "viking://user/workspace_user/memories/events/release.md",
    feedback: "wrong",
    note: "Repository state contradicts this memory.",
  }, {
    manifest: manifest(policyPath),
  });
  const details = await memoryEvidence(db, { workspaceId: "workspace-1", uri });
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));

  assert.equal(result.ok, true);
  assert.equal(details.control.lifecycle, "invalidated");
  assert.equal(details.control.evidenceStatus, "invalid");
  assert.equal(details.evidence[0].state, "invalidated");
  assert.equal(details.feedback[0].feedback, "wrong");
  assert.equal(policy.memories[uri].lifecycle, "invalidated");
  assert.equal(policy.memories[uri].evidenceStatus, "invalid");
  assert.equal(policy.memories[uri].evidenceCount, 0);
});
