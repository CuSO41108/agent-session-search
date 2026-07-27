# AI Skill Deep Exploration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI Skill exploration read a diverse pool of at most 12 real Skill details, choose the best 5, and show a grounded description and match reason for every recommendation.

**Architecture:** Keep the existing one-shot Runtime integration and turn the domain workflow into two model phases. The first phase generates search queries; the app searches and reads bounded candidate details in parallel; the second phase ranks only those candidates and returns validated structured recommendations. Existing IPC and import flows remain unchanged apart from the richer result type.

**Tech Stack:** TypeScript, Electron IPC, React, Vitest, existing `SkillsShClient`, existing configured Runtime execution stack.

---

## File Map

- `src/core/skill-ai-search.ts`: two-stage exploration orchestration, candidate diversity, prompt construction, output parsing, and result types.
- `src/core/skill-ai-search.test.ts`: observable domain behavior for parallel search/detail work, ranking validation, truncation, and partial results.
- `src/main/services/skill-service.ts`: provide `SkillsShClient.getDetail` to the domain workflow and retain final candidates for preview/import.
- `src/main/services/skill-service.test.ts`: verify two Runtime calls and the search/detail service wiring.
- `src/renderer/src/features/skills/skill-discovery-dialog.tsx`: render recommendation descriptions and match reasons.
- `src/renderer/src/skills-page.test.ts`: verify the richer AI result contract is represented by the Skill discovery UI source.
- `.release-notes/ai-skill-deep-exploration.md`: one user-facing bug-fix note for this branch.

### Task 1: Build the two-stage exploration domain

**Files:**
- Modify: `src/core/skill-ai-search.ts`
- Test: `src/core/skill-ai-search.test.ts`

- [ ] **Step 1: Replace the old one-call test with a failing two-stage workflow test**

Add a test that records both prompts, returns query planning JSON on the first completion, returns recommendations on the second completion, and proves details are read before recommendations are accepted:

```ts
it("searches diverse candidates, reads their details, and asks AI to choose grounded recommendations", async () => {
  const complete = vi.fn(async (prompt: string) => complete.mock.calls.length === 1
    ? JSON.stringify({
        queries: ["react accessibility", "frontend a11y"],
        interpretation: "寻找 React 无障碍检查 Skill。",
      })
    : JSON.stringify({
        recommendations: [
          {
            id: "one/repo/shared",
            description: "检查 React 组件的 ARIA、语义标签和键盘交互。",
            reason: "直接覆盖用户需要的 React 无障碍检查。",
          },
          {
            id: "one/repo/a",
            description: "提供前端可访问性审查清单。",
            reason: "适合补充页面级检查。",
          },
        ],
      }));
  const search = vi.fn(async (query: string) => query === "react accessibility"
    ? page([entry("one/repo/a", 20), entry("one/repo/shared", 5)])
    : page([entry("one/repo/shared", 5), entry("two/repo/c", 200)]));
  const readDetail = vi.fn(async (skill: SkillsShEntry) => ({
    entry: skill,
    hash: `hash-${skill.id}`,
    markdown: `# ${skill.name}\n\nGrounded content for ${skill.id}`,
    files: [],
    stale: false,
  }));

  const result = await runSkillAiSearch(
    { query: "帮我检查 React 页面无障碍问题", language: "zh" },
    search,
    readDetail,
    complete,
  );

  expect(complete).toHaveBeenCalledTimes(2);
  expect(readDetail).toHaveBeenCalledTimes(3);
  expect(complete.mock.calls[1]![0]).toContain("Grounded content for one/repo/shared");
  expect(result.skills).toEqual([
    expect.objectContaining({
      id: "one/repo/shared",
      description: "检查 React 组件的 ARIA、语义标签和键盘交互。",
      reason: "直接覆盖用户需要的 React 无障碍检查。",
    }),
    expect.objectContaining({
      id: "one/repo/a",
      description: "提供前端可访问性审查清单。",
      reason: "适合补充页面级检查。",
    }),
  ]);
});
```

- [ ] **Step 2: Add failing edge-case tests**

Cover these exact behaviors:

```ts
it("round-robins query results and caps detail reads at twelve", async () => {
  // Build three pages with six unique entries each.
  // Assert readDetail receives exactly 12 entries and each query contributes entries.
});

it("truncates each Skill markdown before the review model call", async () => {
  // Return "x".repeat(7_000) and assert the second prompt excludes a unique suffix after character 6_000.
});

it("keeps successful detail reads and marks the result partial", async () => {
  // Reject one detail, recommend five successful IDs, and expect partial: true.
});

it("rejects a recommendation for a Skill that was not read", async () => {
  // Return an unknown id from the second completion and expect a grounded-candidate error.
});

it("deduplicates recommendations and accepts at most five", async () => {
  // Return duplicate IDs plus more than five valid IDs and expect five unique results.
});
```

- [ ] **Step 3: Run the focused domain test and verify RED**

Run:

```bash
npx vitest run src/core/skill-ai-search.test.ts
```

Expected: FAIL because `runSkillAiSearch` does not accept `readDetail`, performs only one completion, and `SkillAiSearchResult.skills` has no `description` or `reason`.

- [ ] **Step 4: Add recommendation types and strict parsing**

Extend the result types:

```ts
export interface SkillAiRecommendation {
  id: string;
  description: string;
  reason: string;
}

export interface SkillAiSearchMatch extends SkillsShEntry {
  description: string;
  reason: string;
}

export interface SkillAiSearchResult extends SkillAiSearchPlan {
  originalQuery: string;
  skills: SkillAiSearchMatch[];
  total: number;
  stale: boolean;
  partial: boolean;
}
```

Add a parser that extracts the JSON object, requires a `recommendations` array, normalizes whitespace, rejects IDs outside the successfully read candidate set, deduplicates IDs, limits output to five, limits `description` and `reason` to 300 characters, and throws when no valid recommendation remains:

```ts
function parseSkillAiRecommendations(
  content: string,
  allowedIds: Set<string>,
): SkillAiRecommendation[] {
  const payload = parseJsonObject(content, "AI Skill review did not return valid recommendations.");
  if (!Array.isArray(payload.recommendations)) throw invalidRecommendationError();
  const seen = new Set<string>();
  const recommendations: SkillAiRecommendation[] = [];
  for (const value of payload.recommendations) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const id = normalizedText(record.id, 512);
    if (!allowedIds.has(id)) throw new Error(`AI Skill review returned an unread candidate: ${id || "(empty)"}.`);
    if (seen.has(id)) continue;
    const description = normalizedText(record.description, 300);
    const reason = normalizedText(record.reason, 300);
    if (!description || !reason) continue;
    seen.add(id);
    recommendations.push({ id, description, reason });
    if (recommendations.length === 5) break;
  }
  if (recommendations.length === 0) throw invalidRecommendationError();
  return recommendations;
}
```

- [ ] **Step 5: Implement diverse candidate selection**

Retain successful query pages with their query index. Select candidates by walking result position first and query index second, deduplicating by Skill ID, until 12 entries are collected:

```ts
function selectCandidates(
  pages: Array<{ queryIndex: number; page: SkillsShPage }>,
): SkillsShEntry[] {
  const byQuery = [...pages].sort((left, right) => left.queryIndex - right.queryIndex);
  const selected: SkillsShEntry[] = [];
  const seen = new Set<string>();
  const longestPage = Math.max(0, ...byQuery.map(({ page }) => page.skills.length));
  for (let resultIndex = 0; resultIndex < longestPage && selected.length < 12; resultIndex += 1) {
    for (const { page } of byQuery) {
      const skill = page.skills[resultIndex];
      if (!skill || seen.has(skill.id)) continue;
      seen.add(skill.id);
      selected.push(skill);
      if (selected.length === 12) break;
    }
  }
  return selected;
}
```

- [ ] **Step 6: Implement parallel details and the second model phase**

Change `runSkillAiSearch` to accept:

```ts
readDetail: (skill: SkillsShEntry) => Promise<SkillsShDetail>
```

After parallel searches:

```ts
const candidates = selectCandidates(successful);
const detailSettled = await Promise.allSettled(
  candidates.map(async (skill) => ({ skill, detail: await readDetail(skill) })),
);
const readable = detailSettled.flatMap((result) =>
  result.status === "fulfilled" ? [result.value] : []);
if (readable.length === 0) throw new Error("Could not read any candidate Skill details.");

const reviewContent = await complete(buildReviewPrompt(input, plan, readable));
const recommendations = parseSkillAiRecommendations(
  reviewContent,
  new Set(readable.map(({ skill }) => skill.id)),
);
const candidateById = new Map(readable.map(({ skill }) => [skill.id, skill]));
const skills = recommendations.map((recommendation) => ({
  ...candidateById.get(recommendation.id)!,
  description: recommendation.description,
  reason: recommendation.reason,
}));
```

Build the review prompt from original request, language, planned queries, and candidate blocks. Slice each `detail.markdown` to 6,000 characters before joining. Set `partial` when any search failed, any detail failed, fewer than five readable candidates exist, or fewer than five recommendations were returned. Set `stale` when any successful search page or readable detail is stale.

- [ ] **Step 7: Run the focused domain test and verify GREEN**

Run:

```bash
npx vitest run src/core/skill-ai-search.test.ts
```

Expected: all `skill-ai-search` tests PASS.

- [ ] **Step 8: Commit the domain change**

```bash
git add src/core/skill-ai-search.ts src/core/skill-ai-search.test.ts
git commit -m "feat(skills): rank grounded AI recommendations"
```

### Task 2: Wire detail reading through SkillService

**Files:**
- Modify: `src/main/services/skill-service.ts`
- Test: `src/main/services/skill-service.test.ts`

- [ ] **Step 1: Update the service test to require two Runtime calls and detail reads**

Change the harness completion mock to return planning JSON on its first call and recommendation JSON on its second call:

```ts
const executeAiSearch = vi.fn(async () => executeAiSearch.mock.calls.length === 1
  ? JSON.stringify({
      queries: ["code review"],
      interpretation: "寻找代码审查 Skill。",
    })
  : JSON.stringify({
      recommendations: [{
        id: discoveredEntry.id,
        description: "审查代码变更并发现质量问题。",
        reason: "直接匹配代码审查需求。",
      }],
    }));
```

In the exploration test, assert:

```ts
expect(harness.executeAiSearch).toHaveBeenCalledTimes(2);
expect(harness.skillsShClient.getDetail).toHaveBeenCalledWith(harness.discoveredEntry);
expect(result.skills[0]).toMatchObject({
  id: harness.discoveredEntry.id,
  description: "审查代码变更并发现质量问题。",
  reason: "直接匹配代码审查需求。",
});
```

- [ ] **Step 2: Run the focused service test and verify RED**

Run:

```bash
npx vitest run src/main/services/skill-service.test.ts
```

Expected: FAIL because `SkillService.aiSearchDiscoveredSkills` does not pass `getDetail` into the domain workflow.

- [ ] **Step 3: Pass the existing detail client into the domain workflow**

Update the call in `aiSearchDiscoveredSkills`:

```ts
const result = await runSkillAiSearch(
  input,
  (query) => client.list({ page: 0, query }),
  (skill) => client.getDetail(skill),
  (prompt) => this.dependencies.executeAiSearch!(
    this.dependencies.getSettings().skillAiRuntimeId,
    prompt,
  ),
);
```

Keep caching every final result entry in `discoveredSkills`, so the existing preview and import paths can resolve it and reuse the `SkillsShClient` detail cache.

- [ ] **Step 4: Run service and domain tests and verify GREEN**

Run:

```bash
npx vitest run src/main/services/skill-service.test.ts src/core/skill-ai-search.test.ts
```

Expected: both files PASS.

- [ ] **Step 5: Commit the service wiring**

```bash
git add src/main/services/skill-service.ts src/main/services/skill-service.test.ts
git commit -m "feat(skills): read candidates during AI exploration"
```

### Task 3: Show grounded descriptions and reasons in the Skill UI

**Files:**
- Modify: `src/renderer/src/features/skills/skill-discovery-dialog.tsx`
- Test: `src/renderer/src/skills-page.test.ts`

- [ ] **Step 1: Add a failing UI source test**

Import `readFileSync` and load the component source:

```ts
import { readFileSync } from "node:fs";

const discoveryDialogSource = readFileSync(
  new URL("./features/skills/skill-discovery-dialog.tsx", import.meta.url),
  "utf8",
);
```

Add source assertions that protect both fields:

```ts
it("shows grounded AI descriptions and match reasons", () => {
  expect(discoveryDialogSource).toContain("skill.description");
  expect(discoveryDialogSource).toContain("selectedAiMatch?.reason");
  expect(discoveryDialogSource).toContain("Why it matches");
  expect(discoveryDialogSource).toContain("匹配原因");
});
```

- [ ] **Step 2: Run the focused UI test and verify RED**

Run:

```bash
npx vitest run src/renderer/src/skills-page.test.ts
```

Expected: FAIL because the discovery list and detail panel do not render recommendation fields.

- [ ] **Step 3: Render descriptions in result rows**

Derive the selected AI match:

```ts
const selectedAiMatch = searchMode === "ai"
  ? aiResult?.skills.find((skill) => skill.id === selectedId) ?? null
  : null;
```

Within each result button, add the description only for AI results:

```tsx
<span>
  <strong>{skill.name}</strong>
  <small>{skill.source}</small>
  {"description" in skill && skill.description
    ? <small className="skill-discovery-description">{skill.description}</small>
    : null}
</span>
```

- [ ] **Step 4: Render the selected match reason above markdown**

In the detail panel, before the existing markdown:

```tsx
{selectedAiMatch ? (
  <div className="skill-discovery-match-reason">
    <strong>{l("Why it matches", "匹配原因")}</strong>
    <p>{selectedAiMatch.reason}</p>
  </div>
) : null}
```

Use existing typography and panel spacing classes where possible; add only focused CSS in `src/renderer/src/styles/skills-page.css` if the existing styles do not preserve readable wrapping.

- [ ] **Step 5: Run the focused UI and type tests**

Run:

```bash
npx vitest run src/renderer/src/skills-page.test.ts
npm run typecheck
```

Expected: renderer tests PASS and TypeScript reports no errors.

- [ ] **Step 6: Commit the UI change**

```bash
git add src/renderer/src/features/skills/skill-discovery-dialog.tsx src/renderer/src/styles/skills-page.css src/renderer/src/skills-page.test.ts
git commit -m "feat(skills): explain AI recommendations"
```

### Task 4: Release note and complete verification

**Files:**
- Create: `.release-notes/ai-skill-deep-exploration.md`
- Modify only if verification exposes a defect: files already listed above.

- [ ] **Step 1: Add exactly one user-facing bug-fix note**

Create:

```markdown
# AI Skill 探索结果更可靠

## Bug 修复

- AI Skill 探索现在会阅读多个真实候选后选出最匹配的前 5 个，并为每个结果展示功能描述和匹配理由。
```

- [ ] **Step 2: Run focused regression tests**

Run:

```bash
npx vitest run src/core/skill-ai-search.test.ts src/main/services/skill-service.test.ts src/renderer/src/skills-page.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 3: Run repository verification**

Run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: typecheck exits 0; all Vitest and script tests pass; production build exits 0; diff check prints nothing.

- [ ] **Step 4: Validate the release note against the feature base**

Run:

```bash
npm run release-note:check -- main-2.0 HEAD
```

Expected: exactly `.release-notes/ai-skill-deep-exploration.md` is reported with one bug fix.

- [ ] **Step 5: Commit the release note and any verification fixes**

```bash
git add .release-notes/ai-skill-deep-exploration.md
git commit -m "docs: note grounded AI skill exploration"
```

- [ ] **Step 6: Confirm the branch is clean**

Run:

```bash
git status --short --branch
git log --oneline main-2.0..HEAD
```

Expected: a clean `feat/ai-skill-deep-exploration` worktree and the design, plan, implementation, UI, and release-note commits listed above.
