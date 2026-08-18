import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  resolveWindowsDshInvocation,
  type DshProcessInvocation,
} from "./dsh-windows-launcher";

type IpcDshProcessInvocation = DshProcessInvocation & { ipc?: boolean };

const OFFICIAL_PACKAGE_NAME = "@deepseek-ai/dsh";
const OFFICIAL_RELATIVE_BIN = "bin/dsh.mjs";

let fixtureRoot = "";

beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-dsh-windows-"));
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function writeExecutable(filePath: string, content = ""): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

async function createOfficialPackage(input: {
  root?: string;
  extension?: ".js" | ".mjs" | ".cjs";
  manifestName?: string;
  manifestBin?: string | Record<string, unknown>;
  source?: string;
} = {}): Promise<{
  packageDir: string;
  target: string;
}> {
  const packageDir = input.root
    ?? path.join(fixtureRoot, "node_modules", "@deepseek-ai", "dsh");
  const extension = input.extension ?? ".mjs";
  const target = path.join(packageDir, "bin", `dsh${extension}`);
  const declaredBin = input.manifestBin ?? `bin/dsh${extension}`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: input.manifestName ?? OFFICIAL_PACKAGE_NAME,
      bin: declaredBin,
    }),
    "utf8",
  );
  await writeExecutable(
    target,
    input.source ?? "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.disconnect?.();",
  );
  return { packageDir, target };
}

async function createNpmShim(input: {
  targetRelative?: string;
  adjacentNode?: boolean;
  content?: string;
} = {}): Promise<{
  shim: string;
  adjacentNode?: string;
}> {
  const shimDir = path.join(fixtureRoot, "bin");
  const shim = path.join(shimDir, "dsh.cmd");
  const targetRelative = input.targetRelative
    ?? "../node_modules/@deepseek-ai/dsh/bin/dsh.mjs";
  const content = input.content
    ?? `@ECHO off\r\n"%~dp0\\${targetRelative}" %*\r\n`;
  await writeExecutable(shim, content);
  if (!input.adjacentNode) return { shim };
  const adjacentNode = await writeExecutable(path.join(shimDir, "node.exe"));
  return { shim, adjacentNode };
}

function bootstrapInvocation(
  invocation: DshProcessInvocation,
): IpcDshProcessInvocation {
  return invocation as IpcDshProcessInvocation;
}

function expectBootstrapPayload(
  invocation: DshProcessInvocation,
  expectedArgs: string[],
  expectedTarget: string,
): void {
  const bootstrap = bootstrapInvocation(invocation);
  expect(bootstrap.ipc).toBe(true);
  expect(bootstrap.args[0]).toBe("--input-type=module");
  expect(bootstrap.args[1]).toBe("--eval");
  expect(bootstrap.args[2]).toContain("process.stdin");
  expect(bootstrap.args[3]).toBe(realpathSync(expectedTarget));
  expect(bootstrap.stdin).toBe(JSON.stringify(expectedArgs));
  expect(JSON.parse(bootstrap.stdin ?? "null")).toEqual(expectedArgs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectOutput(stream: NodeJS.ReadableStream): {
  output: () => string;
  waitFor: (text: string, timeoutMs?: number) => Promise<void>;
} {
  let content = "";
  const listeners = new Set<() => void>();
  stream.on("data", (chunk: Buffer | string) => {
    content += chunk.toString();
    for (const listener of listeners) listener();
  });
  return {
    output: () => content,
    waitFor: (text, timeoutMs = 3_000) => {
      if (content.includes(text)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out waiting for child output ${JSON.stringify(text)}. Output: ${content}`));
        }, timeoutMs);
        const check = (): void => {
          if (!content.includes(text)) return;
          clearTimeout(timeout);
          listeners.delete(check);
          resolve();
        };
        listeners.add(check);
      });
    },
  };
}

describe("resolveWindowsDshInvocation", () => {
  test("resolves the official npm dsh.cmd shim with an adjacent node.exe", async () => {
    const { target } = await createOfficialPackage({
      manifestBin: { dsh: OFFICIAL_RELATIVE_BIN },
    });
    const { shim, adjacentNode } = await createNpmShim({ adjacentNode: true });
    const args = ["--profile", "headless", "Review the changes."];
    const resolveCommand = vi.fn(() => {
      throw new Error("PATH lookup should not be used");
    });

    const invocation = resolveWindowsDshInvocation({
      executable: shim,
      args,
      environment: { PATH: "ignored" },
      dependencies: { resolveCommand },
    });

    expect(invocation.executable).toBe(realpathSync(adjacentNode!));
    expectBootstrapPayload(invocation, args, target);
    expect(resolveCommand).not.toHaveBeenCalled();
  });

  test("uses node.exe from PATH when the official npm shim has no adjacent runtime", async () => {
    const { target } = await createOfficialPackage();
    const { shim } = await createNpmShim();
    const pathNode = await writeExecutable(path.join(fixtureRoot, "node-path", "node.exe"));
    const environment = { Path: path.dirname(pathNode), PATHEXT: ".EXE;.CMD" };
    const resolveCommand = vi.fn((command: string, receivedEnvironment: NodeJS.ProcessEnv) => {
      expect(receivedEnvironment).toBe(environment);
      if (command === "node.exe") return pathNode;
      throw new Error(`unexpected command: ${command}`);
    });
    const args = ["--profile", "headless", "Use PATH node."];

    const invocation = resolveWindowsDshInvocation({
      executable: shim,
      args,
      environment,
      dependencies: { resolveCommand },
    });

    expect(invocation.executable).toBe(realpathSync(pathNode));
    expectBootstrapPayload(invocation, args, target);
    expect(resolveCommand).toHaveBeenCalledOnce();
    expect(resolveCommand).toHaveBeenCalledWith("node.exe", environment);
  });

  test.each([
    [".js", "bin/dsh.js"],
    [".mjs", "bin/dsh.mjs"],
    [".cjs", "bin/dsh.cjs"],
  ] as const)("accepts a direct official %s JavaScript bin", async (extension, manifestBin) => {
    const { target } = await createOfficialPackage({
      extension,
      manifestBin,
    });
    const args = ["--profile", "headless", `Direct ${extension}`];
    const resolveCommand = vi.fn((command: string) => {
      expect(command).toBe("node.exe");
      return process.execPath;
    });

    const invocation = resolveWindowsDshInvocation({
      executable: target,
      args,
      environment: {},
      dependencies: { resolveCommand },
    });

    expect(invocation.executable).toBe(realpathSync(process.execPath));
    expectBootstrapPayload(invocation, args, target);
  });

  test.each([".exe", ".com"] as const)("passes arguments directly to a native %s executable", async (extension) => {
    const executable = await writeExecutable(path.join(fixtureRoot, `dsh${extension}`));
    const args = ["--profile", "headless", "Native prompt %PATH% & \"quoted\""];

    const invocation = bootstrapInvocation(resolveWindowsDshInvocation({
      executable,
      args,
      environment: {},
    }));

    expect(invocation).toEqual({
      executable: realpathSync(executable),
      args,
    });
    expect(invocation.stdin).toBeUndefined();
    expect(invocation.ipc).toBeUndefined();
  });

  test("resolves a bare dsh command through PATH before classifying it", async () => {
    const executable = await writeExecutable(path.join(fixtureRoot, "path-bin", "dsh.exe"));
    const environment = { PATH: path.dirname(executable), PATHEXT: ".EXE;.CMD" };
    const resolveCommand = vi.fn((command: string, receivedEnvironment: NodeJS.ProcessEnv) => {
      expect(command).toBe("dsh");
      expect(receivedEnvironment).toBe(environment);
      return executable;
    });
    const args = ["--profile", "headless", "Resolved from PATH"];

    const invocation = resolveWindowsDshInvocation({
      executable: "dsh",
      args,
      environment,
      dependencies: { resolveCommand },
    });

    expect(resolveCommand).toHaveBeenCalledOnce();
    expect(invocation).toEqual({
      executable: realpathSync(executable),
      args,
    });
  });

  test("resolves a relative tools/dsh.exe against the supplied working directory", async () => {
    const workingDirectory = path.join(fixtureRoot, "workspace");
    const executable = await writeExecutable(path.join(workingDirectory, "tools", "dsh.exe"));
    const args = ["--profile", "headless", "Relative executable"];
    const resolveCommand = vi.fn(() => {
      throw new Error("PATH lookup should not be used for a relative path");
    });

    const invocation = resolveWindowsDshInvocation({
      executable: "tools/dsh.exe",
      args,
      environment: {},
      workingDirectory,
      dependencies: { resolveCommand },
    });

    expect(invocation).toEqual({
      executable: realpathSync(executable),
      args,
    });
    expect(resolveCommand).not.toHaveBeenCalled();
  });

  test("keeps hostile and long Unicode prompts out of argv and sends them as stdin JSON", async () => {
    const { target } = await createOfficialPackage();
    const { shim, adjacentNode } = await createNpmShim({ adjacentNode: true });
    const prompt = [
      "first line\r\nsecond line",
      "%PATH% & echo should-not-be-parsed",
      "\"quoted sentinel\"",
      "长文本".repeat(12_000),
      "🙂🚀".repeat(4_000),
    ].join("\r\n");
    const args = ["--profile", "headless", prompt];

    const invocation = resolveWindowsDshInvocation({
      executable: shim,
      args,
      environment: {},
    });

    expect(invocation.executable).toBe(realpathSync(adjacentNode!));
    expectBootstrapPayload(invocation, args, target);
    const commandLine = invocation.args.join("\n");
    expect(commandLine).not.toContain(prompt);
    expect(commandLine).not.toContain("%PATH%");
    expect(commandLine).not.toContain("& echo should-not-be-parsed");
    expect(commandLine).not.toContain("\"quoted sentinel\"");
    expect(commandLine).not.toContain("长文本长文本");
    expect(commandLine).not.toContain("🙂🚀");
  });

  test.each([
    [".bat", "unsupported Windows executable (.bat)"],
    ["", "unsupported Windows executable (no extension)"],
  ] as const)("rejects an executable with %s extension", async (extension, message) => {
    const executable = await writeExecutable(path.join(fixtureRoot, `dsh${extension}`));

    expect(() => resolveWindowsDshInvocation({
      executable,
      args: ["--profile", "headless", "prompt"],
      environment: {},
    })).toThrow(message);
  });

  test("rejects a malformed cmd file instead of executing arbitrary batch content", async () => {
    const { shim } = await createNpmShim({
      content: "@ECHO off\r\npowershell -Command \"Write-Host compromised\"\r\n",
    });

    expect(() => resolveWindowsDshInvocation({
      executable: shim,
      args: ["--profile", "headless", "prompt"],
      environment: {},
    })).toThrow("DSH_PATH must point to the official npm dsh.cmd shim or a native executable");
  });

  test("rejects a shim that escapes to an unverified target", async () => {
    const target = await writeExecutable(path.join(fixtureRoot, "payload", "evil.mjs"));
    const { shim } = await createNpmShim({
      targetRelative: path.relative(path.join(fixtureRoot, "bin"), target),
    });

    expect(() => resolveWindowsDshInvocation({
      executable: shim,
      args: ["--profile", "headless", "prompt"],
      environment: {},
    })).toThrow(`Unable to verify that ${realpathSync(target)} belongs to ${OFFICIAL_PACKAGE_NAME}`);
  });

  test("rejects a shim target owned by a non-official package", async () => {
    const packageDir = path.join(fixtureRoot, "node_modules", "hostile-dsh");
    const { target } = await createOfficialPackage({
      root: packageDir,
      manifestName: "hostile-dsh",
    });
    const { shim } = await createNpmShim({
      targetRelative: path.relative(path.join(fixtureRoot, "bin"), target),
    });

    expect(() => resolveWindowsDshInvocation({
      executable: shim,
      args: ["--profile", "headless", "prompt"],
      environment: {},
    })).toThrow(`not ${OFFICIAL_PACKAGE_NAME}`);
  });

  test("rejects an official package whose declared dsh bin does not match the shim target", async () => {
    const packageDir = path.join(fixtureRoot, "node_modules", "@deepseek-ai", "dsh");
    const { target } = await createOfficialPackage({
      root: packageDir,
      manifestBin: { dsh: "bin/other.mjs" },
    });
    await writeExecutable(path.join(packageDir, "bin", "other.mjs"));
    const { shim } = await createNpmShim();

    expect(() => resolveWindowsDshInvocation({
      executable: shim,
      args: ["--profile", "headless", "prompt"],
      environment: {},
    })).toThrow("The Windows DSH shim target does not match the installed package manifest");
    expect(realpathSync(target)).not.toBe(realpathSync(path.join(packageDir, "bin", "other.mjs")));
  });

  test("rejects an official package without a usable dsh bin declaration", async () => {
    const packageDir = path.join(fixtureRoot, "node_modules", "@deepseek-ai", "dsh");
    const target = path.join(packageDir, "bin", "dsh.mjs");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: OFFICIAL_PACKAGE_NAME, bin: { other: "bin/other.mjs" } }),
      "utf8",
    );
    await writeExecutable(target);
    const { shim } = await createNpmShim();

    expect(() => resolveWindowsDshInvocation({
      executable: shim,
      args: ["--profile", "headless", "prompt"],
      environment: {},
    })).toThrow(`${OFFICIAL_PACKAGE_NAME} does not declare a dsh executable`);
  });

  test("reports a malformed official package manifest", async () => {
    const packageDir = path.join(fixtureRoot, "node_modules", "@deepseek-ai", "dsh");
    const target = path.join(packageDir, "bin", "dsh.mjs");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), "{not-json", "utf8");
    await writeExecutable(target);
    const { shim } = await createNpmShim();

    expect(() => resolveWindowsDshInvocation({
      executable: shim,
      args: ["--profile", "headless", "prompt"],
      environment: {},
    })).toThrow("Unable to read the DSH package manifest");
  });

  test("reports a missing node.exe when an official JavaScript bin needs PATH Node", async () => {
    const { target } = await createOfficialPackage();
    const resolveCommand = vi.fn(() => {
      throw new Error("not found in PATH");
    });

    expect(() => resolveWindowsDshInvocation({
      executable: target,
      args: ["--profile", "headless", "prompt"],
      environment: { PATH: "C:\\empty" },
      dependencies: { resolveCommand },
    })).toThrow("Unable to find node.exe for the DSH CLI: not found in PATH");
    expect(resolveCommand).toHaveBeenCalledWith("node.exe", { PATH: "C:\\empty" });
  });

  test("rejects an overlong native command line before spawning it", async () => {
    const executable = await writeExecutable(path.join(fixtureRoot, "dsh.exe"));
    const prompt = `prefix-${"界🙂".repeat(16_000)}`;

    expect(() => resolveWindowsDshInvocation({
      executable,
      args: ["--profile", "headless", prompt],
      environment: {},
    })).toThrow("The DSH prompt exceeds the Windows process command-line limit");
  });
});

describe("DSH stdin bootstrap", () => {
  test("executes the official bin with CRLF and split UTF-8 input preserved exactly", async () => {
    const expectedArgs = [
      "--profile",
      "headless",
      "line one\r\nline two %PATH% & \"quoted\" 中文🙂🚀尾",
    ];
    const { target } = await createOfficialPackage();
    const invocation = bootstrapInvocation(resolveWindowsDshInvocation({
      executable: target,
      args: expectedArgs,
      environment: {},
      dependencies: {
        resolveCommand: (command) => {
          if (command === "node.exe") return process.execPath;
          throw new Error(`unexpected command: ${command}`);
        },
      },
    }));
    expectBootstrapPayload(invocation, expectedArgs, target);

    const child = spawn(invocation.executable, invocation.args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("Expected piped stdin, stdout, and stderr for the DSH bootstrap test.");
    }
    const { stdin, stdout: childStdout, stderr: childStderr } = child;
    let stdout = "";
    let stderr = "";
    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    childStderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const payload = Buffer.from(invocation.stdin ?? "", "utf8");
    const marker = Buffer.from("🙂", "utf8");
    const markerOffset = payload.indexOf(marker);
    expect(markerOffset).toBeGreaterThanOrEqual(0);
    stdin.write(payload.subarray(0, markerOffset + 1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(payload.subarray(markerOffset + 1, markerOffset + 3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.end(payload.subarray(markerOffset + 3));

    const result = await closed;
    expect(result).toEqual({ code: 0, signal: null });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(expectedArgs);
  });

  test("keeps a pending interrupt alive until a no-handle module registers SIGINT", async () => {
    const source = [
      'process.stdout.write("module-started\\n");',
      "let signalCount = 0;",
      "let resolveDone;",
      "const done = new Promise((resolve) => { resolveDone = resolve; });",
      "const registerTimer = setTimeout(() => {",
      'process.stdout.write("handler-registered\\n");',
      'process.on("SIGINT", () => {',
      "signalCount += 1;",
      'process.stdout.write(`sigint:${signalCount}\\n`);',
      "if (signalCount > 1) process.exitCode = 8;",
      "resolveDone();",
      "});",
      "}, 200);",
      "registerTimer.unref();",
      "await done;",
      'process.stdout.write("module-completed\\n");',
    ].join("");
    const { target } = await createOfficialPackage({ source });
    const invocation = bootstrapInvocation(resolveWindowsDshInvocation({
      executable: target,
      args: ["--profile", "headless", "wait for interrupt"],
      environment: {},
      dependencies: {
        resolveCommand: (command) => {
          if (command === "node.exe") return process.execPath;
          throw new Error(`unexpected command: ${command}`);
        },
      },
    }));
    const child = spawn(invocation.executable, invocation.args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("Expected piped stdio for the DSH IPC lifecycle test.");
    }
    const stdout = collectOutput(child.stdout);
    const stderr = collectOutput(child.stderr);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      child.stdin.end(invocation.stdin);
      expect(child.connected).toBe(true);
      await new Promise<void>((resolve, reject) => {
        child.send({ type: "interrupt" }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      await stdout.waitFor("module-started\n");
      await stdout.waitFor("handler-registered\n");
      await stdout.waitFor("sigint:1\n");
      await stdout.waitFor("module-completed\n");
      const result = await closed;

      expect(result).toEqual({ code: 0, signal: null });
      expect(stdout.output().match(/sigint:/gu)).toHaveLength(1);
      expect(stderr.output()).toBe("");
      expect(child.connected).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 7_000);

  test("exits naturally after background work even while the parent keeps IPC connected", async () => {
    const source = [
      'process.stdout.write("imported\\n");',
      "setTimeout(() => {",
      'process.stdout.write("background-finished\\n");',
      "}, 250);",
    ].join("");
    const { target } = await createOfficialPackage({ source });
    const invocation = bootstrapInvocation(resolveWindowsDshInvocation({
      executable: target,
      args: ["--profile", "headless", "finish naturally"],
      environment: {},
      dependencies: {
        resolveCommand: (command) => {
          if (command === "node.exe") return process.execPath;
          throw new Error(`unexpected command: ${command}`);
        },
      },
    }));
    const child = spawn(invocation.executable, invocation.args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("Expected piped stdio for the DSH IPC unref test.");
    }
    const stdout = collectOutput(child.stdout);
    const stderr = collectOutput(child.stderr);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      child.stdin.end(invocation.stdin);
      await stdout.waitFor("imported\n");
      await delay(75);
      expect(child.connected).toBe(true);

      const result = await closed;
      expect(result).toEqual({ code: 0, signal: null });
      expect(stdout.output()).toContain("background-finished\n");
      expect(stderr.output()).toBe("");
      expect(child.connected).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 5_000);
});
