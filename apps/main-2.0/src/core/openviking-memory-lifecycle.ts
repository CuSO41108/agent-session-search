import type { OpenVikingMemorySnapshot } from "./openviking-memory";

export function isOpenVikingMemoryTransient(
  snapshot: OpenVikingMemorySnapshot | null,
): boolean {
  return snapshot?.runtime.state === "installing"
    || snapshot?.runtime.state === "starting"
    || snapshot?.model.downloading
    || false;
}
