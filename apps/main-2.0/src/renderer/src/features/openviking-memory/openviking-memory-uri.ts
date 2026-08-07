const OPENVIKING_MEMORY_URI_PREFIX = "viking://user/memories/";

export function tryCanonicalOpenVikingMemoryUri(uri: string): string | null {
  const normalized = uri.trim();
  if (
    !normalized.startsWith("viking://user/")
    || normalized.includes("\0")
    || normalized.includes("\\")
    || normalized.includes("?")
    || normalized.includes("#")
  ) {
    return null;
  }

  const segments = normalized.slice("viking://user/".length).split("/");
  const memoryIndex = segments[0] === "memories"
    ? 0
    : segments[0] && segments[1] === "memories"
      ? 1
      : -1;
  const memoryPath = segments.slice(memoryIndex + 1);
  if (
    memoryIndex < 0
    || memoryPath.length === 0
    || memoryPath.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }

  return `${OPENVIKING_MEMORY_URI_PREFIX}${memoryPath.join("/")}`;
}
