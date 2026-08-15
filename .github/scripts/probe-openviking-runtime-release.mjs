#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SMALL_ASSET_BYTES = 64 * 1024;
const REQUIRED_FINGERPRINT_FILES = [
  "apps/main-2.0/package.json",
  "apps/main-2.0/package-lock.json",
  "apps/main-2.0/scripts/build-openviking-runtime.mjs",
];

export const OPENVIKING_RUNTIME_TARGETS = [
  { platform: "darwin", arch: "arm64", executablePath: "bin/openviking-server" },
  { platform: "darwin", arch: "x64", executablePath: "bin/openviking-server" },
  { platform: "win32", arch: "x64", executablePath: "Scripts/openviking-server.exe" },
];

export function runtimeReleaseAssetNames(version) {
  assertToken(version, "version");
  return OPENVIKING_RUNTIME_TARGETS.flatMap(({ platform, arch }) => {
    const archive = `openviking-runtime-${version}-${platform}-${arch}.tar.gz`;
    return [archive, `${archive}.json`];
  });
}

export function runtimeInputsSidecarName(version) {
  assertToken(version, "version");
  return `openviking-runtime-${version}-inputs.json`;
}

export async function loadOpenVikingRuntimeInputs({ configPath, rootDirectory = process.cwd() }) {
  const root = path.resolve(rootDirectory);
  const resolvedConfig = path.resolve(configPath);
  assertPathInside(root, resolvedConfig, "runtime input config");
  const configBytes = await readFile(resolvedConfig);
  const config = JSON.parse(configBytes.toString("utf8"));
  validateRuntimeInputConfig(config);

  const fingerprintFiles = [...config.fingerprintFiles].sort();
  const inputs = [{ name: slashPath(path.relative(root, resolvedConfig)), bytes: configBytes }];
  for (const name of fingerprintFiles) {
    const resolved = path.resolve(root, name);
    assertPathInside(root, resolved, `fingerprint input ${name}`);
    inputs.push({ name, bytes: normalizeRuntimeFingerprintInput(name, await readFile(resolved)) });
  }

  const hash = createHash("sha256");
  hash.update("agent-recall-openviking-runtime-inputs-v1\0");
  for (const input of inputs) {
    hash.update(`${input.name}\0${input.bytes.byteLength}\0`);
    hash.update(input.bytes);
    hash.update("\0");
  }
  const inputFingerprint = `sha256:${hash.digest("hex")}`;
  return {
    config,
    inputFingerprint,
    matrix: { include: config.targets },
    sidecarName: runtimeInputsSidecarName(config.runtimeVersion),
  };
}

function normalizeRuntimeFingerprintInput(name, bytes) {
  if (name !== "apps/main-2.0/package.json" && name !== "apps/main-2.0/package-lock.json") {
    return bytes;
  }

  const parsed = JSON.parse(bytes.toString("utf8"));
  parsed.version = "<release-version>";
  if (name.endsWith("package-lock.json") && parsed.packages?.[""]) {
    parsed.packages[""].version = "<release-version>";
  }
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
}

export function createRuntimeInputsSidecar({ runtimeVersion, inputFingerprint, runtimeAssets }) {
  assertToken(runtimeVersion, "version");
  assertFingerprint(inputFingerprint);
  validateRuntimeAssetRecords(runtimeAssets, runtimeVersion);
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    runtimeVersion,
    inputFingerprint,
    runtimeAssets,
  }, null, 2)}\n`);
}

export async function describeLocalRuntimeAssets(directory, runtimeVersion) {
  const records = [];
  for (const name of runtimeReleaseAssetNames(runtimeVersion)) {
    const filePath = path.join(directory, name);
    const metadata = await stat(filePath);
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size <= 0) {
      throw new Error(`OpenViking runtime asset ${name} is invalid.`);
    }
    records.push({ name, size: metadata.size, sha256: await sha256File(filePath) });
  }
  return records;
}

export async function verifyLocalRuntimeAssets({ directory, runtimeVersion, inputFingerprint }) {
  const sidecarName = runtimeInputsSidecarName(runtimeVersion);
  const sidecar = parseRuntimeInputsSidecar(
    await readFile(path.join(directory, sidecarName)),
    { runtimeVersion, inputFingerprint },
  );
  for (const record of sidecar.runtimeAssets) {
    const filePath = path.join(directory, record.name);
    const metadata = await stat(filePath);
    if (
      !metadata.isFile()
      || metadata.size !== record.size
      || await sha256File(filePath) !== record.sha256
    ) {
      throw new Error(`OpenViking runtime asset ${record.name} does not match its input sidecar.`);
    }
  }
  for (const target of OPENVIKING_RUNTIME_TARGETS) {
    const archiveName = `openviking-runtime-${runtimeVersion}-${target.platform}-${target.arch}.tar.gz`;
    const manifestName = `${archiveName}.json`;
    const archiveRecord = sidecar.runtimeAssets.find(({ name }) => name === archiveName);
    const manifest = JSON.parse(await readFile(path.join(directory, manifestName), "utf8"));
    if (!validRuntimeManifest(manifest, { runtimeVersion, target, archiveName, archiveSha256: archiveRecord.sha256 })) {
      throw new Error(`OpenViking runtime manifest ${manifestName} does not match its archive.`);
    }
  }
  return sidecar;
}

function validateRuntimeAssetRecords(records, runtimeVersion) {
  const expectedNames = runtimeReleaseAssetNames(runtimeVersion);
  if (!Array.isArray(records) || records.length !== expectedNames.length) {
    throw new Error("OpenViking runtime input sidecar has an invalid asset set.");
  }
  for (let index = 0; index < expectedNames.length; index += 1) {
    const record = records[index];
    if (
      !record
      || typeof record !== "object"
      || Array.isArray(record)
      || Object.keys(record).sort().join(",") !== "name,sha256,size"
      || record.name !== expectedNames[index]
      || !Number.isSafeInteger(record.size)
      || record.size <= 0
      || typeof record.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(record.sha256)
    ) {
      throw new Error(`OpenViking runtime input sidecar has an invalid asset record at index ${index}.`);
    }
  }
}

function parseRuntimeInputsSidecar(bytes, { runtimeVersion, inputFingerprint }) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength <= 0 || bytes.byteLength > MAX_SMALL_ASSET_BYTES) {
    throw new Error("OpenViking runtime input sidecar is invalid.");
  }
  let sidecar;
  try {
    sidecar = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("OpenViking runtime input sidecar is not valid JSON.");
  }
  if (
    !sidecar
    || typeof sidecar !== "object"
    || Array.isArray(sidecar)
    || Object.keys(sidecar).sort().join(",") !== "inputFingerprint,runtimeAssets,runtimeVersion,schemaVersion"
    || sidecar.schemaVersion !== 1
    || sidecar.runtimeVersion !== runtimeVersion
  ) {
    throw new Error("OpenViking runtime input sidecar metadata is invalid.");
  }
  assertFingerprint(sidecar.inputFingerprint);
  if (sidecar.inputFingerprint !== inputFingerprint) {
    const error = new Error("OpenViking runtime input fingerprint changed without a runtime revision bump.");
    error.code = "FINGERPRINT_MISMATCH";
    throw error;
  }
  validateRuntimeAssetRecords(sidecar.runtimeAssets, runtimeVersion);
  return sidecar;
}

function validRuntimeManifest(manifest, {
  runtimeVersion,
  target,
  archiveName,
  archiveSha256,
}) {
  return manifest
    && typeof manifest === "object"
    && !Array.isArray(manifest)
    && manifest.version === runtimeVersion
    && manifest.platform === target.platform
    && manifest.arch === target.arch
    && manifest.sha256 === archiveSha256
    && manifest.archiveType === "tar.gz"
    && manifest.executablePath === target.executablePath
    && manifest.file === archiveName;
}

export function probeOpenVikingRuntimeRelease({
  release,
  expectedTag,
  runtimeVersion,
  inputFingerprint,
  smallAssets,
}) {
  assertToken(runtimeVersion, "version");
  assertFingerprint(inputFingerprint);
  if (!/^v2-[0-9]+\.[0-9]+\.[0-9]+$/u.test(String(expectedTag ?? ""))) {
    return miss("source tag is not a versioned V2 release tag");
  }
  if (
    !release
    || typeof release !== "object"
    || release.tag_name !== expectedTag
    || release.draft !== false
    || release.prerelease !== false
    || typeof release.published_at !== "string"
    || !Number.isFinite(Date.parse(release.published_at))
  ) {
    return miss("release metadata does not identify the expected published V2 release");
  }
  if (!Array.isArray(release.assets)) return miss("release assets are missing");

  const expectedRuntimeAssets = runtimeReleaseAssetNames(runtimeVersion);
  const sidecarName = runtimeInputsSidecarName(runtimeVersion);
  const expectedCurrentAssets = new Set([...expectedRuntimeAssets, sidecarName]);
  const currentRuntimePrefix = `openviking-runtime-${runtimeVersion}-`;
  const assets = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset !== "object" || typeof asset.name !== "string") continue;
    if (assets.has(asset.name)) return miss(`release contains duplicate asset ${asset.name}`);
    if (asset.name.startsWith(currentRuntimePrefix) && !expectedCurrentAssets.has(asset.name)) {
      return miss(`release contains unexpected current runtime asset ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }

  const sidecarAsset = assets.get(sidecarName);
  if (!sidecarAsset) {
    return miss("published release predates runtime input sidecars", { legacyBootstrap: true });
  }
  const sidecarDigest = validAssetDigest(sidecarAsset, { maxSize: MAX_SMALL_ASSET_BYTES });
  const sidecarBytes = smallAssets?.get(sidecarName);
  if (!sidecarDigest || !Buffer.isBuffer(sidecarBytes)) return miss("trusted runtime input sidecar is invalid");
  if (sidecarBytes.byteLength !== sidecarAsset.size) return miss("runtime input sidecar size does not match GitHub");
  if (sha256(sidecarBytes) !== sidecarDigest) return miss("runtime input sidecar digest does not match GitHub");

  let sidecar;
  try {
    sidecar = parseRuntimeInputsSidecar(sidecarBytes, { runtimeVersion, inputFingerprint });
  } catch (error) {
    return miss(
      error?.code === "FINGERPRINT_MISMATCH"
        ? "runtime input fingerprint changed without a runtime revision bump"
        : "runtime input sidecar does not match the current build inputs",
      { hardFailure: error?.code === "FINGERPRINT_MISMATCH" },
    );
  }
  const records = new Map(sidecar.runtimeAssets.map((record) => [record.name, record]));

  for (const target of OPENVIKING_RUNTIME_TARGETS) {
    const archiveName = `openviking-runtime-${runtimeVersion}-${target.platform}-${target.arch}.tar.gz`;
    const manifestName = `${archiveName}.json`;
    const archiveAsset = assets.get(archiveName);
    const manifestAsset = assets.get(manifestName);
    const archiveDigest = validAssetDigest(archiveAsset, { maxSize: Number.MAX_SAFE_INTEGER });
    const manifestDigest = validAssetDigest(manifestAsset, { maxSize: MAX_SMALL_ASSET_BYTES });
    if (!archiveDigest || !manifestDigest) {
      return miss(`release is missing trusted metadata for ${target.platform}-${target.arch}`);
    }
    const archiveRecord = records.get(archiveName);
    const manifestRecord = records.get(manifestName);
    if (
      archiveRecord.size !== archiveAsset.size
      || archiveRecord.sha256 !== archiveDigest
      || manifestRecord.size !== manifestAsset.size
      || manifestRecord.sha256 !== manifestDigest
    ) {
      return miss(`runtime input sidecar does not match GitHub metadata for ${target.platform}-${target.arch}`);
    }

    const bytes = smallAssets?.get(manifestName);
    if (!Buffer.isBuffer(bytes)) return miss(`downloaded manifest ${manifestName} is missing`);
    if (bytes.byteLength !== manifestAsset.size) return miss(`manifest ${manifestName} size does not match GitHub`);
    if (sha256(bytes) !== manifestDigest) return miss(`manifest ${manifestName} digest does not match GitHub`);

    let manifest;
    try {
      manifest = JSON.parse(bytes.toString("utf8"));
    } catch {
      return miss(`manifest ${manifestName} is not valid JSON`);
    }
    if (!validRuntimeManifest(manifest, {
      runtimeVersion,
      target,
      archiveName,
      archiveSha256: archiveDigest,
    })) {
      return miss(`manifest ${manifestName} does not match its GitHub archive asset`);
    }
  }

  return { reusable: true, runtimeSourceTag: expectedTag };
}

async function probeFromFiles({ releaseJson, smallAssetDirectory, expectedTag, inputs }) {
  const release = JSON.parse(await readFile(releaseJson, "utf8"));
  const smallAssets = new Map();
  const names = [
    runtimeInputsSidecarName(inputs.config.runtimeVersion),
    ...runtimeReleaseAssetNames(inputs.config.runtimeVersion).filter((name) => name.endsWith(".json")),
  ];
  for (const name of names) {
    try {
      smallAssets.set(name, await readFile(path.join(smallAssetDirectory, name)));
    } catch {
      // The pure probe reports missing files as a reusable-cache miss.
    }
  }
  return probeOpenVikingRuntimeRelease({
    release,
    expectedTag,
    runtimeVersion: inputs.config.runtimeVersion,
    inputFingerprint: inputs.inputFingerprint,
    smallAssets,
  });
}

function validateRuntimeInputConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) || config.schemaVersion !== 1) {
    throw new Error("OpenViking runtime input config is invalid.");
  }
  assertToken(config.runtimeVersion, "version");
  assertToken(config.nodeVersion, "Node.js version");
  assertToken(config.rustToolchain, "Rust toolchain");
  if (!Array.isArray(config.fingerprintFiles) || !Array.isArray(config.targets)) {
    throw new Error("OpenViking runtime input config is incomplete.");
  }
  const fingerprints = new Set();
  for (const name of config.fingerprintFiles) {
    if (!isSafeRepositoryPath(name) || fingerprints.has(name)) {
      throw new Error("OpenViking runtime fingerprint file list is invalid.");
    }
    fingerprints.add(name);
  }
  for (const required of REQUIRED_FINGERPRINT_FILES) {
    if (!fingerprints.has(required)) throw new Error(`OpenViking runtime fingerprint omits ${required}.`);
  }

  const expectedTargets = new Map(OPENVIKING_RUNTIME_TARGETS.map((target) => [
    `${target.platform}-${target.arch}`,
    target,
  ]));
  const actualTargets = new Set();
  for (const target of config.targets) {
    const key = `${target?.platform}-${target?.arch}`;
    if (
      !expectedTargets.has(key)
      || actualTargets.has(key)
      || typeof target.runner !== "string"
      || !target.runner.trim()
      || typeof target.python_url !== "string"
      || !isTrustedPythonUrl(target.python_url)
      || typeof target.python_sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(target.python_sha256)
    ) {
      throw new Error("OpenViking runtime target matrix is invalid.");
    }
    actualTargets.add(key);
  }
  if (actualTargets.size !== expectedTargets.size) throw new Error("OpenViking runtime target matrix is incomplete.");
}

function isTrustedPythonUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && url.pathname.startsWith("/astral-sh/python-build-standalone/releases/download/");
  } catch {
    return false;
  }
}

function validAssetDigest(asset, { maxSize }) {
  if (
    !asset
    || typeof asset !== "object"
    || asset.state !== "uploaded"
    || !Number.isSafeInteger(asset.size)
    || asset.size <= 0
    || asset.size > maxSize
    || typeof asset.digest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)
  ) return null;
  return asset.digest.slice("sha256:".length);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function miss(reason, options = {}) {
  return {
    reusable: false,
    reason,
    legacyBootstrap: options.legacyBootstrap === true,
    hardFailure: options.hardFailure === true,
  };
}

function assertFingerprint(value) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(value ?? ""))) {
    throw new Error("OpenViking runtime input fingerprint is invalid.");
  }
}

function assertToken(value, label) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u.test(String(value ?? ""))) {
    throw new Error(`OpenViking runtime ${label} is invalid.`);
  }
}

function isSafeRepositoryPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.includes("\\")
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function assertPathInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`OpenViking ${label} must stay inside the repository.`);
  }
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(args) {
  const configPath = argumentValue(args, "--config");
  if (!configPath) throw new Error("--config is required.");
  const inputs = await loadOpenVikingRuntimeInputs({ configPath });

  if (args.includes("--describe")) {
    process.stdout.write(`${JSON.stringify({
      runtimeVersion: inputs.config.runtimeVersion,
      nodeVersion: inputs.config.nodeVersion,
      rustToolchain: inputs.config.rustToolchain,
      inputFingerprint: inputs.inputFingerprint,
      matrix: inputs.matrix,
      sidecarName: inputs.sidecarName,
    })}\n`);
    return;
  }

  const sidecarOutput = argumentValue(args, "--write-sidecar");
  if (sidecarOutput) {
    const outputDirectory = path.dirname(path.resolve(sidecarOutput));
    await mkdir(outputDirectory, { recursive: true });
    const runtimeAssets = await describeLocalRuntimeAssets(
      outputDirectory,
      inputs.config.runtimeVersion,
    );
    await writeFile(sidecarOutput, createRuntimeInputsSidecar({
      runtimeVersion: inputs.config.runtimeVersion,
      inputFingerprint: inputs.inputFingerprint,
      runtimeAssets,
    }));
    process.stdout.write(`${inputs.inputFingerprint}\n`);
    return;
  }

  const localAssetDirectory = argumentValue(args, "--verify-local-assets");
  if (localAssetDirectory) {
    await verifyLocalRuntimeAssets({
      directory: path.resolve(localAssetDirectory),
      runtimeVersion: inputs.config.runtimeVersion,
      inputFingerprint: inputs.inputFingerprint,
    });
    process.stdout.write(`${inputs.inputFingerprint}\n`);
    return;
  }

  const releaseJson = argumentValue(args, "--release-json");
  const smallAssetDirectory = argumentValue(args, "--small-assets-dir");
  const expectedTag = argumentValue(args, "--tag");
  if (!releaseJson || !smallAssetDirectory || !expectedTag) {
    throw new Error("Probe requires --release-json, --small-assets-dir, and --tag.");
  }
  const result = await probeFromFiles({ releaseJson, smallAssetDirectory, expectedTag, inputs });
  if (!result.reusable) {
    process.stderr.write(`OpenViking runtime reuse miss: ${result.reason}\n`);
    process.exitCode = result.hardFailure ? 1 : 2;
    return;
  }
  process.stdout.write(`${result.runtimeSourceTag}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
