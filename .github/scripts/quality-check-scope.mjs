#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const APPLICATIONS = [
  { app: "v1", label: "V1", directory: "apps/main-1.0" },
  { app: "v2", label: "V2", directory: "apps/main-2.0" },
];
const OPERATING_SYSTEMS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const ROOT_DOCUMENTATION = new Set([
  ".gitignore",
  ".npmignore",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "Install.md",
  "LICENSE",
  "README.md",
]);
const REPOSITORY_ONLY_GITHUB_PATHS = new Set([
  ".github/openviking-runtime-inputs.json",
  ".github/pull_request_template.md",
  ".github/scripts/probe-openviking-runtime-release.mjs",
  ".github/scripts/probe-v2-stable-release.mjs",
  ".github/workflows/contributors.yml",
  ".github/workflows/release.yml",
  ".github/workflows/update-star-history.yml",
]);
const REPOSITORY_ONLY_ROOT_ASSETS = new Set([
  "assets/app-icon.png",
  "assets/logo.png",
  "assets/show.png",
  "assets/star-history-data.json",
  "assets/star-history.svg",
  "assets/tray-icon-template.svg",
  "assets/tray-iconTemplate.png",
  "assets/tray-iconTemplate@2x.png",
]);
const REPOSITORY_ONLY_SCRIPTS = new Set([
  "scripts/generate-star-history.mjs",
  "scripts/generate-star-history.test.mjs",
  "scripts/install-docs.test.mjs",
  "scripts/monorepo-layout.test.mjs",
  "scripts/release-notes.mjs",
  "scripts/release-notes.test.mjs",
  "scripts/session-toolbar-layout.test.mjs",
]);
const FULL_CHECK_PATHS = new Set([
  ".github/scripts/quality-check-scope.mjs",
  ".github/workflows/quality-check.yml",
  "package-lock.json",
  "package.json",
  "scripts/run-package-smokes.mjs",
  "scripts/setup-app.mjs",
]);

function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isApplicationDocumentation(relativePath) {
  return relativePath === "README.md"
    || relativePath === "Install.md"
    || relativePath === "LICENSE"
    || relativePath.startsWith("docs/");
}

function applicationForPath(file) {
  for (const application of APPLICATIONS) {
    const prefix = `${application.directory}/`;
    if (!file.startsWith(prefix)) continue;
    const relativePath = file.slice(prefix.length);
    return isApplicationDocumentation(relativePath) ? null : application.app;
  }
  return undefined;
}

function isRepositoryOnlyPath(file) {
  return ROOT_DOCUMENTATION.has(file)
    || REPOSITORY_ONLY_GITHUB_PATHS.has(file)
    || REPOSITORY_ONLY_ROOT_ASSETS.has(file)
    || REPOSITORY_ONLY_SCRIPTS.has(file)
    || file.startsWith(".release-notes/")
    || file.startsWith("docs/");
}

function createPlan(paths) {
  const selected = new Set();
  for (const rawPath of paths) {
    const file = normalizePath(rawPath);
    if (!file) continue;

    if (FULL_CHECK_PATHS.has(file)) {
      selected.add("v1");
      selected.add("v2");
      continue;
    }

    const application = applicationForPath(file);
    if (application) {
      selected.add(application);
      continue;
    }
    if (application === null || isRepositoryOnlyPath(file)) continue;

    // Unknown shared paths fail closed so new build inputs cannot silently skip checks.
    selected.add("v1");
    selected.add("v2");
  }

  const applications = APPLICATIONS.filter(({ app }) => selected.has(app));
  const include = applications.length > 0
    ? applications.flatMap((application) => OPERATING_SYSTEMS.map((os) => ({ ...application, os })))
    : [{ app: "repository", label: "Repository", directory: "", os: "ubuntu-latest" }];
  return {
    v1: selected.has("v1"),
    v2: selected.has("v2"),
    matrix: { include },
  };
}

function parseArguments(args) {
  if (args[0] === "--paths") return { paths: args.slice(1) };
  if (args.length === 4 && args[0] === "--base" && args[2] === "--head") {
    const base = args[1];
    const head = args[3];
    if (!/^[0-9a-f]{40}$/iu.test(base) || !/^[0-9a-f]{40}$/iu.test(head)) {
      throw new Error("--base and --head must be full Git commit SHAs.");
    }
    const output = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return { paths: output.split("\0").filter(Boolean) };
  }
  throw new Error("Usage: quality-check-scope.mjs --base <sha> --head <sha> | --paths [file ...]");
}

try {
  const { paths } = parseArguments(process.argv.slice(2));
  const plan = createPlan(paths);
  process.stdout.write(`v1=${plan.v1}\n`);
  process.stdout.write(`v2=${plan.v2}\n`);
  process.stdout.write(`matrix=${JSON.stringify(plan.matrix)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
