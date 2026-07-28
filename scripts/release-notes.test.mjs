import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  bumpVersion,
  combineReleaseNotes,
  combineReleaseNotesForTarget,
  findAddedReleaseNoteFiles,
  parseReleaseNote,
  releaseBumpFor,
  renderDualReleaseNotes,
  renderReleaseNotes,
} from "./release-notes.mjs";

test("parses feature and bug-fix sections as user-facing release copy", () => {
  const note = parseReleaseNote(`# 自动更新\n\n## 新增功能\n\n- 终端显示新版本。\n\n## Bug 修复\n\n- 修复重启失败。\n`);
  assert.deepEqual(note, {
    title: "自动更新",
    target: "v1",
    features: ["终端显示新版本。"],
    fixes: ["修复重启失败。"],
  });
  assert.match(renderReleaseNotes(note), /## 新增功能[\s\S]*## Bug 修复/);
});

test("rejects missing and vague release notes", () => {
  assert.throws(() => parseReleaseNote("# Empty\n"), /at least one bullet/);
  assert.throws(() => parseReleaseNote("# Vague\n\n## Bug 修复\n\n- 修复一些问题\n"), /vague/);
  assert.throws(
    () => parseReleaseNote("# Invalid\n\n<!-- release-target: future -->\n\n## Bug 修复\n\n- Clear fix.\n"),
    /invalid release target/,
  );
});

test("routes V1 and V2 notes without publishing V2 notes in V1 releases", () => {
  const v1 = parseReleaseNote("# Stable\n\n## Bug 修复\n\n- Stable fix.\n");
  const v2 = parseReleaseNote("# Preview\n\n<!-- release-target: v2 -->\n\n## Bug 修复\n\n- Preview fix.\n");
  const both = parseReleaseNote("# Shared\n\n<!-- release-target: both -->\n\n## Bug 修复\n\n- Shared fix.\n");
  assert.equal(v1.target, "v1");
  assert.equal(v2.target, "v2");
  assert.equal(both.target, "both");
  assert.deepEqual(
    combineReleaseNotes([v1, v2, both], { target: "v1" }).fixes,
    ["Stable fix.", "Shared fix."],
  );
  assert.doesNotMatch(renderReleaseNotes(v2), /release-target/);
});

test("renders separate V1 and V2 sections from the same pending notes", () => {
  const v1 = parseReleaseNote("# Stable\n\n## 新增功能\n\n- Stable feature.\n");
  const v2 = parseReleaseNote("# Preview\n\n<!-- release-target: v2 -->\n\n## Bug 修复\n\n- Preview fix.\n");
  const both = parseReleaseNote("# Shared\n\n<!-- release-target: both -->\n\n## Bug 修复\n\n- Shared fix.\n");

  const rendered = renderDualReleaseNotes([v1, v2, both]);

  assert.match(rendered, /^# AgentRecall 更新/m);
  assert.match(rendered, /## AgentRecall 1\.0[\s\S]*### 新增功能[\s\S]*- Stable feature\.[\s\S]*### Bug 修复[\s\S]*- Shared fix\./);
  assert.match(rendered, /## agent-recall-v2[\s\S]*### Bug 修复[\s\S]*- Preview fix\.[\s\S]*- Shared fix\./);
  assert.doesNotMatch(rendered, /Preview fix\.[\s\S]*## agent-recall-v2/);
});

test("uses an explicit synchronization note when one release target has no changes", () => {
  const v1 = parseReleaseNote("# Stable\n\n## Bug 修复\n\n- Stable fix.\n");

  assert.deepEqual(combineReleaseNotesForTarget([v1], "v2", { includeEmpty: true }), {
    title: "agent-recall-v2 更新",
    features: [],
    fixes: ["本次随统一版本同步发布，暂无单独的用户可见变化。"],
  });
});

test("repository guidance treats release notes as sanitized product copy", async () => {
  const instructions = await readFile("AGENTS.md", "utf8");
  const templateGuidance = await readFile(".release-notes/README.md", "utf8");
  assert.match(instructions, /product copy for end users, not engineering change logs/);
  assert.match(instructions, /Remove internal-only changes entirely/);
  assert.match(instructions, /omit identifiers, hosts, paths, table names, credentials/);
  assert.match(templateGuidance, /Write this as product copy for users, not as an engineering log/);
});

test("bumps minor for features and patch for fix-only releases", () => {
  const feature = { title: "Feature", features: ["New behavior"], fixes: [] };
  const fix = { title: "Fix", features: [], fixes: ["Fixed behavior"] };
  assert.equal(releaseBumpFor(feature), "minor");
  assert.equal(bumpVersion("v0.1.9", feature), "0.2.0");
  assert.equal(bumpVersion("0.2.0", fix), "0.2.1");
});

test("combines pending release notes and deduplicates exact bullets", () => {
  const combined = combineReleaseNotes([
    { title: "First", features: ["New search"], fixes: ["Fixed update"] },
    { title: "Second", features: ["New search", "New sync"], fixes: ["Fixed layout"] },
  ]);
  assert.deepEqual(combined, {
    title: "AgentRecall 更新",
    features: ["New search", "New sync"],
    fixes: ["Fixed update", "Fixed layout"],
  });
  assert.equal(releaseBumpFor(combined), "minor");
});

test("finds only newly added non-template release notes", () => {
  const files = findAddedReleaseNoteFiles("origin/main", "HEAD", (args) =>
    args[0] === "diff" ? ".release-notes/README.md\n.release-notes/auto-update.md\n" : ".release-notes/auto-update.md\n",
  );
  assert.deepEqual(files, [".release-notes/auto-update.md"]);
});

test("workflows require branch notes and publish accumulated changes every day or on demand", async () => {
  const noteWorkflow = await readFile(".github/workflows/release-note-check.yml", "utf8");
  const qualityWorkflow = await readFile(".github/workflows/quality-check.yml", "utf8");
  const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(noteWorkflow, /pull_request:/);
  assert.match(noteWorkflow, /release-notes\.mjs check-range/);
  assert.match(qualityWorkflow, /os:\s*\[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(qualityWorkflow, /npm run setup/);
  assert.match(qualityWorkflow, /- name: Test\s+if: runner\.os != 'Windows'\s+run: npm test/);
  assert.match(qualityWorkflow, /- name: Test update and install scripts \(Windows\)\s+if: runner\.os == 'Windows'\s+run: npm run test:scripts/);
  assert.match(qualityWorkflow, /- name: Typecheck\s+run: npm run typecheck/);
  assert.match(qualityWorkflow, /- name: Build\s+run: npm run build/);
  assert.match(qualityWorkflow, /run: npm run package:smoke\s/);
  assert.match(qualityWorkflow, /run: npm run package:smoke:v2/);
  assert.match(releaseWorkflow, /schedule:[\s\S]*cron:\s*["']0 2 \* \* \*["']/);
  assert.match(releaseWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(releaseWorkflow, /^\s{2}push:/m);
  assert.match(releaseWorkflow, /git describe --tags --abbrev=0 --match 'v\[0-9\]\*'/);
  assert.match(releaseWorkflow, /git diff --name-only --diff-filter=A "\$latest_tag" "\$RELEASE_SHA"/);
  assert.match(releaseWorkflow, /No unreleased user-facing changes; skipping application release/);
  assert.match(releaseWorkflow, /release-notes\.mjs target/);
  assert.match(releaseWorkflow, /release-notes\.mjs combine --target v1/);
  assert.match(releaseWorkflow, /cancel-in-progress:\s*false/);
  assert.match(releaseWorkflow, /working-directory: apps\/main-1\.0/);
  assert.match(releaseWorkflow, /npm test[\s\S]*npm run typecheck[\s\S]*npm run build/);
  assert.doesNotMatch(releaseWorkflow, /apps\/main-2\.0/);
  assert.match(releaseWorkflow, /gh release upload/);
  assert.match(releaseWorkflow, /gh release view "\$TAG" --json isDraft --jq '\.isDraft'/);
  assert.match(releaseWorkflow, /already exists and is published; refusing to overwrite it/);
  assert.match(releaseWorkflow, /node scripts\/compute-release-version\.mjs/);
  assert.match(releaseWorkflow, /node apps\/main-1\.0\/scripts\/create-release-assets\.mjs/);
  const releaseRequiredGuards = releaseWorkflow.match(
    /if: steps\.pending\.outputs\.publish == 'true' && steps\.version\.outputs\.release_required == 'true'/g,
  );
  assert.equal(releaseRequiredGuards?.length, 4, "all post-version release work must skip an already published commit");
  assert.match(releaseWorkflow, /gh release edit "\$TAG" --draft=false/);
  const tagIdentityName = releaseWorkflow.indexOf('git config user.name "github-actions[bot]"');
  const tagIdentityEmail = releaseWorkflow.indexOf('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  const annotatedTag = releaseWorkflow.indexOf('git tag -a "$TAG"');
  assert.ok(tagIdentityName >= 0, "release workflow must configure the tag creator name");
  assert.ok(tagIdentityEmail > tagIdentityName, "release workflow must configure the tag creator email after its name");
  assert.ok(annotatedTag > tagIdentityEmail, "release workflow must configure an identity before creating an annotated tag");
});
