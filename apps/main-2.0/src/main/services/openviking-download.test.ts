import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { downloadFileWithResume } from "./openviking-download";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-download-"));
  roots.push(value);
  return value;
}

interface ServeOptions {
  body: string;
  /** Replies 200 with the whole body even when a range was requested. */
  ignoreRange?: boolean;
  status?: number;
}

async function serve(options: ServeOptions): Promise<{
  url: string;
  ranges: Array<string | undefined>;
}> {
  const ranges: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    ranges.push(request.headers.range);
    if (options.status && options.status !== 200) {
      response.writeHead(options.status).end();
      return;
    }
    const range = options.ignoreRange ? undefined : request.headers.range;
    const offset = range ? Number(/^bytes=(\d+)-/u.exec(range)?.[1] ?? 0) : 0;
    const chunk = options.body.slice(offset);
    response.writeHead(range ? 206 : 200, {
      "content-length": String(Buffer.byteLength(chunk)),
      ...(range
        ? { "content-range": `bytes ${offset}-${options.body.length - 1}/${options.body.length}` }
        : {}),
    });
    response.end(chunk);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/artifact`, ranges };
}

describe("downloadFileWithResume", () => {
  it("downloads a fresh artifact without asking for a range", async () => {
    const destination = path.join(await root(), "artifact");
    const { url, ranges } = await serve({ body: "runtime archive" });

    await downloadFileWithResume(url, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("runtime archive");
    expect(ranges).toEqual([undefined]);
  });

  it("resumes a partial file through a range request", async () => {
    const destination = path.join(await root(), "artifact");
    await writeFile(destination, "runtime ");
    const { url, ranges } = await serve({ body: "runtime archive" });

    await downloadFileWithResume(url, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("runtime archive");
    expect(ranges).toEqual(["bytes=8-"]);
  });

  it("reports progress that counts the resumed bytes toward the artifact total", async () => {
    const destination = path.join(await root(), "artifact");
    await writeFile(destination, "runtime ");
    const { url } = await serve({ body: "runtime archive" });
    const progress: Array<{ downloadedBytes: number; totalBytes?: number }> = [];

    await downloadFileWithResume(url, destination, (downloadedBytes, totalBytes) => {
      progress.push({ downloadedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
    });

    expect(progress[0]).toEqual({ downloadedBytes: 8, totalBytes: 15 });
    expect(progress.at(-1)).toEqual({ downloadedBytes: 15, totalBytes: 15 });
  });

  it("overwrites the partial file when the server ignores the range header", async () => {
    const destination = path.join(await root(), "artifact");
    await writeFile(destination, "stale bytes that must not survive");
    const { url } = await serve({ body: "runtime archive", ignoreRange: true });

    await downloadFileWithResume(url, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("runtime archive");
  });

  it("treats an unsatisfiable range as a complete transfer for the caller to checksum", async () => {
    const destination = path.join(await root(), "artifact");
    await writeFile(destination, "already complete");
    const { url } = await serve({ body: "runtime archive", status: 416 });

    await downloadFileWithResume(url, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("already complete");
  });

  it("surfaces a failing status code", async () => {
    const destination = path.join(await root(), "artifact");
    const { url } = await serve({ body: "runtime archive", status: 503 });

    await expect(downloadFileWithResume(url, destination)).rejects.toThrow("HTTP 503");
  });

  it("copies a local development artifact", async () => {
    const directory = await root();
    const source = path.join(directory, "source");
    const destination = path.join(directory, "artifact");
    await writeFile(source, "development runtime");

    await downloadFileWithResume(pathToFileURL(source).href, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("development runtime");
  });
});
