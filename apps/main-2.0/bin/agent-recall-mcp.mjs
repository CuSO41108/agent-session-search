#!/usr/bin/env node
// MCP stdio server exposing the local AgentRecall PostgreSQL database, so
// Claude Code / Codex can recall "how did I solve X before" from past sessions
// and manage them (tag, favorite, visibility).
//
// The query and write functions below are exported and SDK-free so they can be
// unit tested; the MCP wiring is loaded lazily in runServer().

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_RESULTS = 50;
const MAX_MESSAGES = 200;
const MAX_MEMORY_RESULTS = 50;
const OPENVIKING_MANIFEST_POINTER = "openviking-manifest-path";

export function resolveAppVersion(packageUrl = new URL("../package.json", import.meta.url)) {
  try {
    const value = JSON.parse(readFileSync(fileURLToPath(packageUrl), "utf8"));
    return typeof value.version === "string" && value.version ? value.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Mirrors src/core/app-paths.ts (this file runs standalone, outside the bundle).
export function resolveDatabaseUrl(env = process.env, home = homedir()) {
  const override = env.AGENT_RECALL_DATABASE_URL && env.AGENT_RECALL_DATABASE_URL.trim();
  if (override) return override;
  const pointer = path.join(home, ".agent-recall-v2", "database-url");
  try {
    if (!existsSync(pointer)) return null;
    return readFileSync(pointer, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function resolveOpenVikingManifestPath(env = process.env, home = homedir()) {
  const override = env.AGENT_RECALL_OPENVIKING_MANIFEST?.trim();
  if (override) return override;
  const pointer = path.join(home, ".agent-recall-v2", OPENVIKING_MANIFEST_POINTER);
  try {
    if (existsSync(pointer)) {
      const pointedPath = readFileSync(pointer, "utf8").trim();
      if (pointedPath) return pointedPath;
    }
  } catch {}
  const candidates = [
    path.join(home, ".agent-recall-v2", "openviking", "hook-manifest.json"),
    path.join(home, "Library", "Application Support", "agent-recall-v2", "openviking", "hook-manifest.json"),
    ...(env.APPDATA ? [path.join(env.APPDATA, "agent-recall-v2", "openviking", "hook-manifest.json")] : []),
    path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "agent-recall-v2", "openviking", "hook-manifest.json"),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function clamp(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function searchTerms(query) {
  const terms = [];
  const pattern = /"([^"]+)"|(\S+)/gu;
  for (const match of String(query ?? "").matchAll(pattern)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (value) terms.push(value);
  }
  return terms;
}

function likePattern(term) {
  return `%${term.replace(/[\\%_]/gu, (value) => `\\${value}`)}%`;
}

function toResult(row) {
  return {
    sessionKey: row.session_key,
    title: row.custom_title || row.first_question || row.original_title || "Untitled Session",
    source: row.source,
    project: row.project_path,
    timestamp: new Date(row.timestamp).toISOString(),
    summary: (row.ai_summary && row.ai_summary.trim()) || null,
  };
}

const RESULT_COLUMNS = `
  s.session_key, s.source, s.project_path, s.started_at AS timestamp, s.original_title,
  s.first_question, s.custom_title, s.ai_summary
`;

export async function searchSessions(db, { query = "", source = "", project = "", limit = 20 } = {}) {
  const cap = clamp(limit, 20, MAX_RESULTS);
  const filters = [];
  const params = [];
  if (source) {
    params.push(source);
    filters.push(`s.source = $${params.length}`);
  }
  if (project) {
    params.push(`%${project}%`);
    filters.push(`s.project_path ILIKE $${params.length}`);
  }

  const q = String(query || "").trim();
  if (q) {
    const searchable = `concat_ws(' ', t.search_text, s.original_title, s.first_question, s.custom_title, s.ai_summary)`;
    for (const term of searchTerms(q)) {
      params.push(likePattern(term));
      filters.push(`${searchable} ILIKE $${params.length} ESCAPE '\\'`);
    }
    params.push(q, cap);
    const rows = await db.query(
      `SELECT ${RESULT_COLUMNS},
              max(similarity(lower(t.search_text), lower($${params.length - 1}))) AS score
         FROM agent_recall.sessions s
         JOIN agent_recall.session_turns t ON t.session_key = s.session_key
        WHERE ${filters.join(" AND ")}
        GROUP BY s.session_key
        ORDER BY score DESC, s.file_mtime_ms DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.rows.map(toResult);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  params.push(cap);
  const rows = await db.query(
    `SELECT ${RESULT_COLUMNS}
       FROM agent_recall.sessions s
       ${where}
      ORDER BY s.file_mtime_ms DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(toResult);
}

export async function getSession(db, { sessionKey, maxMessages = 40, offset = 0 } = {}) {
  if (!sessionKey) return null;
  const row = (await db.query(
    `SELECT ${RESULT_COLUMNS}
       FROM agent_recall.sessions s
      WHERE s.session_key = $1`,
    [sessionKey],
  )).rows[0];
  if (!row) return null;
  const cap = clamp(maxMessages, 40, MAX_MESSAGES);
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const totalRow = (await db.query(
    `SELECT count(*)::integer AS n
       FROM agent_recall.turn_messages m
       JOIN agent_recall.session_turns t ON t.id = m.turn_id
      WHERE t.session_key = $1`,
    [sessionKey],
  )).rows[0];
  const totalMessages = Number(totalRow?.n ?? 0);
  const messages = (await db.query(
    `SELECT m.role, m.content
       FROM agent_recall.turn_messages m
       JOIN agent_recall.session_turns t ON t.id = m.turn_id
      WHERE t.session_key = $1
      ORDER BY t.turn_index, m.message_index
      LIMIT $2 OFFSET $3`,
    [sessionKey, cap, start],
  )).rows;
  const nextOffset = start + messages.length < totalMessages
    ? start + messages.length
    : null;
  return {
    ...toResult(row),
    totalMessages,
    offset: start,
    returned: messages.length,
    // Non-null when the session has more messages; pass it back as `offset` to continue.
    nextOffset,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
}

export async function listProjects(db) {
  const result = await db.query(
    `SELECT project_path, count(*)::integer AS sessions
       FROM agent_recall.sessions
      WHERE project_path <> ''
      GROUP BY project_path
      ORDER BY sessions DESC
      LIMIT 100`,
  );
  return result.rows.map((row) => ({ project: row.project_path, sessions: Number(row.sessions) }));
}

export async function listTags(db) {
  return (await db.query("SELECT name FROM agent_recall.tags ORDER BY lower(name)")).rows
    .map((row) => row.name);
}

// Returns the most recently active sessions (by file mtime / last activity).
// This lets an agent find "the session I'm currently in" or "my latest codex
// session" without a sessionKey — the missing piece for natural-language
// migration like "把这次会话迁移到 claude".
export async function getLatestSessions(db, { source = "", projectPath = "", limit = 5 } = {}) {
  const cap = clamp(limit, 1, 20);
  const filters = [];
  const params = [];
  if (source) {
    params.push(source);
    filters.push(`s.source = $${params.length}`);
  }
  if (projectPath) {
    params.push(`%${projectPath}%`);
    filters.push(`s.project_path ILIKE $${params.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  params.push(cap);
  const rows = await db.query(
    `SELECT ${RESULT_COLUMNS}
       FROM agent_recall.sessions s
       ${where}
      ORDER BY s.file_mtime_ms DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(toResult);
}

// --- Write operations -----------------------------------------------------
// These mirror the semantics of SessionStore's write methods, reimplemented in
// raw SQL because this bin runs standalone (outside the app bundle) and can't
// import SessionStore. All are idempotent.

async function sessionExists(db, sessionKey) {
  return (await db.query(
    "SELECT 1 FROM agent_recall.sessions WHERE session_key = $1",
    [sessionKey],
  )).rows.length > 0;
}

async function currentTags(db, sessionKey) {
  return (await db.query(
    `SELECT tags.name
       FROM agent_recall.session_tags
       JOIN agent_recall.tags ON tags.id = session_tags.tag_id
      WHERE session_tags.session_key = $1
      ORDER BY lower(tags.name)`,
    [sessionKey],
  )).rows.map((row) => row.name);
}

// Drop a tag from the tags table once no session references it (matches
// SessionStore.deleteUnusedTag), so removing the last use doesn't leave orphans.
async function deleteUnusedTag(db, tagName) {
  await db.query(
    `DELETE FROM agent_recall.tags
      WHERE name = $1
        AND NOT EXISTS (
          SELECT 1
            FROM agent_recall.session_tags
           WHERE session_tags.tag_id = tags.id
        )`,
    [tagName],
  );
}

export async function tagSession(db, { sessionKey, action, tag } = {}) {
  if (!sessionKey || !await sessionExists(db, sessionKey)) return { ok: false, error: "Session not found." };
  const name = String(tag ?? "").trim();
  if (!name) return { ok: false, error: "Tag must not be empty." };
  if (action !== "add" && action !== "remove") return { ok: false, error: 'action must be "add" or "remove".' };

  if (action === "add") {
    await db.query(
      "INSERT INTO agent_recall.tags (name) VALUES ($1) ON CONFLICT(name) DO NOTHING",
      [name],
    );
    await db.query(
      `INSERT INTO agent_recall.session_tags (session_key, tag_id)
       SELECT $1, id FROM agent_recall.tags WHERE name = $2
       ON CONFLICT DO NOTHING`,
      [sessionKey, name],
    );
  } else {
    await db.query(
      `DELETE FROM agent_recall.session_tags
        WHERE session_key = $1
          AND tag_id = (SELECT id FROM agent_recall.tags WHERE name = $2)`,
      [sessionKey, name],
    );
    await deleteUnusedTag(db, name);
  }
  return { ok: true, sessionKey, action, tag: name, tags: await currentTags(db, sessionKey) };
}

export async function toggleFavorite(db, { sessionKey, favorited } = {}) {
  if (!sessionKey || !await sessionExists(db, sessionKey)) return { ok: false, error: "Session not found." };
  await db.query(
    "UPDATE agent_recall.sessions SET favorited = $1 WHERE session_key = $2",
    [Boolean(favorited), sessionKey],
  );
  return { ok: true, sessionKey, favorited: Boolean(favorited) };
}

// Visibility is derived from favorited / hidden flags. Each call sets the
// requested dimension and clears what would otherwise hide the session from
// that view without disturbing unrelated flags.
export async function setVisibility(db, { sessionKey, visibility } = {}) {
  if (!sessionKey || !await sessionExists(db, sessionKey)) return { ok: false, error: "Session not found." };
  switch (visibility) {
    case "default":
      await db.query(
        "UPDATE agent_recall.sessions SET hidden = false WHERE session_key = $1",
        [sessionKey],
      );
      break;
    case "favorites":
      await db.query(
        "UPDATE agent_recall.sessions SET favorited = true, hidden = false WHERE session_key = $1",
        [sessionKey],
      );
      break;
    case "hidden":
      await db.query(
        "UPDATE agent_recall.sessions SET hidden = true WHERE session_key = $1",
        [sessionKey],
      );
      break;
    default:
      return { ok: false, error: 'visibility must be one of "default", "favorites", or "hidden".' };
  }
  const row = (await db.query(
    "SELECT favorited, hidden FROM agent_recall.sessions WHERE session_key = $1",
    [sessionKey],
  )).rows[0];
  return {
    ok: true,
    sessionKey,
    visibility,
    favorited: row.favorited === true,
    hidden: row.hidden === true,
  };
}

export function readOpenVikingManifest(manifestPath) {
  if (!manifestPath) return null;
  try {
    const value = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!value || typeof value !== "object" || !Array.isArray(value.workspaces)) return null;
    return value;
  } catch {
    return null;
  }
}

export async function memorySearch(
  db,
  { query = "", scope = "", types = [], time_range: timeRange, limit = 20 } = {},
  options = {},
) {
  const started = Date.now();
  const text = String(query || "").trim();
  if (!text) return { ok: false, error: "query is required." };
  const manifest = options.manifest ?? readOpenVikingManifest(options.manifestPath);
  if (!manifest?.baseUrl) return { ok: false, error: "OpenViking runtime is not running." };
  const workspaces = selectMemoryWorkspaces(manifest, scope);
  if (workspaces.length === 0) return { ok: false, error: "No matching managed memory directory was found." };
  const cap = clamp(limit, 20, MAX_MEMORY_RESULTS);
  const requestedTypes = new Set(
    (Array.isArray(types) ? types : [])
      .map((value) => String(value).trim().toLowerCase())
      .filter(Boolean),
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const searchedScopes = workspaces.map((workspace) => workspace.id);
  const attempts = await Promise.all(workspaces.map(async (workspace) => {
    try {
      const payload = await requestOpenViking(manifest.baseUrl, workspace, "/api/v1/search/find", {
        method: "POST",
        body: JSON.stringify({
          query: text,
          target_uri: "viking://user/memories",
          limit: Math.max(cap, 24),
        }),
      }, fetchImpl);
      const raw = Array.isArray(payload.memories)
        ? payload.memories
        : Array.isArray(payload.resources)
          ? payload.resources
          : Array.isArray(payload.items)
            ? payload.items
            : [];
      const memories = [];
      const seenUris = new Set();
      for (const value of raw) {
        const memory = normalizeMemoryResult(value, workspace.userId);
        if (!memory || seenUris.has(memory.uri)) continue;
        seenUris.add(memory.uri);
        memories.push(memory);
      }
      const controls = await loadMemoryControls(db, workspace.id, memories.map((memory) => memory.uri));
      const candidates = [];
      const accepted = [];
      for (const [index, memory] of memories.entries()) {
        const control = controls.get(memory.uri) ?? defaultMemoryControl(workspace.id, memory.uri);
        const candidate = memoryTraceCandidate(memory, control);
        candidates.push(candidate);
        if (control.lifecycle !== "active") {
          candidate.reason = `lifecycle:${control.lifecycle}`;
          continue;
        }
        if (control.evidenceStatus === "invalid") {
          candidate.reason = "invalid-evidence";
          continue;
        }
        if (requestedTypes.size > 0 && !requestedTypes.has(control.memoryType.toLowerCase())) {
          candidate.reason = "type-filter";
          continue;
        }
        const effectiveTime = memory.updatedAt || control.updatedAt;
        if (!matchesTimeRange(effectiveTime, timeRange)) {
          candidate.reason = "time-range";
          continue;
        }
        const score = memory.score ?? Math.max(0, 1 - index / Math.max(1, memories.length));
        const rankScore = score
          + (control.authority === "user" ? 0.15 : 0)
          + (control.locked ? 0.25 : 0)
          + (control.evidenceStatus === "verified" ? 0.1 : -0.1)
          + Math.min(0.1, Math.log2(1 + control.evidenceCount) * 0.025);
        candidate.score = score;
        candidate.decision = "injected";
        candidate.reason = "candidate";
        accepted.push({
          key: memoryResultKey(workspace.id, memory.uri),
          trace: candidate,
          memory: {
            workspaceId: workspace.id,
            workspaceName: workspace.displayName || workspace.id,
            rootPath: workspace.rootPath,
            uri: memory.uri,
            title: memory.title,
            content: control.locked && control.lockedContent !== undefined
              ? control.lockedContent
              : memory.content,
            score,
            rankScore,
            updatedAt: effectiveTime || null,
            memoryType: control.memoryType,
            authority: control.authority,
            lifecycle: control.lifecycle,
            locked: control.locked,
            evidenceStatus: control.evidenceStatus,
            evidenceCount: control.evidenceCount,
          },
        });
      }
      return { workspace, candidates, accepted };
    } catch (error) {
      return { workspace, candidates: [], accepted: [], error };
    }
  }));
  const ranked = attempts
    .flatMap((attempt) => attempt.accepted)
    .sort((left, right) => right.memory.rankScore - left.memory.rankScore);
  const selected = ranked.slice(0, cap);
  const selectedKeys = new Set(selected.map((entry) => entry.key));
  for (const entry of ranked) {
    entry.trace.decision = selectedKeys.has(entry.key) ? "injected" : "budget";
    entry.trace.reason = selectedKeys.has(entry.key) ? "returned" : "result-limit";
  }
  const completed = Date.now();
  await Promise.all(attempts.map((attempt) => recordMcpRecall(db, {
    workspaceId: attempt.workspace.id,
    query: text,
    searchedScopes,
    searchedTypes: requestedTypes.size > 0
      ? [...requestedTypes]
      : [...new Set(attempt.candidates.map((candidate) => candidate.memoryType))],
    candidates: attempt.candidates,
    returned: selected
      .filter((entry) => entry.memory.workspaceId === attempt.workspace.id)
      .map((entry) => entry.memory),
    started,
    completed,
    error: attempt.error,
  })));
  const failed = attempts.filter((attempt) => attempt.error);
  if (failed.length === attempts.length) {
    return {
      ok: false,
      error: failed.map((attempt) => errorMessage(attempt.error)).join("; ") || "OpenViking search failed.",
    };
  }
  return {
    ok: true,
    query: text,
    scope: scope || "all-managed-directories",
    results: selected.map(({ memory: { rankScore: _rankScore, ...memory } }) => memory),
    ...(failed.length > 0 ? {
      degradedWorkspaces: failed.map((attempt) => ({
        workspaceId: attempt.workspace.id,
        error: errorMessage(attempt.error),
      })),
    } : {}),
  };
}

export async function memoryRead(db, { workspaceId, uri } = {}, options = {}) {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const normalizedUri = requireMemoryUri(uri);
  if (!normalizedWorkspaceId) return { ok: false, error: "workspaceId is required." };
  const control = await loadMemoryControl(db, normalizedWorkspaceId, normalizedUri);
  if (control?.locked && control.lockedContent !== undefined) {
    return {
      ok: true,
      workspaceId: normalizedWorkspaceId,
      uri: normalizedUri,
      content: control.lockedContent,
      source: "locked-user-version",
      control,
    };
  }
  const manifest = options.manifest ?? readOpenVikingManifest(options.manifestPath);
  const workspace = manifest?.workspaces?.find((candidate) => candidate?.id === normalizedWorkspaceId);
  if (!workspace) return { ok: false, error: "Managed memory directory credentials are unavailable." };
  if (!manifest?.baseUrl) return { ok: false, error: "OpenViking runtime is not running." };
  const payload = await requestOpenViking(
    manifest.baseUrl,
    workspace,
    `/api/v1/content/read?uri=${encodeURIComponent(normalizedUri)}&offset=0&limit=1048576`,
    { method: "GET" },
    options.fetchImpl ?? fetch,
  );
  const content = typeof payload === "string" ? payload : payload?.content ?? payload?.text ?? payload?.data ?? "";
  return {
    ok: true,
    workspaceId: normalizedWorkspaceId,
    uri: normalizedUri,
    content: String(content || ""),
    source: "openviking",
    control: control ?? defaultMemoryControl(normalizedWorkspaceId, normalizedUri),
  };
}

export async function memoryEvidence(db, { workspaceId, uri } = {}) {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const normalizedUri = requireMemoryUri(uri);
  if (!normalizedWorkspaceId) return { ok: false, error: "workspaceId is required." };
  const [control, evidence, feedback] = await Promise.all([
    loadMemoryControl(db, normalizedWorkspaceId, normalizedUri),
    db.query(
      `SELECT id, workspace_id, memory_uri, source_session_id, source_agent,
              source_turn_ids, archive_uri, memory_diff_uri, remote_task_id,
              model_snapshot, policy_snapshot, state, created_at, updated_at
         FROM agent_recall.openviking_memory_evidence
        WHERE workspace_id = $1 AND memory_uri = $2
        ORDER BY created_at DESC, id DESC`,
      [normalizedWorkspaceId, normalizedUri],
    ),
    db.query(
      `SELECT id, workspace_id, memory_uri, feedback, actor, note, created_at
         FROM agent_recall.openviking_memory_feedback
        WHERE workspace_id = $1 AND memory_uri = $2
        ORDER BY created_at DESC, id DESC`,
      [normalizedWorkspaceId, normalizedUri],
    ),
  ]);
  return {
    ok: true,
    workspaceId: normalizedWorkspaceId,
    uri: normalizedUri,
    control: control ?? defaultMemoryControl(normalizedWorkspaceId, normalizedUri),
    evidence: evidence.rows.map(mapMemoryEvidence),
    feedback: feedback.rows.map(mapMemoryFeedback),
  };
}

export async function memoryFeedback(
  db,
  { workspaceId, uri, feedback, note = "", actor = "agent" } = {},
  options = {},
) {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const normalizedUri = requireMemoryUri(uri);
  if (!normalizedWorkspaceId) return { ok: false, error: "workspaceId is required." };
  if (!["helpful", "wrong", "outdated"].includes(feedback)) {
    return { ok: false, error: 'feedback must be "helpful", "wrong", or "outdated".' };
  }
  const now = new Date().toISOString();
  const fallback = defaultMemoryControl(normalizedWorkspaceId, normalizedUri);
  const lifecycle = feedback === "helpful" ? "active" : feedback === "wrong" ? "invalidated" : "superseded";
  const evidenceStatus = feedback === "helpful" ? null : "invalid";
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    if (client !== db) await client.query("BEGIN");
    await client.query(
      `INSERT INTO agent_recall.openviking_memories (
         workspace_id, uri, memory_type, authority, lifecycle, locked,
         evidence_status, source, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', false, $5, $6, $7, $7)
       ON CONFLICT (workspace_id, uri) DO NOTHING`,
      [
        normalizedWorkspaceId,
        normalizedUri,
        fallback.memoryType,
        fallback.authority,
        fallback.evidenceStatus,
        fallback.source,
        now,
      ],
    );
    await client.query(
      `UPDATE agent_recall.openviking_memories
          SET lifecycle = $3,
              evidence_status = COALESCE($4, evidence_status),
              updated_at = $5
        WHERE workspace_id = $1 AND uri = $2`,
      [normalizedWorkspaceId, normalizedUri, lifecycle, evidenceStatus, now],
    );
    if (feedback !== "helpful") {
      await client.query(
        `UPDATE agent_recall.openviking_memory_evidence
            SET state = 'invalidated', updated_at = $3
          WHERE workspace_id = $1 AND memory_uri = $2 AND state = 'active'`,
        [normalizedWorkspaceId, normalizedUri, now],
      );
    }
    await client.query(
      `INSERT INTO agent_recall.openviking_memory_feedback (
         id, workspace_id, memory_uri, feedback, actor, note, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        normalizedWorkspaceId,
        normalizedUri,
        feedback,
        String(actor || "agent").slice(0, 100),
        String(note || "").trim() || null,
        now,
      ],
    );
    if (client !== db) await client.query("COMMIT");
  } catch (error) {
    if (client !== db) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (client !== db) client.release();
  }
  await refreshMemoryPolicy(db, normalizedWorkspaceId, options);
  return memoryEvidence(db, { workspaceId: normalizedWorkspaceId, uri: normalizedUri });
}

function selectMemoryWorkspaces(manifest, scope) {
  const workspaces = manifest.workspaces.filter((workspace) => (
    workspace
    && typeof workspace.id === "string"
    && typeof workspace.apiKey === "string"
    && typeof workspace.accountId === "string"
    && typeof workspace.userId === "string"
  ));
  const target = String(scope || "").trim();
  if (!target || target === "all") return workspaces;
  return workspaces.filter((workspace) => (
    workspace.id === target
    || workspace.rootPath === target
    || workspace.displayName === target
  ));
}

async function requestOpenViking(baseUrl, workspace, route, init, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/u, "")}${route}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": workspace.apiKey,
        "X-OpenViking-Account": workspace.accountId,
        "X-OpenViking-User": workspace.userId,
        ...(init.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.status === "error" || payload?.error) {
      throw new Error(payload?.message || payload?.error?.message || `OpenViking request failed (${response.status}).`);
    }
    return payload?.result ?? payload;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeMemoryResult(value, userId) {
  if (!value || typeof value !== "object") return null;
  const uri = canonicalMemoryUri(value.uri || value.id, userId);
  if (!uri) return null;
  const relative = uri.replace(/^viking:\/\/user\/memories\//u, "");
  return {
    uri,
    title: String(value.title || value.name || relative.split("/").at(-1)?.replace(/\.md$/iu, "") || uri),
    content: String(value.abstract || value.overview || value.content || value.text || ""),
    ...(typeof value.score === "number" && Number.isFinite(value.score) ? { score: value.score } : {}),
    updatedAt: stringValue(value.updatedAt || value.updated_at || value.modTime || value.mod_time),
  };
}

function memoryTraceCandidate(memory, control) {
  return {
    uri: memory.uri,
    ...(memory.score === undefined ? {} : { score: memory.score }),
    decision: "filtered",
    reason: "not-selected",
    memoryType: control.memoryType,
    authority: control.authority,
    lifecycle: control.lifecycle,
    evidenceStatus: control.evidenceStatus,
    locked: control.locked,
  };
}

function memoryResultKey(workspaceId, uri) {
  return `${workspaceId}\u0000${uri}`;
}

async function recordMcpRecall(db, input) {
  const traceId = randomUUID();
  const durationMs = Math.max(0, input.completed - input.started);
  const createdAt = new Date(input.completed).toISOString();
  const returnedUris = input.returned.map((memory) => memory.uri);
  const injectedTokenCount = input.returned.reduce(
    (total, memory) => total + estimateTokens(`${memory.title}\n${memory.content}`),
    0,
  );
  const degradedReason = input.error ? errorMessage(input.error) : null;
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    if (client !== db) await client.query("BEGIN");
    await client.query(
      `INSERT INTO agent_recall.openviking_recall_traces (
         id, workspace_id, agent, query, contextual_query, searched_scopes,
         searched_types, candidates, injected_uris, injected_token_count,
         duration_ms, degraded_reason, created_at
       ) VALUES ($1, $2, 'mcp', $3, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        traceId,
        input.workspaceId,
        input.query,
        JSON.stringify(input.searchedScopes),
        JSON.stringify(input.searchedTypes),
        JSON.stringify(input.candidates),
        JSON.stringify(returnedUris),
        injectedTokenCount,
        durationMs,
        degradedReason,
        createdAt,
      ],
    );
    await client.query(
      `INSERT INTO agent_recall.openviking_operation_events (
         id, workspace_id, phase, status, started_at, completed_at, duration_ms, details
       ) VALUES ($1, $2, 'recall', $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        `${traceId}:event`,
        input.workspaceId,
        input.error ? "failed" : "completed",
        new Date(input.started).toISOString(),
        createdAt,
        durationMs,
        JSON.stringify({
          source: "mcp",
          candidateCount: input.candidates.length,
          returnedCount: returnedUris.length,
          searchedScopes: input.searchedScopes,
          searchedTypes: input.searchedTypes,
          ...(degradedReason ? { reason: degradedReason } : {}),
        }),
      ],
    );
    if (client !== db) await client.query("COMMIT");
  } catch (error) {
    if (client !== db) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (client !== db) client.release();
  }
}

function estimateTokens(value) {
  const text = String(value || "");
  let cjk = 0;
  for (const character of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)) cjk += 1;
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

async function loadMemoryControls(db, workspaceId, uris) {
  if (uris.length === 0) return new Map();
  const rows = await db.query(
    `SELECT memories.workspace_id, memories.uri, memories.memory_type,
            memories.authority, memories.lifecycle, memories.locked,
            memories.evidence_status, memories.source, memories.title,
            memories.locked_content, memories.created_at, memories.updated_at,
            count(evidence.id) FILTER (WHERE evidence.state = 'active')::integer AS evidence_count
       FROM agent_recall.openviking_memories memories
       LEFT JOIN agent_recall.openviking_memory_evidence evidence
         ON evidence.workspace_id = memories.workspace_id
        AND evidence.memory_uri = memories.uri
      WHERE memories.workspace_id = $1 AND memories.uri = ANY($2::text[])
      GROUP BY memories.workspace_id, memories.uri`,
    [workspaceId, [...new Set(uris)]],
  );
  return new Map(rows.rows.map((row) => [row.uri, mapMemoryControl(row)]));
}

async function loadMemoryControl(db, workspaceId, uri) {
  return (await loadMemoryControls(db, workspaceId, [uri])).get(uri) ?? null;
}

async function loadWorkspaceMemoryControls(db, workspaceId) {
  const rows = await db.query(
    `SELECT memories.workspace_id, memories.uri, memories.memory_type,
            memories.authority, memories.lifecycle, memories.locked,
            memories.evidence_status, memories.source, memories.title,
            memories.locked_content, memories.created_at, memories.updated_at,
            count(evidence.id) FILTER (WHERE evidence.state = 'active')::integer AS evidence_count
       FROM agent_recall.openviking_memories memories
       LEFT JOIN agent_recall.openviking_memory_evidence evidence
         ON evidence.workspace_id = memories.workspace_id
        AND evidence.memory_uri = memories.uri
      WHERE memories.workspace_id = $1
      GROUP BY memories.workspace_id, memories.uri
      ORDER BY memories.uri`,
    [workspaceId],
  );
  return rows.rows.map(mapMemoryControl);
}

async function refreshMemoryPolicy(db, workspaceId, options) {
  const manifest = options.manifest ?? readOpenVikingManifest(options.manifestPath);
  const workspace = manifest?.workspaces?.find((candidate) => candidate?.id === workspaceId);
  if (!workspace?.policyPath) return false;
  const controls = await loadWorkspaceMemoryControls(db, workspaceId);
  await writeJsonAtomic(workspace.policyPath, {
    version: 2,
    strict: true,
    workspaceId,
    memories: Object.fromEntries(controls.map((control) => [control.uri, {
      memoryType: control.memoryType,
      authority: control.authority,
      lifecycle: control.lifecycle,
      locked: control.locked,
      evidenceStatus: control.evidenceStatus,
      evidenceCount: control.evidenceCount,
      updatedAt: control.updatedAt,
      ...(control.title ? { title: control.title } : {}),
      ...(control.locked && control.lockedContent !== undefined
        ? { lockedContent: control.lockedContent }
        : {}),
    }])),
  });
  return true;
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function mapMemoryControl(row) {
  return {
    workspaceId: row.workspace_id,
    uri: row.uri,
    memoryType: row.memory_type,
    authority: row.authority,
    lifecycle: row.lifecycle,
    locked: row.locked === true,
    evidenceStatus: row.evidence_status,
    source: row.source,
    ...(row.title ? { title: row.title } : {}),
    ...(row.locked_content !== null && row.locked_content !== undefined
      ? { lockedContent: row.locked_content }
      : {}),
    evidenceCount: Number(row.evidence_count || 0),
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
  };
}

function defaultMemoryControl(workspaceId, uri) {
  return {
    workspaceId,
    uri,
    memoryType: memoryTypeFromUri(uri),
    authority: "model",
    lifecycle: "active",
    locked: false,
    evidenceStatus: "legacy",
    source: "legacy",
    evidenceCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function mapMemoryEvidence(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    memoryUri: row.memory_uri,
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    ...(row.source_agent ? { sourceAgent: row.source_agent } : {}),
    sourceTurnIds: jsonStringArray(row.source_turn_ids),
    ...(row.archive_uri ? { archiveUri: row.archive_uri } : {}),
    ...(row.memory_diff_uri ? { memoryDiffUri: row.memory_diff_uri } : {}),
    ...(row.remote_task_id ? { remoteTaskId: row.remote_task_id } : {}),
    ...(objectValue(row.model_snapshot) ? { modelSnapshot: objectValue(row.model_snapshot) } : {}),
    ...(objectValue(row.policy_snapshot) ? { policySnapshot: objectValue(row.policy_snapshot) } : {}),
    state: row.state,
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
  };
}

function mapMemoryFeedback(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    memoryUri: row.memory_uri,
    feedback: row.feedback,
    actor: row.actor,
    ...(row.note ? { note: row.note } : {}),
    createdAt: isoValue(row.created_at),
  };
}

function requireMemoryUri(value) {
  const uri = canonicalMemoryUri(value);
  if (!uri) {
    throw new Error("Memory URI must stay inside the OpenViking user memory scope.");
  }
  return uri;
}

function canonicalMemoryUri(value, userId) {
  const uri = String(value || "").trim();
  if (
    !uri.startsWith("viking://user/")
    || uri.includes("\0")
    || uri.includes("\\")
    || uri.includes("?")
    || uri.includes("#")
  ) return "";
  const segments = uri.slice("viking://user/".length).split("/");
  let memoryIndex = -1;
  if (segments[0] === "memories") {
    memoryIndex = 0;
  } else if (segments[0] && segments[1] === "memories" && (!userId || segments[0] === userId)) {
    memoryIndex = 1;
  }
  const memoryPath = segments.slice(memoryIndex + 1);
  if (
    memoryIndex < 0
    || memoryPath.length === 0
    || memoryPath.some((segment) => !segment || segment === "." || segment === "..")
  ) return "";
  return `viking://user/memories/${memoryPath.join("/")}`;
}

function memoryTypeFromUri(uri) {
  const segment = uri.replace(/^viking:\/\/user\/memories\//u, "").split("/")[0]?.replace(/\.md$/iu, "");
  if (segment === "identity" || segment === "soul") return "profile";
  return segment || "other";
}

function matchesTimeRange(value, range) {
  if (!range || typeof range !== "object") return true;
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return false;
  const after = range.after ? Date.parse(range.after) : Number.NEGATIVE_INFINITY;
  const before = range.before ? Date.parse(range.before) : Number.POSITIVE_INFINITY;
  return timestamp >= after && timestamp <= before;
}

function jsonStringArray(value) {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
}

function objectValue(value) {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function isoValue(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// The migration logic lives in src/core/mcp-migration.ts and is bundled (via
// scripts/build-mcp-bundle.mjs) so this standalone bin can call it without
// --experimental-strip-types. The bundle is resolved relative to this file.
let migrationBundle = null;

function validateMigrationBundle(bundle) {
  if (
    !Array.isArray(bundle?.MIGRATION_TARGET_IDS) ||
    bundle.MIGRATION_TARGET_IDS.length === 0 ||
    !bundle.MIGRATION_TARGET_IDS.every((value) => typeof value === "string")
  ) {
    throw new Error("migration bundle is missing MIGRATION_TARGET_IDS");
  }
  for (const name of ["isMigrationTarget", "openMcpSessionStore", "migrateSessionForMcp"]) {
    if (typeof bundle[name] !== "function") {
      throw new Error(`migration bundle is missing ${name}`);
    }
  }
}

async function loadMigrationBundle() {
  if (migrationBundle) return migrationBundle;
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out", "mcp", "migration-entry.js"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "migration-entry.js"),
  ];
  let lastError = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const candidateBundle = await import(pathToFileURL(candidate).href);
      validateMigrationBundle(candidateBundle);
      migrationBundle = candidateBundle;
      return migrationBundle;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "MCP migration bundle not found. Run `npm run build:mcp` first." +
    (lastError ? ` (${lastError instanceof Error ? lastError.message : String(lastError)})` : ""),
  );
}

// SDK-free wrapper. It opens a typed SessionStore over the same PostgreSQL
// endpoint and delegates to the bundled migration facade.
export async function migrateSession(connectionUrl, { sessionKey, target } = {}) {
  if (!sessionKey || typeof sessionKey !== "string") {
    return { ok: false, error: "sessionKey is required." };
  }
  const bundle = await loadMigrationBundle();
  if (!bundle.isMigrationTarget(target)) {
    return { ok: false, error: `target must be one of ${bundle.MIGRATION_TARGET_IDS.map((value) => `"${value}"`).join(", ")}.` };
  }
  if (!connectionUrl || typeof connectionUrl !== "string") {
    return { ok: false, error: "PostgreSQL connection URL is unavailable." };
  }
  const store = await bundle.openMcpSessionStore(connectionUrl);
  try {
    const result = await bundle.migrateSessionForMcp(
      { sessionKey, target },
      { store },
    );
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await store.close().catch(() => undefined);
  }
}

// This is the same schema used by runServer's migrate_session registration.
// Its values come from the bundled core registry, keeping the standalone MCP
// boundary in lock-step with the typed migration facade.
export async function migrationTargetSchema(zod) {
  const bundle = await loadMigrationBundle();
  return zod.enum(bundle.MIGRATION_TARGET_IDS);
}

function jsonContent(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function memoryTool(operation) {
  try {
    const result = await operation();
    return result?.ok === false ? errorContent(result.error) : jsonContent(result);
  } catch (error) {
    return errorContent(error instanceof Error ? error.message : String(error));
  }
}

async function runServer() {
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    process.stderr.write(
      "AgentRecall PostgreSQL endpoint not found. Open the app, or set AGENT_RECALL_DATABASE_URL.\n",
    );
    process.exit(1);
  }

  const { Pool } = await import("pg");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const db = new Pool({
    connectionString: databaseUrl,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: "agent-recall-mcp",
  });
  await db.query("SELECT 1");
  const server = new McpServer({ name: "agent-recall-v2", version: resolveAppVersion() });
  let migrateTargetSchema = null;
  try {
    migrateTargetSchema = await migrationTargetSchema(z);
  } catch (error) {
    process.stderr.write(
      `agent-recall MCP migration tools disabled: ${error instanceof Error ? error.message : String(error)}. ` +
        "Run `npm run build:mcp` in the AgentRecall install directory, then restart the MCP client.\n",
    );
  }

  server.registerTool(
    "search_sessions",
    {
      description:
        "Search past AI coding sessions (Claude Code, Codex, etc.) by keywords. Matches titles, first questions, transcripts, and AI summaries. Use this to recall how a problem was solved before.",
      inputSchema: {
        query: z.string().describe("Keywords to search for.").optional(),
        source: z.string().describe("Optional source filter, e.g. claude-cli or codex-cli.").optional(),
        project: z.string().describe("Optional substring match on the project path.").optional(),
        limit: z.number().describe("Max results (1-50, default 20).").optional(),
      },
    },
    async (args) => jsonContent(await searchSessions(db, args)),
  );

  server.registerTool(
    "get_session",
    {
      description:
        "Fetch a single session's metadata, AI summary, and messages by sessionKey. Returns messages from `offset` (default 0); for long sessions use the returned `nextOffset` as the next `offset` to page through the rest.",
      inputSchema: {
        sessionKey: z.string().describe("The sessionKey from search_sessions."),
        maxMessages: z.number().describe("Max messages to return (1-200, default 40).").optional(),
        offset: z.number().describe("Message index to start from (default 0). Use nextOffset from a previous call to continue.").optional(),
      },
    },
    async (args) => {
      const result = await getSession(db, args);
      return result ? jsonContent(result) : { content: [{ type: "text", text: "Session not found." }], isError: true };
    },
  );

  server.registerTool(
    "list_projects",
    { description: "List indexed projects with session counts, to scope a search.", inputSchema: {} },
    async () => jsonContent(await listProjects(db)),
  );

  server.registerTool(
    "list_tags",
    { description: "List all tags, to scope a search.", inputSchema: {} },
    async () => jsonContent(await listTags(db)),
  );

  server.registerTool(
    "get_latest_sessions",
    {
      description:
        "获取最近活跃的会话（按修改时间倒序）。Get the most recently active sessions by mtime. " +
        "用于找到「当前会话」「最近的 codex/claude 会话」等，不需要 sessionKey。" +
        "典型场景：用户说「把这次会话迁移到 claude」「迁移最近的 codex 会话」时，" +
        "先调本工具拿到 sessionKey，再调 migrate_session。" +
        "可选按 source（如 codex-cli、claude-cli）和 projectPath 过滤。",
      inputSchema: {
        source: z.string().describe("Optional source filter, e.g. codex-cli or claude-cli.").optional(),
        projectPath: z.string().describe("Optional project path substring to filter by.").optional(),
        limit: z.number().describe("Max results (1-20, default 5).").optional(),
      },
    },
    async (args) => jsonContent(await getLatestSessions(db, args)),
  );

  server.registerTool(
    "memory_search",
    {
      description:
        "Search active long-term memories from managed directories. Use session search for historical conversations; this tool searches only content already stored in OpenViking memory.",
      inputSchema: {
        query: z.string().min(1).describe("What to recall."),
        scope: z.string().describe("Optional workspace ID, exact directory path, display name, or 'all'.").optional(),
        types: z.array(z.string()).max(20).describe("Optional memory types such as preferences, decisions, events, cases, or experiences.").optional(),
        time_range: z.object({
          after: z.string().datetime().optional(),
          before: z.string().datetime().optional(),
        }).strict().optional(),
        limit: z.number().describe("Max results (1-50, default 20).").optional(),
      },
    },
    async (args) => memoryTool(() => memorySearch(db, args, {
      manifestPath: resolveOpenVikingManifestPath(),
    })),
  );

  server.registerTool(
    "memory_read",
    {
      description:
        "Read one OpenViking memory in full. A workspace ID is required because every managed directory has an isolated memory space.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace ID returned by memory_search."),
        uri: z.string().min(1).describe("Memory URI returned by memory_search."),
      },
    },
    async (args) => memoryTool(() => memoryRead(db, args, {
      manifestPath: resolveOpenVikingManifestPath(),
    })),
  );

  server.registerTool(
    "memory_evidence",
    {
      description:
        "Inspect a memory's authority, lifecycle, source Turn evidence, extraction task, and feedback history before relying on it.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace ID returned by memory_search."),
        uri: z.string().min(1).describe("Memory URI returned by memory_search."),
      },
    },
    async (args) => memoryTool(() => memoryEvidence(db, args)),
  );

  server.registerTool(
    "memory_feedback",
    {
      description:
        "Record whether a memory was helpful, wrong, or outdated. Wrong and outdated memories stop participating in automatic recall.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace ID returned by memory_search."),
        uri: z.string().min(1).describe("Memory URI returned by memory_search."),
        feedback: z.enum(["helpful", "wrong", "outdated"]),
        note: z.string().max(2_000).optional(),
      },
    },
    async (args) => memoryTool(() => memoryFeedback(db, args, {
      manifestPath: resolveOpenVikingManifestPath(),
    })),
  );

  server.registerTool(
    "tag_session",
    {
      description:
        "Add or remove a tag on a session. Use to mark sessions (e.g. 'important', 'review'). Idempotent. Returns the session's current tags.",
      inputSchema: {
        sessionKey: z.string().describe("The sessionKey from search_sessions."),
        action: z.enum(["add", "remove"]).describe("Whether to add or remove the tag."),
        tag: z.string().describe("Tag name, e.g. 'important'."),
      },
    },
    async (args) => {
      const result = await tagSession(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
  );

  server.registerTool(
    "toggle_favorite",
    {
      description: "Favorite or unfavorite a session. Idempotent — set favorited to the desired final state.",
      inputSchema: {
        sessionKey: z.string().describe("The sessionKey from search_sessions."),
        favorited: z.boolean().describe("true to favorite, false to unfavorite."),
      },
    },
    async (args) => {
      const result = await toggleFavorite(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
  );

  server.registerTool(
    "set_visibility",
    {
      description:
        "Set a session's visibility dimension. 'default' makes it visible, 'favorites' favorites it, and 'hidden' hides it.",
      inputSchema: {
        sessionKey: z.string().describe("The sessionKey from search_sessions."),
        visibility: z.enum(["default", "favorites", "hidden"]).describe("Target visibility."),
      },
    },
    async (args) => {
      const result = await setVisibility(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
  );

  if (migrateTargetSchema) {
    server.registerTool(
      "migrate_session",
    {
      description:
        "跨 Agent 迁移会话（Migrate session across agents）。把一个本地会话（Claude Code / Codex / CodeBuddy / CodeWiz）迁移到另一个目标 Agent，生成目标 Agent 能直接 resume 的会话文件。" +
        "典型场景：用户说「把这个会话迁移到 Claude/Codex/CodeBuddy」「把当前对话搬过去」「迁移会话」时调用此工具。" +
        "流程：先用 search_sessions 找到源会话的 sessionKey，再调用本工具传入 sessionKey 和 target。" +
        "迁移完成后返回 resumeCommand（如 cd /repo && claude --resume <id>），launched 恒为 false，需要用户自行在终端执行该命令。" +
        "两个可选目标 tclaude、tcodex 必须先在 Settings > Optional sources 中启用。" +
        "仅支持本地会话（environmentKind=local），远程会话不可迁移。",
      inputSchema: {
        sessionKey: z.string().describe("要迁移的源会话 sessionKey，可通过 search_sessions 获取。"),
        target: migrateTargetSchema.describe("目标 Agent：claude、codex、codebuddy、codewiz、cursor、tclaude 或 tcodex。两个可选目标需先在 Settings > Optional sources 启用。"),
      },
    },
    async (args) => {
      const result = await migrateSession(databaseUrl, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
    );
  }

  const close = async () => {
    await db.end().catch(() => undefined);
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runServer().catch((error) => {
    process.stderr.write(`agent-recall MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
