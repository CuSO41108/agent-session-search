import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_NOTES_DIRECTORY = ".release-notes";
export const RELEASE_NOTE_HEADINGS = {
  features: "新增功能",
  fixes: "Bug 修复",
};
export const RELEASE_TARGETS = ["v1", "v2", "both"];
export const RELEASE_PRODUCT_TITLES = {
  v1: "AgentRecall 1.0",
  v2: "agent-recall-v2",
};
export const SYNCHRONIZED_RELEASE_NOTE = "本次随统一版本同步发布，暂无单独的用户可见变化。";
const INTERNAL_RELEASE_INFRASTRUCTURE_FILES = new Set([
  "AGENTS.md",
  ".release-notes/README.md",
  "scripts/release-notes.mjs",
  "scripts/release-notes.test.mjs",
]);

const VAGUE_RELEASE_NOTE_PATTERNS = [
  /^优化代码[。.]?$/,
  /^修复一些问题[。.]?$/,
  /^新增若干功能[。.]?$/,
  /^代码重构[。.]?$/,
];

function releaseTargetMarkers(markdown) {
  return [...String(markdown).matchAll(/<!--\s*release-target:\s*([^\s]+)\s*-->/giu)];
}

export function parseReleaseNote(markdown, filePath = "release note") {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const titleLines = lines.filter((line) => /^#\s+\S/.test(line));
  const errors = [];
  if (titleLines.length !== 1) errors.push("must contain exactly one level-one title");

  const title = titleLines[0]?.replace(/^#\s+/, "").trim() ?? "";
  const targetMatches = releaseTargetMarkers(markdown);
  if (targetMatches.length > 1) errors.push("must contain at most one release target");
  const target = targetMatches[0]?.[1]?.toLowerCase() ?? "v1";
  if (!RELEASE_TARGETS.includes(target)) {
    errors.push(`contains invalid release target: ${JSON.stringify(target)}`);
  }
  const features = [];
  const fixes = [];
  let section = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1];
    if (heading) {
      section = heading === RELEASE_NOTE_HEADINGS.features ? "features" : heading === RELEASE_NOTE_HEADINGS.fixes ? "fixes" : null;
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.+?)\s*$/)?.[1];
    if (!bullet || !section) continue;
    if (VAGUE_RELEASE_NOTE_PATTERNS.some((pattern) => pattern.test(bullet))) {
      errors.push(`contains vague user-facing copy: ${JSON.stringify(bullet)}`);
      continue;
    }
    if (section === "features") features.push(bullet);
    else fixes.push(bullet);
  }

  if (features.length + fixes.length === 0) {
    errors.push(`must contain at least one bullet under "## ${RELEASE_NOTE_HEADINGS.features}" or "## ${RELEASE_NOTE_HEADINGS.fixes}"`);
  }
  if (errors.length > 0) throw new Error(`${filePath}: ${errors.join("; ")}`);
  return { title, target, features, fixes };
}

export function readReleaseNote(filePath) {
  return parseReleaseNote(readFileSync(filePath, "utf8"), filePath);
}

export function releaseBumpFor(note) {
  return note.features.length > 0 ? "minor" : "patch";
}

export function bumpVersion(currentVersion, note) {
  const match = String(currentVersion).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid stable semantic version: ${currentVersion}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return releaseBumpFor(note) === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export function renderReleaseNotes(note) {
  const sections = [`# ${note.title}`];
  if (note.features.length > 0) sections.push(`## ${RELEASE_NOTE_HEADINGS.features}\n\n${note.features.map((item) => `- ${item}`).join("\n")}`);
  if (note.fixes.length > 0) sections.push(`## ${RELEASE_NOTE_HEADINGS.fixes}\n\n${note.fixes.map((item) => `- ${item}`).join("\n")}`);
  return `${sections.join("\n\n")}\n`;
}

export function combineReleaseNotes(notes, options = {}) {
  const title = typeof options === "string" ? options : options.title ?? "AgentRecall 更新";
  const target = typeof options === "string" ? undefined : options.target;
  const selected = target
    ? notes.filter((note) => (note.target ?? "v1") === target || note.target === "both")
    : notes;
  return {
    title,
    features: [...new Set(selected.flatMap((note) => note.features))],
    fixes: [...new Set(selected.flatMap((note) => note.fixes))],
  };
}

export function combineReleaseNotesForTarget(notes, target, options = {}) {
  if (!["v1", "v2"].includes(target)) throw new Error(`Invalid release target: ${target}`);
  const combined = combineReleaseNotes(notes, {
    target,
    title: `${RELEASE_PRODUCT_TITLES[target]} 更新`,
  });
  if (options.includeEmpty === true && combined.features.length + combined.fixes.length === 0) {
    combined.fixes.push(SYNCHRONIZED_RELEASE_NOTE);
  }
  return combined;
}

function renderProductReleaseSection(title, note) {
  const sections = [`## ${title}`];
  if (note.features.length > 0) {
    sections.push(`### ${RELEASE_NOTE_HEADINGS.features}\n\n${note.features.map((item) => `- ${item}`).join("\n")}`);
  }
  if (note.fixes.length > 0) {
    sections.push(`### ${RELEASE_NOTE_HEADINGS.fixes}\n\n${note.fixes.map((item) => `- ${item}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

export function renderDualReleaseNotes(notes, title = "AgentRecall 更新") {
  const v1 = combineReleaseNotesForTarget(notes, "v1", { includeEmpty: true });
  const v2 = combineReleaseNotesForTarget(notes, "v2", { includeEmpty: true });
  return [
    `# ${title}`,
    renderProductReleaseSection(RELEASE_PRODUCT_TITLES.v1, v1),
    renderProductReleaseSection(RELEASE_PRODUCT_TITLES.v2, v2),
  ].join("\n\n") + "\n";
}

export function findAddedReleaseNoteFiles(baseRef = "origin/main", headRef = "HEAD", runGit = defaultRunGit) {
  const committedOutput = runGit([
    "diff",
    "--name-only",
    "--diff-filter=A",
    `${baseRef}...${headRef}`,
    "--",
    RELEASE_NOTES_DIRECTORY,
  ]);
  const stagedOutput = runGit([
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    "--diff-filter=A",
    "--",
    RELEASE_NOTES_DIRECTORY,
  ]);
  const untrackedOutput = runGit(["ls-files", "--others", "--exclude-standard", "--", RELEASE_NOTES_DIRECTORY]);
  return [...new Set(`${committedOutput}\n${stagedOutput}\n${untrackedOutput}`
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.endsWith(".md") && path.basename(file).toLowerCase() !== "readme.md"))];
}

export function findChangedFiles(baseRef = "origin/main", headRef = "HEAD", runGit = defaultRunGit) {
  const committedOutput = runGit(["diff", "--name-only", "--no-renames", `${baseRef}...${headRef}`, "--"]);
  const stagedOutput = runGit(["diff", "--cached", "--name-only", "--no-renames", "--"]);
  const unstagedOutput = runGit(["diff", "--name-only", "--no-renames", "--"]);
  const untrackedOutput = runGit(["ls-files", "--others", "--exclude-standard", "--"]);
  return [...new Set(`${committedOutput}\n${stagedOutput}\n${unstagedOutput}\n${untrackedOutput}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean))];
}

function releaseApplicationForChangedPath(file) {
  const normalized = file.replaceAll("\\", "/");
  const match = normalized.match(/^apps\/main-(1\.0|2\.0)\/(.+)$/u);
  if (!match) return null;
  const relativePath = match[2];
  if (/^(?:README|Install|LICENSE)(?:\.md)?$/iu.test(relativePath)
    || relativePath.startsWith("docs/")
    || /(?:^|\/)(?:__tests__|tests?|fixtures?|testing)(?:\/|$)/iu.test(relativePath)
    || /\.(?:test|spec)\.[^/]+$/iu.test(relativePath)
    || /^(?:vitest|jest)\.config\./iu.test(relativePath)) return null;
  return match[1] === "1.0" ? "v1" : "v2";
}

export function validateReleaseNoteRange(baseRef = "origin/main", headRef = "HEAD", runGit = defaultRunGit) {
  const files = findAddedReleaseNoteFiles(baseRef, headRef, runGit);
  const changedFiles = findChangedFiles(baseRef, headRef, runGit);
  if (files.length === 0) {
    if (changedFiles.length > 0 && changedFiles.every(isInternalReleaseInfrastructureFile)) {
      return { internalOnly: true, file: null, note: null };
    }
  }
  if (files.length !== 1) {
    throw new Error(`Expected exactly one added ${RELEASE_NOTES_DIRECTORY}/*.md file between ${baseRef} and ${headRef}; found ${files.length}.`);
  }
  const file = files[0];
  const markdown = readFileSync(file, "utf8");
  const note = parseReleaseNote(markdown, file);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const titleIndex = lines.findIndex((line) => /^#\s+\S/u.test(line));
  const firstLineAfterTitle = lines.slice(titleIndex + 1).find((line) => line.trim() !== "")?.trim() ?? "";
  if (!/^<!--\s*release-target:\s*(?:v1|v2|both)\s*-->$/iu.test(firstLineAfterTitle)) {
    throw new Error(`${file}: every new release note must explicitly declare <!-- release-target: v1|v2|both --> immediately after its title.`);
  }

  const changedApplications = new Set(changedFiles.map(releaseApplicationForChangedPath).filter(Boolean));
  const exclusiveApplication = changedApplications.size === 1 ? [...changedApplications][0] : null;
  if (exclusiveApplication && note.target !== exclusiveApplication && note.target !== "both") {
    throw new Error(
      `${file}: release target ${JSON.stringify(note.target)} does not cover changes under apps/main-${exclusiveApplication === "v1" ? "1.0" : "2.0"}; use <!-- release-target: ${exclusiveApplication} --> or <!-- release-target: both -->.`,
    );
  }
  return { internalOnly: false, file, note };
}

function isInternalReleaseInfrastructureFile(file) {
  return file.startsWith(".github/") || INTERNAL_RELEASE_INFRASTRUCTURE_FILES.has(file);
}

function defaultRunGit(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function printUsage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/release-notes.mjs check-file <file>\n" +
      "  node scripts/release-notes.mjs check-range [base-ref] [head-ref]\n" +
      "  node scripts/release-notes.mjs next-version <current-version> <file>\n" +
      "  node scripts/release-notes.mjs render <file>\n" +
      "  node scripts/release-notes.mjs target <file>\n" +
      "  node scripts/release-notes.mjs combine [--target v1|v2] [--include-empty] <file> [file...]\n" +
      "  node scripts/release-notes.mjs dual <file> [file...]\n",
  );
}

export function runCli(argv) {
  const [command, ...args] = argv;
  if (command === "check-file" && args[0]) {
    const note = readReleaseNote(args[0]);
    process.stdout.write(`${args[0]}: ${note.features.length} feature(s), ${note.fixes.length} fix(es)\n`);
    return;
  }
  if (command === "check-range") {
    const result = validateReleaseNoteRange(args[0] || "origin/main", args[1] || "HEAD");
    if (result.internalOnly) {
      process.stdout.write("No product release note required for an internal release-infrastructure change.\n");
    } else {
      process.stdout.write(`${result.file}: ${result.note.features.length} feature(s), ${result.note.fixes.length} fix(es)\n`);
    }
    return;
  }
  if (command === "next-version" && args[0] && args[1]) {
    process.stdout.write(`${bumpVersion(args[0], readReleaseNote(args[1]))}\n`);
    return;
  }
  if (command === "render" && args[0]) {
    process.stdout.write(renderReleaseNotes(readReleaseNote(args[0])));
    return;
  }
  if (command === "target" && args[0]) {
    process.stdout.write(`${readReleaseNote(args[0]).target}\n`);
    return;
  }
  if (command === "combine" && args.length > 0) {
    const targetIndex = args.indexOf("--target");
    const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
    const includeEmpty = args.includes("--include-empty");
    if (targetIndex >= 0 && (!target || !["v1", "v2"].includes(target))) {
      throw new Error("combine --target must be v1 or v2");
    }
    const files = args.filter((item, index) =>
      index !== targetIndex && index !== targetIndex + 1 && item !== "--include-empty");
    if (files.length === 0) throw new Error("combine requires at least one release-note file");
    const notes = files.map(readReleaseNote);
    const combined = target
      ? combineReleaseNotesForTarget(notes, target, { includeEmpty })
      : combineReleaseNotes(notes);
    process.stdout.write(renderReleaseNotes(combined));
    return;
  }
  if (command === "dual" && args.length > 0) {
    process.stdout.write(renderDualReleaseNotes(args.map(readReleaseNote)));
    return;
  }
  printUsage();
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
