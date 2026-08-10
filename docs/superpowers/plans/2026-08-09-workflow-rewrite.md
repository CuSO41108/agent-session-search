# Workflow Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Workflow V2 with one structured workflow model, four explicit node kinds, a small scheduler/executor core, fresh persistence, and a definition/run focused UI.

**Architecture:** The shared layer owns the definition, validation, prompt assembly, output validation, and run contracts. The main process owns a scheduler plus four executors behind one adapter interface and persists complete frozen runs. The renderer edits the same structured definition and derives graph edges from node-output input references.

**Tech Stack:** TypeScript, Vitest, React 19, Electron IPC, PostgreSQL, `@xyflow/react`, existing configured-agent runtime adapters.

---

### Task 1: Replace the shared Workflow model

**Files:**
- Create: `apps/main-2.0/src/automation/engine/shared/workflow/model.ts`
- Create: `apps/main-2.0/src/automation/engine/shared/workflow/validation.ts`
- Create: `apps/main-2.0/src/automation/engine/shared/workflow/validation.test.ts`
- Modify: `apps/main-2.0/src/automation/engine/shared/types.ts`

- [ ] **Step 1: Write failing definition-validation tests**

Cover a valid Agent → Review graph, duplicate keys, missing `nodeId/outputKey`, cycles, invalid nested output depth, missing Review fixed fields, invalid Approval options, and unknown Agent IDs. Assert errors contain stable `path` and `message` fields.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- --run src/automation/engine/shared/workflow/validation.test.ts`

Expected: FAIL because the new model and validator do not exist.

- [ ] **Step 3: Implement the discriminated model**

Define `WorkflowDefinition`, `WorkflowInputDefinition`, `WorkflowNodeInput`, recursive `WorkflowOutputField`, `AgentNode`, `ScriptNode`, `ReviewNode`, `ApprovalNode`, `WorkflowRun`, `WorkflowNodeRun`, and operation request/result contracts exactly as specified in the design.

- [ ] **Step 4: Implement one pure validator**

Export:

```ts
export interface WorkflowValidationIssue {
  path: string;
  message: string;
}

export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
  configuredAgentIds?: ReadonlySet<string>,
): WorkflowValidationIssue[];
```

Build dependencies solely from `source: "node"` inputs. Validate output shapes recursively with a maximum compound depth of two.

- [ ] **Step 5: Export the new contracts and run tests**

Run: `npm test -- --run src/automation/engine/shared/workflow/validation.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/main-2.0/src/automation/engine/shared/workflow/model.ts apps/main-2.0/src/automation/engine/shared/workflow/validation.ts apps/main-2.0/src/automation/engine/shared/workflow/validation.test.ts apps/main-2.0/src/automation/engine/shared/types.ts
git commit -m "feat(workflow): define structured workflow model"
```

### Task 2: Add prompt assembly, output validation, and scheduling

**Files:**
- Create: `apps/main-2.0/src/automation/engine/shared/workflow/prompt.ts`
- Create: `apps/main-2.0/src/automation/engine/shared/workflow/prompt.test.ts`
- Create: `apps/main-2.0/src/automation/engine/shared/workflow/output.ts`
- Create: `apps/main-2.0/src/automation/engine/shared/workflow/output.test.ts`
- Create: `apps/main-2.0/src/automation/engine/shared/workflow/scheduler.ts`
- Create: `apps/main-2.0/src/automation/engine/shared/workflow/scheduler.test.ts`

- [ ] **Step 1: Write failing prompt tests**

Assert deterministic `Goal → Inputs → Instructions → Constraints → Expected outputs → Completion criteria` ordering and explicit delimiting of untrusted runtime values.

- [ ] **Step 2: Implement `assembleWorkflowNodePrompt`**

```ts
export function assembleWorkflowNodePrompt(input: {
  node: AgentNode | ReviewNode;
  resolvedInputs: Record<string, unknown>;
}): string;
```

Serialize output schemas with field names, keys, descriptions, types, required flags, and nested members. Do not include system execution protocol in the returned text.

- [ ] **Step 3: Write failing output-validation tests**

Cover missing required values, wrong scalar types, object/list nesting, extra top-level fields, Review verdict values, and file paths that are absolute or escape with `..`.

- [ ] **Step 4: Implement output validation**

```ts
export function validateWorkflowNodeOutputs(
  node: WorkflowNode,
  outputs: unknown,
): WorkflowValidationIssue[];
```

Reject undeclared top-level fields so downstream contracts remain exact.

- [ ] **Step 5: Write failing scheduler tests**

Cover ready-node discovery, parallel branches, failed dependencies, downstream invalidation, Review revise targets, and terminal run status.

- [ ] **Step 6: Implement pure scheduler helpers**

Export `workflowNodeDependencies`, `readyWorkflowNodeIds`, `invalidateWorkflowDownstream`, and `deriveWorkflowRunStatus`. These functions mutate nothing and accept frozen definition/run data.

- [ ] **Step 7: Run the focused tests and commit**

Run: `npm test -- --run src/automation/engine/shared/workflow`

Expected: PASS.

```bash
git add apps/main-2.0/src/automation/engine/shared/workflow
git commit -m "feat(workflow): add prompt output and scheduler core"
```

### Task 3: Implement the new runtime and four executors

**Files:**
- Create: `apps/main-2.0/src/automation/engine/main/workflows/workflow-engine.ts`
- Create: `apps/main-2.0/src/automation/engine/main/workflows/workflow-engine.test.ts`
- Create: `apps/main-2.0/src/automation/engine/main/workflows/workflow-executors.ts`
- Create: `apps/main-2.0/src/automation/engine/main/workflows/workflow-executors.test.ts`
- Modify: `apps/main-2.0/src/automation/engine/main/platform/configured-agent-execution-service.ts`

- [ ] **Step 1: Write failing engine tests with fake executors**

Assert parallel Agent execution, precise input resolution, atomic node completion, failed-branch behavior, retry invalidation, cancellation, Approval wait/resume, and Review revise/pass loops.

- [ ] **Step 2: Implement `WorkflowEngine`**

The constructor receives a store port, executor map, ID/clock functions, and an event callback. `start`, `retryNode`, `resolveApproval`, and `cancel` are the only public state transitions. A per-run `AbortController` owns active work.

- [ ] **Step 3: Write failing executor adapter tests**

Assert Agent/Review prompts use the shared assembler, Script receives resolved input JSON through stdin and parses one JSON object from stdout, permission confirmation occurs before execution, and timeouts abort child processes.

- [ ] **Step 4: Implement the executor adapters**

Reuse configured-agent invocation and existing runtime approval plumbing behind this interface:

```ts
export interface WorkflowNodeExecutor<K extends WorkflowNode["kind"]> {
  execute(input: WorkflowExecutionInput<Extract<WorkflowNode, { kind: K }>>): Promise<Record<string, unknown>>;
  cancel?(runId: string, nodeId: string): Promise<void>;
}
```

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- --run src/automation/engine/main/workflows/workflow-engine.test.ts src/automation/engine/main/workflows/workflow-executors.test.ts`

Expected: PASS.

```bash
git add apps/main-2.0/src/automation/engine/main/workflows apps/main-2.0/src/automation/engine/main/platform/configured-agent-execution-service.ts
git commit -m "feat(workflow): implement unified workflow engine"
```

### Task 4: Replace persistence and IPC

**Files:**
- Modify: `apps/main-2.0/src/core/postgres/schema.ts`
- Modify: `apps/main-2.0/src/core/postgres/schema.test.ts`
- Replace: `apps/main-2.0/src/automation/engine/main/hub/persisted/postgres-workflow-repository.ts`
- Replace: `apps/main-2.0/src/automation/engine/main/hub/persisted/postgres-workflow-repository.test.ts`
- Modify: `apps/main-2.0/src/automation/engine/main/hub/agent-hub.ts`
- Modify: `apps/main-2.0/src/main/services/automation-service.ts`
- Modify: `apps/main-2.0/src/main/ipc/automation.ts`
- Modify: `apps/main-2.0/src/shared/ipc/automation.ts`
- Replace: `apps/main-2.0/src/automation/engine/renderer/src/app/services/workflow-service.ts`

- [ ] **Step 1: Write failing schema/repository tests**

Assert fresh definition/run/artifact tables, complete JSON output persistence, frozen definitions, running-to-failed startup convergence, and deletion of only legacy Workflow tables/rows.

- [ ] **Step 2: Replace the Workflow schema**

Create one guarded migration that removes legacy Workflow-only tables in dependency order and creates `workflows`, `workflow_runs`, `workflow_node_runs`, and `workflow_artifacts` with JSONB definition/input/output columns. Preserve all non-Workflow tables.

- [ ] **Step 3: Replace repository mapping**

Expose `listDefinitions`, `getDefinition`, `saveDefinition`, `deleteDefinition`, `listRuns`, `getRun`, `saveRun`, and `markInterruptedRunsFailed`. Each node transition writes the run and node row in one transaction.

- [ ] **Step 4: Replace host operations and IPC**

Reduce Workflow IPC to create/update/delete/select, generate definition, start/cancel/retry run, resolve Approval, list runs, and open file output. Validate request bodies with Zod and return the new contracts directly.

- [ ] **Step 5: Run persistence and service tests and commit**

Run: `npm test -- --run src/core/postgres/schema.test.ts src/automation/engine/main/hub/persisted/postgres-workflow-repository.test.ts src/main/services/automation-service.test.ts`

Expected: PASS.

```bash
git add apps/main-2.0/src/core/postgres apps/main-2.0/src/automation/engine/main/hub apps/main-2.0/src/main apps/main-2.0/src/shared/ipc apps/main-2.0/src/automation/engine/renderer/src/app/services/workflow-service.ts
git commit -m "feat(workflow): replace persistence and IPC"
```

### Task 5: Replace the Workflow renderer

**Files:**
- Replace: `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/WorkflowPage.tsx`
- Replace: `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/WorkflowCanvasBoard.tsx`
- Create: `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/WorkflowNodeInspector.tsx`
- Create: `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/WorkflowOutputFieldEditor.tsx`
- Create: `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/WorkflowRunInspector.tsx`
- Replace: `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/workflow-controller.ts`
- Replace: `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/hooks/useWorkflowFeatureController.ts`
- Modify: `apps/main-2.0/src/renderer/src/styles/automation-upstream/part-06.css`
- Test: `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/WorkflowNodeInspector.test.tsx`
- Test: `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/WorkflowRunInspector.test.tsx`

- [ ] **Step 1: Write failing renderer tests**

Assert separate property editors, recursive output field editing capped at two levels, graph edges derived from node inputs, Definition/Current Run switching, complete list/object output expansion, and field-path validation errors.

- [ ] **Step 2: Replace controller state**

Expose the selected `WorkflowDefinition`, selected `WorkflowRun`, configured Agents, validation issues, selection callbacks, CRUD callbacks, and run actions. Remove review feature flags, conversations, plans, context documents, receipts, recovery, and intervention callbacks.

- [ ] **Step 3: Build the structured inspector**

Render Basic, Inputs, Execution, Outputs, and Completion Criteria sections. Use type-specific panels for Agent, Script, Review, and Approval. Never expose raw Prompt or raw JSON.

- [ ] **Step 4: Build the run inspector**

Render resolved inputs and complete outputs by declared schema. Lists show count plus expandable items, objects show named children, and file fields use existing safe preview/reveal APIs.

- [ ] **Step 5: Replace the page and styles**

Keep sidebar/canvas/inspector layout, add Definition/Current Run toggle, and simplify cards to type/title/input count/output count/executor/status.

- [ ] **Step 6: Run renderer tests and commit**

Run: `npm test -- --run src/automation/engine/renderer/src/pages/workflow`

Expected: PASS.

```bash
git add apps/main-2.0/src/automation/engine/renderer/src/pages/workflow apps/main-2.0/src/renderer/src/styles/automation-upstream/part-06.css
git commit -m "feat(workflow): replace workflow editor and run UI"
```

### Task 6: Convert bundled Workflows and generation

**Files:**
- Replace: `apps/main-2.0/src/automation/engine/shared/bundled-workflows/*/workflow.json`
- Replace: `apps/main-2.0/assets/automation/bundled-workflows/*/workflow.json`
- Replace: `apps/main-2.0/src/automation/engine/shared/workflow-agent.ts`
- Modify: `apps/main-2.0/src/automation/engine/main/workflows/bundled-workflows.ts`
- Replace: `apps/main-2.0/src/automation/engine/shared/bundled-workflows/bundled-workflows-review.test.ts`

- [ ] **Step 1: Write failing bundled-definition tests**

Require every bundled definition to match its packaged asset, pass new validation, use descriptive named outputs, contain no `result` output key, and contain no V2-only property.

- [ ] **Step 2: Replace generation instructions and parser**

Ask the Manager Agent for exactly one `WorkflowDefinition`, parse it, validate it, send validation paths for one repair attempt, and reject invalid drafts without persistence.

- [ ] **Step 3: Convert all bundled definitions**

Represent Review as explicit nodes, make every upstream dependency a field reference, and give every output field a user-facing name and description.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- --run src/automation/engine/shared/bundled-workflows src/automation/engine/shared/workflow-agent.test.ts`

Expected: PASS.

```bash
git add apps/main-2.0/src/automation/engine/shared/bundled-workflows apps/main-2.0/assets/automation/bundled-workflows apps/main-2.0/src/automation/engine/shared/workflow-agent.ts apps/main-2.0/src/automation/engine/main/workflows/bundled-workflows.ts
git commit -m "feat(workflow): convert generation and bundled workflows"
```

### Task 7: Delete Workflow V2 and verify the product

**Files:**
- Delete: `apps/main-2.0/src/automation/engine/shared/workflow-v2/`
- Delete: `apps/main-2.0/src/automation/engine/main/workflows/v2/`
- Delete: obsolete Workflow V2 renderer components under `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/`
- Delete: obsolete Workflow V2 tests and compatibility exports
- Replace: `.release-notes/improve-resume-workflow-handoffs.md`

- [ ] **Step 1: Remove all old imports and code paths**

Run `rg -n "WorkflowV2|workflow-v2|Review Gate|Task Packet|workflowV2" apps/main-2.0/src` and remove every Workflow implementation reference. Product copy may mention neither V2 nor legacy internals.

- [ ] **Step 2: Delete obsolete modules**

Delete old planning, packet, transaction, recovery, hook, conversation, review-gate, old drawer, and old run-center code only after all imports have moved to the new model.

- [ ] **Step 3: Write the final user-facing release note**

Use one `## 新增功能` bullet describing the redesigned structured Workflow editor, named outputs, explicit Review/Approval nodes, and complete result viewing. Do not mention migration, V2, database, code deletion, or branches.

- [ ] **Step 4: Run complete verification**

Run:

```bash
cd apps/main-2.0
npm run typecheck
npm test
npm run build
npm run release-note:check
```

Expected: all commands exit 0. Ensure no Electron or test child process remains.

- [ ] **Step 5: Commit final cleanup**

```bash
git add -A apps/main-2.0 .release-notes/improve-resume-workflow-handoffs.md
git commit -m "refactor(workflow): remove legacy workflow engine"
```
