#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const V2_STABLE_ASSET_NAMES = [
  "agent-recall-v2.tgz",
  "agent-recall-v2.tgz.sha256",
  "update-v2.json",
];

const VERSIONED_V2_TAG = /^v2-(\d+\.\d+\.\d+)$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/iu;
const ASSET_DIGEST = /^sha256:[a-f0-9]{64}$/u;

/**
 * Returns true when the rolling v2-latest release must be repaired.
 *
 * The versioned source is authoritative, so malformed source metadata is a
 * hard error. The rolling release is recoverable state: anything missing or
 * inconsistent there simply requests a repair.
 */
export function probeV2StableRelease({
  sourceRelease,
  stableRelease,
  sourceCommitSha,
  stableCommitSha,
}) {
  const source = validateSourceRelease(sourceRelease, sourceCommitSha);
  if (!isPublishedStableRelease(stableRelease)) return true;
  if (!isCommitSha(stableCommitSha)) return true;
  if (stableCommitSha.toLowerCase() !== source.commitSha) return true;

  const stableAssets = collectStableAssets(stableRelease.assets);
  if (!stableAssets) return true;
  return V2_STABLE_ASSET_NAMES.some((name) => {
    const expected = source.assets.get(name);
    const actual = stableAssets.get(name);
    return actual.size !== expected.size || actual.digest !== expected.digest;
  });
}

function validateSourceRelease(release, commitSha) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("Latest published V2 source release metadata is invalid.");
  }
  if (!VERSIONED_V2_TAG.test(String(release.tag_name ?? ""))) {
    throw new Error("Latest published V2 source must use a versioned v2-x.y.z tag.");
  }
  if (
    release.draft !== false
    || release.prerelease !== false
    || typeof release.published_at !== "string"
    || !Number.isFinite(Date.parse(release.published_at))
  ) {
    throw new Error("Latest V2 source release is not a published stable release.");
  }
  if (!isCommitSha(commitSha)) {
    throw new Error("Latest V2 source tag commit SHA is invalid.");
  }
  if (!Array.isArray(release.assets)) {
    throw new Error("Latest V2 source release assets are missing.");
  }

  const assets = new Map();
  for (const name of V2_STABLE_ASSET_NAMES) {
    const matches = release.assets.filter((asset) => asset?.name === name);
    if (matches.length !== 1 || !isTrustedAsset(matches[0])) {
      throw new Error(`Latest V2 source release has an invalid ${name} asset.`);
    }
    assets.set(name, { size: matches[0].size, digest: matches[0].digest });
  }
  return { assets, commitSha: commitSha.toLowerCase() };
}

function isPublishedStableRelease(release) {
  return Boolean(
    release
    && typeof release === "object"
    && !Array.isArray(release)
    && release.tag_name === "v2-latest"
    && release.draft === false
    && release.prerelease === false
    && typeof release.published_at === "string"
    && Number.isFinite(Date.parse(release.published_at))
    && Array.isArray(release.assets),
  );
}

function collectStableAssets(assets) {
  const result = new Map();
  for (const name of V2_STABLE_ASSET_NAMES) {
    const matches = assets.filter((asset) => asset?.name === name);
    if (matches.length !== 1 || !isTrustedAsset(matches[0])) return null;
    result.set(name, { size: matches[0].size, digest: matches[0].digest });
  }
  return result;
}

function isTrustedAsset(asset) {
  return Boolean(
    asset
    && typeof asset === "object"
    && !Array.isArray(asset)
    && asset.state === "uploaded"
    && Number.isSafeInteger(asset.size)
    && asset.size > 0
    && typeof asset.digest === "string"
    && ASSET_DIGEST.test(asset.digest),
  );
}

function isCommitSha(value) {
  return typeof value === "string" && COMMIT_SHA.test(value);
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  return [
    "Usage:",
    "  node .github/scripts/probe-v2-stable-release.mjs \\",
    "    --source-release-json <path> \\",
    "    --source-commit-sha <sha> \\",
    "    [--stable-release-json <path>] \\",
    "    [--stable-commit-sha <sha>]",
    "",
    "Prints true when v2-latest needs repair, otherwise false.",
  ].join("\n");
}

async function readJson(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(path.resolve(filePath), "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

export async function runCli(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const sourceReleasePath = argumentValue(args, "--source-release-json");
  const sourceCommitSha = argumentValue(args, "--source-commit-sha");
  const stableReleasePath = argumentValue(args, "--stable-release-json");
  const stableCommitSha = argumentValue(args, "--stable-commit-sha");
  if (!sourceReleasePath || !sourceCommitSha) {
    throw new Error(usage());
  }

  const sourceRelease = await readJson(sourceReleasePath, "V2 source release JSON");
  const stableRelease = stableReleasePath
    ? await readJson(stableReleasePath, "v2-latest release JSON")
    : null;
  const repair = probeV2StableRelease({
    sourceRelease,
    stableRelease,
    sourceCommitSha,
    stableCommitSha,
  });
  process.stdout.write(`${repair}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
