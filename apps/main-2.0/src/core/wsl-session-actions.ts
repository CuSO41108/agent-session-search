import { runRemoteCommand } from "./remote-process";
import type { SessionEnvironment } from "./types";

export type WslCommandRunner = (environment: SessionEnvironment, remoteCommand: string) => Promise<string>;

export async function deleteWslSessionFile(
  environment: SessionEnvironment,
  filePath: string,
  runCommand: WslCommandRunner = runRemoteCommand,
): Promise<void> {
  await deleteWslSessionFiles(environment, [filePath], runCommand);
}

export async function deleteWslSessionFiles(
  environment: SessionEnvironment,
  filePaths: readonly string[],
  runCommand: WslCommandRunner = runRemoteCommand,
): Promise<void> {
  if (environment.kind !== "wsl") throw new Error("WSL session deletion requires a WSL environment.");
  const normalizedPaths = [...new Set(filePaths.map((filePath) => filePath.trim()))];
  if (normalizedPaths.some((filePath) => !filePath.startsWith("/"))) throw new Error("WSL session path must be absolute.");
  if (normalizedPaths.length === 0) return;
  await runCommand(environment, `rm -f -- ${normalizedPaths.map(posixShellQuote).join(" ")}`);
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
