import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const label = process.argv[3] ?? path.basename(repo);
const taskCount = Number(process.argv[4] ?? 500);
const burstSize = Number(process.argv[5] ?? 30);
const iterations = Number(process.argv[6] ?? 10);
const syntheticWorkDir = path.join(repo, ".benchmark-workdir");
const moduleUrl = pathToFileURL(path.join(repo, "src/automation/engine/main/hub/agent-hub.ts")).href;
const { AgentHub } = await import(moduleUrl);
const hub = new AgentHub();
const mutableHub = hub as any;
const now = Date.now();

for (let index = 0; index < taskCount; index += 1) {
  const task = mutableHub.createTaskState({ prompt: `Benchmark task ${index}`, configuredAgentId: "default-agent", workDir: syntheticWorkDir });
  task.planningWorkflowId = "wf-benchmark";
  task.messages = Array.from({ length: 20 }, (_, messageIndex) => ({
    id: `${task.id}:${messageIndex}`,
    role: "assistant",
    content: `history-${index}-${messageIndex}-${"x".repeat(960)}`,
    timestamp: now + messageIndex,
    events: [],
  }));
  mutableHub.tasks.set(task.id, task);
}

const target = [...mutableHub.tasks.values()][0];
let snapshotCalls = 0;
let snapshotCpuMs = 0;
let projectionCalls = 0;
let projectionCpuMs = 0;
const originalSnapshot = hub.snapshot.bind(hub);
mutableHub.snapshot = () => {
  const started = performance.now();
  const value = originalSnapshot();
  snapshotCpuMs += performance.now() - started;
  snapshotCalls += 1;
  return value;
};
if (typeof mutableHub.workflowProjection === "function") {
  const originalProjection = mutableHub.workflowProjection.bind(hub);
  mutableHub.workflowProjection = (...args: unknown[]) => {
    const started = performance.now();
    const value = originalProjection(...args);
    projectionCpuMs += performance.now() - started;
    projectionCalls += 1;
    return value;
  };
}

let deliveryBytes = 0;
let serializationCpuMs = 0;
let deliveries = 0;
let resolveDelivery: (() => void) | undefined;
const unsubscribe = hub.onChange((value: unknown) => {
  const started = performance.now();
  deliveryBytes += Buffer.byteLength(JSON.stringify(value));
  serializationCpuMs += performance.now() - started;
  deliveries += 1;
  resolveDelivery?.();
  resolveDelivery = undefined;
});

snapshotCalls = 0;
snapshotCpuMs = 0;
projectionCalls = 0;
projectionCpuMs = 0;
deliveryBytes = 0;
serializationCpuMs = 0;
deliveries = 0;
const burstCpuSamples: number[] = [];
const deliveryLatencySamples: number[] = [];

for (let iteration = 0; iteration < iterations; iteration += 1) {
  const delivered = new Promise<void>((resolve) => { resolveDelivery = resolve; });
  const started = performance.now();
  for (let index = 0; index < burstSize; index += 1) {
    mutableHub.handleAgentEvent(target, { type: "delta", content: "z" });
  }
  burstCpuSamples.push(performance.now() - started);
  await Promise.race([delivered, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
  deliveryLatencySamples.push(performance.now() - started);
}

unsubscribe();
await hub.shutdown();
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
process.stdout.write(`${JSON.stringify({
  label,
  taskCount,
  messagesPerTask: 20,
  messageChars: 960,
  burstSize,
  iterations,
  deliveries,
  snapshotCalls,
  projectionCalls,
  averageBurstCpuMs: average(burstCpuSamples),
  averageDeliveryLatencyMs: average(deliveryLatencySamples),
  averageSnapshotCpuMs: snapshotCpuMs / Math.max(snapshotCalls, 1),
  averageProjectionCpuMs: projectionCpuMs / Math.max(projectionCalls, 1),
  averageSerializationCpuMs: serializationCpuMs / Math.max(deliveries, 1),
  averageDeliveryBytes: deliveryBytes / Math.max(deliveries, 1),
})}\n`);
