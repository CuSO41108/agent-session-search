import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export type DownloadProgressListener = (
  downloadedBytes: number,
  totalBytes?: number,
  bytesPerSecond?: number,
) => void;

/**
 * Downloads `url` into `destination`, resuming an interrupted attempt through an HTTP
 * range request when a partial file is already on disk. Callers keep the partial file
 * after a failure so a retry does not restart a multi-hundred-megabyte transfer, and
 * delete it when the checksum of the completed file does not match.
 */
export async function downloadFileWithResume(
  url: string,
  destination: string,
  onProgress?: DownloadProgressListener,
): Promise<void> {
  const source = new URL(url);
  if (source.protocol === "file:") {
    const sourcePath = fileURLToPath(source);
    const totalBytes = (await stat(sourcePath)).size;
    await pipeline(
      createReadStream(sourcePath),
      createDownloadProgressTransform(totalBytes, onProgress),
      createWriteStream(destination, { mode: 0o600 }),
    );
    return;
  }
  const resumeFrom = await partialSize(destination);
  const response = await fetch(url, {
    redirect: "follow",
    ...(resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` } } : {}),
  });
  if (resumeFrom > 0 && response.status === 416) {
    // The requested range starts past the end of the artifact, so the partial file is
    // already at least its full length. The caller's checksum decides whether it is usable.
    onProgress?.(resumeFrom, resumeFrom);
    return;
  }
  if (!response.ok || !response.body) {
    throw new Error(`OpenViking download failed with HTTP ${response.status}.`);
  }
  // A server that ignores the range header replies 200 with the whole artifact, which
  // has to overwrite the partial file rather than append to it.
  const resumed = resumeFrom > 0 && response.status === 206;
  const remainingBytes = Number(response.headers.get("content-length"));
  const totalBytes = Number.isSafeInteger(remainingBytes) && remainingBytes > 0
    ? (resumed ? resumeFrom : 0) + remainingBytes
    : undefined;
  await pipeline(
    Readable.fromWeb(response.body as never),
    createDownloadProgressTransform(totalBytes, onProgress, resumed ? resumeFrom : 0),
    createWriteStream(destination, { mode: 0o600, flags: resumed ? "a" : "w" }),
  );
}

async function partialSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function createDownloadProgressTransform(
  totalBytes: number | undefined,
  onProgress?: DownloadProgressListener,
  alreadyOnDisk = 0,
): Transform {
  let downloadedBytes = alreadyOnDisk;
  const startedAt = Date.now();
  onProgress?.(downloadedBytes, totalBytes);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.byteLength;
      const elapsedMs = Date.now() - startedAt;
      // Speed covers only this attempt's transfer, so resumed bytes stay out of it.
      const bytesPerSecond = elapsedMs >= 250
        ? Math.round((downloadedBytes - alreadyOnDisk) / (elapsedMs / 1_000))
        : undefined;
      onProgress?.(downloadedBytes, totalBytes, bytesPerSecond);
      callback(null, chunk);
    },
  });
}
