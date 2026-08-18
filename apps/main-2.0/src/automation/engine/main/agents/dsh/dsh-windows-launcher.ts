import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const readCmdShim = require("read-cmd-shim") as {
  sync(filePath: string): string;
};
const which = require("which") as {
  sync(command: string, options?: {
    path?: string;
    pathExt?: string;
  }): string;
};

const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";
const MAX_WINDOWS_COMMAND_LINE_CHARS = 30_000;
const DSH_STDIN_BOOTSTRAP = [
  'import { pathToFileURL } from "node:url";',
  "const binPath = process.argv[1];",
  "let interruptRequested = false;",
  "let interruptTimer;",
  "const forwardInterrupt = () => {",
  "if (!interruptRequested || interruptTimer) return;",
  'if (process.listenerCount("SIGINT") > 0) { interruptRequested = false; process.emit("SIGINT"); return; }',
  "interruptTimer = setTimeout(() => { interruptTimer = undefined; forwardInterrupt(); }, 25);",
  "};",
  'process.on("message", (message) => { if (message && typeof message === "object" && message.type === "interrupt") { interruptRequested = true; forwardInterrupt(); } });',
  "process.channel?.unref();",
  'let payload = "";',
  'process.stdin.setEncoding("utf8");',
  "for await (const chunk of process.stdin) payload += chunk;",
  "const args = JSON.parse(payload);",
  'if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) throw new Error("Invalid DSH bootstrap arguments.");',
  "process.argv = [process.execPath, binPath, ...args];",
  "await import(pathToFileURL(binPath).href);",
].join("");

interface WindowsLauncherDependencies {
  pathApi: Pick<typeof path, "dirname" | "extname" | "isAbsolute" | "join" | "resolve">;
  fileExists: typeof existsSync;
  readTextFile: (filePath: string) => string;
  canonicalPath: (filePath: string) => string;
  readShim: (filePath: string) => string;
  resolveCommand: (command: string, environment: NodeJS.ProcessEnv) => string;
}

export interface DshProcessInvocation {
  executable: string;
  args: string[];
  stdin?: string;
  ipc?: true;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const entry = Object.entries(environment)
    .find(([name]) => name.toUpperCase() === key.toUpperCase());
  return entry?.[1];
}

const defaultDependencies: WindowsLauncherDependencies = {
  pathApi: path,
  fileExists: existsSync,
  readTextFile: (filePath) => readFileSync(filePath, "utf8"),
  canonicalPath: (filePath) => realpathSync(filePath),
  readShim: (filePath) => readCmdShim.sync(filePath),
  resolveCommand: (command, environment) => which.sync(command, {
    path: environmentValue(environment, "PATH"),
    pathExt: environmentValue(environment, "PATHEXT"),
  }),
};

function resolvedExecutable(
  executable: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
  dependencies: WindowsLauncherDependencies,
): string {
  const hasPathSeparator = /[\\/]/u.test(executable);
  if (dependencies.pathApi.isAbsolute(executable) || hasPathSeparator) {
    const resolved = dependencies.pathApi.isAbsolute(executable)
      ? dependencies.pathApi.resolve(executable)
      : dependencies.pathApi.resolve(workingDirectory, executable);
    if (!dependencies.fileExists(resolved)) {
      throw new Error(`DSH executable was not found: ${resolved}`);
    }
    return dependencies.canonicalPath(resolved);
  }
  try {
    return dependencies.canonicalPath(
      dependencies.resolveCommand(executable, environment),
    );
  } catch (error) {
    throw new Error(
      `Unable to resolve the DSH executable "${executable}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function officialDshEntry(
  targetPath: string,
  dependencies: WindowsLauncherDependencies,
): string {
  const canonicalTarget = dependencies.canonicalPath(targetPath);
  let directory = dependencies.pathApi.dirname(canonicalTarget);
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = dependencies.pathApi.join(directory, "package.json");
    if (dependencies.fileExists(manifestPath)) {
      let manifest: {
        name?: unknown;
        bin?: unknown;
      };
      try {
        manifest = JSON.parse(dependencies.readTextFile(manifestPath)) as typeof manifest;
      } catch (error) {
        throw new Error(
          `Unable to read the DSH package manifest at ${manifestPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (manifest.name !== DSH_PACKAGE_NAME) {
        throw new Error(
          `The Windows DSH shim resolves to ${String(manifest.name ?? "an unknown package")}, not ${DSH_PACKAGE_NAME}.`,
        );
      }
      const bin = typeof manifest.bin === "string"
        ? manifest.bin
        : manifest.bin && typeof manifest.bin === "object"
          ? (manifest.bin as Record<string, unknown>).dsh
          : undefined;
      if (typeof bin !== "string" || !bin.trim()) {
        throw new Error(`${DSH_PACKAGE_NAME} does not declare a dsh executable.`);
      }
      const declaredTarget = dependencies.canonicalPath(
        dependencies.pathApi.resolve(directory, bin),
      );
      if (declaredTarget.toLowerCase() !== canonicalTarget.toLowerCase()) {
        throw new Error("The Windows DSH shim target does not match the installed package manifest.");
      }
      return canonicalTarget;
    }
    const parent = dependencies.pathApi.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Unable to verify that ${targetPath} belongs to ${DSH_PACKAGE_NAME}.`);
}

function nodeExecutable(
  shimPath: string | undefined,
  environment: NodeJS.ProcessEnv,
  dependencies: WindowsLauncherDependencies,
): string {
  if (shimPath) {
    const adjacent = dependencies.pathApi.join(
      dependencies.pathApi.dirname(shimPath),
      "node.exe",
    );
    if (dependencies.fileExists(adjacent)) {
      return dependencies.canonicalPath(adjacent);
    }
  }
  try {
    return dependencies.canonicalPath(
      dependencies.resolveCommand("node.exe", environment),
    );
  } catch (error) {
    throw new Error(
      `Unable to find node.exe for the DSH CLI: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertCommandLineFits(invocation: DshProcessInvocation): void {
  const estimatedLength = [invocation.executable, ...invocation.args]
    .reduce((length, value) => length + value.length + 3, 0);
  if (estimatedLength > MAX_WINDOWS_COMMAND_LINE_CHARS) {
    throw new Error(
      "The DSH prompt exceeds the Windows process command-line limit. Shorten the request or attached instructions.",
    );
  }
}

function nodeModuleInvocation(
  target: string,
  args: string[],
  node: string,
): DshProcessInvocation {
  return {
    executable: node,
    args: [
      "--input-type=module",
      "--eval",
      DSH_STDIN_BOOTSTRAP,
      target,
    ],
    stdin: JSON.stringify(args),
    ipc: true,
  };
}

export function resolveWindowsDshInvocation(input: {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  workingDirectory?: string;
  dependencies?: Partial<WindowsLauncherDependencies>;
}): DshProcessInvocation {
  const dependencies: WindowsLauncherDependencies = {
    ...defaultDependencies,
    ...input.dependencies,
  };
  const executable = resolvedExecutable(
    input.executable,
    input.workingDirectory ?? process.cwd(),
    input.environment,
    dependencies,
  );
  const extension = dependencies.pathApi.extname(executable).toLowerCase();

  let invocation: DshProcessInvocation;
  if (extension === ".exe" || extension === ".com") {
    invocation = { executable, args: [...input.args] };
  } else if (extension === ".cmd") {
    let destination: string;
    try {
      destination = dependencies.readShim(executable);
    } catch (error) {
      throw new Error(
        `DSH_PATH must point to the official npm dsh.cmd shim or a native executable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const target = officialDshEntry(
      dependencies.pathApi.resolve(
        dependencies.pathApi.dirname(executable),
        destination,
      ),
      dependencies,
    );
    invocation = nodeModuleInvocation(
      target,
      input.args,
      nodeExecutable(executable, input.environment, dependencies),
    );
  } else if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const target = officialDshEntry(executable, dependencies);
    invocation = nodeModuleInvocation(
      target,
      input.args,
      nodeExecutable(undefined, input.environment, dependencies),
    );
  } else {
    throw new Error(
      `DSH_PATH resolves to an unsupported Windows executable (${extension || "no extension"}). Use the official npm dsh.cmd shim or a native .exe.`,
    );
  }

  assertCommandLineFits(invocation);
  return invocation;
}
