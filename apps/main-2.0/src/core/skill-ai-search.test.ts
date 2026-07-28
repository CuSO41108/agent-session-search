import { describe, expect, it, vi } from "vitest";
import { parseSkillAiSearchPlan, runSkillAiSearch } from "./skill-ai-search";
import type { SkillsShEntry, SkillsShPage } from "./skills-sh";

function entry(id: string, installs = 0): SkillsShEntry {
  const [owner, repo, skillId] = id.split("/");
  return {
    id,
    source: `${owner}/${repo}`,
    owner: owner!,
    repo: repo!,
    skillId: skillId!,
    name: skillId!,
    installs,
    url: `https://skills.sh/${id}`,
  };
}

function page(skills: SkillsShEntry[], stale = false): SkillsShPage {
  return { skills, total: skills.length, hasMore: false, page: 0, stale };
}

function detail(skill: SkillsShEntry, markdown = `# ${skill.name}`, stale = false) {
  return {
    entry: skill,
    hash: `hash-${skill.id}`,
    markdown,
    files: [],
    stale,
  };
}

describe("AI Skill search", () => {
  it("parses fenced plans, removes duplicate queries, and keeps the model explanation", () => {
    expect(parseSkillAiSearchPlan([
      "```json",
      JSON.stringify({
        queries: ["frontend design", " react ui ", "frontend design", "ignored fourth"],
        interpretation: "寻找能改善 React 界面设计质量的 Skill。",
      }),
      "```",
    ].join("\n"))).toEqual({
      queries: ["frontend design", "react ui", "ignored fourth"],
      interpretation: "寻找能改善 React 界面设计质量的 Skill。",
    });
  });

  it("searches diverse candidates, reads their details, and asks AI to choose grounded recommendations", async () => {
    const complete = vi.fn(async (prompt: string) => complete.mock.calls.length === 1
      ? JSON.stringify({
          queries: ["react accessibility", "frontend a11y"],
          interpretation: "寻找检查 React 无障碍问题的 Skill。",
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
      : page([entry("one/repo/shared", 5), entry("two/repo/c", 200)], true));
    const readDetail = vi.fn(async (skill: SkillsShEntry) => ({
      entry: skill,
      hash: `hash-${skill.id}`,
      markdown: `# ${skill.name}\n\nGrounded content for ${skill.id}`,
      files: [],
      stale: false,
    }));

    const result = await runSkillAiSearch({
      query: "我想找一个检查 React 页面无障碍问题的 skill",
      language: "zh",
    }, search, readDetail, complete);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.map(([query]) => query)).toEqual(["react accessibility", "frontend a11y"]);
    expect(readDetail).toHaveBeenCalledTimes(3);
    expect(complete.mock.calls[1]![0]).toContain("Grounded content for one/repo/shared");
    expect(result).toMatchObject({
      originalQuery: "我想找一个检查 React 页面无障碍问题的 skill",
      queries: ["react accessibility", "frontend a11y"],
      interpretation: "寻找检查 React 无障碍问题的 Skill。",
      stale: true,
      total: 2,
    });
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

  it("keeps successful query results when another planned search fails", async () => {
    const complete = vi.fn(async () => complete.mock.calls.length === 1
      ? JSON.stringify({
          queries: ["working query", "broken query"],
          interpretation: "Find a useful Skill.",
        })
      : JSON.stringify({
          recommendations: [{
            id: "one/repo/result",
            description: "Tests APIs.",
            reason: "Matches the request.",
          }],
        }));
    const search = vi.fn(async (query: string) => {
      if (query === "broken query") throw new Error("offline");
      return page([entry("one/repo/result", 10)]);
    });

    await expect(runSkillAiSearch(
      { query: "help me test APIs", language: "en" },
      search,
      async (skill) => detail(skill),
      complete,
    ))
      .resolves.toMatchObject({ total: 1, partial: true });
  });

  it("rejects an unusable model plan before searching the registry", async () => {
    const search = vi.fn();
    const readDetail = vi.fn();
    await expect(runSkillAiSearch(
      { query: "find something", language: "en" },
      search,
      readDetail,
      async () => "I need more information",
    )).rejects.toThrow("valid search queries");
    expect(search).not.toHaveBeenCalled();
    expect(readDetail).not.toHaveBeenCalled();
  });

  it("round-robins query results and caps detail reads at twelve", async () => {
    const queries = ["first", "second", "third"];
    const pages = new Map(queries.map((query) => [
      query,
      page(Array.from({ length: 6 }, (_, index) => entry(`one/repo/${query}-${index}`))),
    ]));
    const expectedIds = Array.from({ length: 4 }, (_, index) =>
      queries.map((query) => `one/repo/${query}-${index}`)).flat();
    const complete = vi.fn(async () => complete.mock.calls.length === 1
      ? JSON.stringify({ queries, interpretation: "Find review Skills." })
      : JSON.stringify({
          recommendations: expectedIds.slice(0, 5).map((id) => ({
            id,
            description: `Description for ${id}.`,
            reason: `Reason for ${id}.`,
          })),
        }));
    const readDetail = vi.fn(async (skill: SkillsShEntry) => detail(skill));

    await runSkillAiSearch(
      { query: "review my work", language: "en" },
      async (query) => pages.get(query)!,
      readDetail,
      complete,
    );

    expect(readDetail.mock.calls.map(([skill]) => skill.id)).toEqual(expectedIds);
  });

  it("truncates each Skill markdown before the review model call", async () => {
    const skill = entry("one/repo/long");
    const uniqueSuffix = "UNIQUE_SUFFIX_AFTER_LIMIT";
    const complete = vi.fn(async (prompt: string) => complete.mock.calls.length === 1
      ? JSON.stringify({ queries: ["long skill"], interpretation: "Find a Skill." })
      : JSON.stringify({
          recommendations: [{
            id: skill.id,
            description: "A long Skill.",
            reason: "It matches.",
          }],
        }));

    await runSkillAiSearch(
      { query: "find a long Skill", language: "en" },
      async () => page([skill]),
      async () => detail(skill, `${"x".repeat(6_000)}${uniqueSuffix}`),
      complete,
    );

    expect(complete.mock.calls[1]![0]).toContain("x".repeat(200));
    expect(complete.mock.calls[1]![0]).not.toContain(uniqueSuffix);
  });

  it("keeps successful detail reads and marks the result partial", async () => {
    const skills = Array.from({ length: 6 }, (_, index) => entry(`one/repo/result-${index}`));
    const successful = skills.slice(1);
    const complete = vi.fn(async () => complete.mock.calls.length === 1
      ? JSON.stringify({ queries: ["results"], interpretation: "Find results." })
      : JSON.stringify({
          recommendations: successful.map((skill) => ({
            id: skill.id,
            description: `Description ${skill.id}.`,
            reason: `Reason ${skill.id}.`,
          })),
        }));

    const result = await runSkillAiSearch(
      { query: "find results", language: "en" },
      async () => page(skills),
      async (skill) => {
        if (skill.id === skills[0]!.id) throw new Error("detail unavailable");
        return detail(skill);
      },
      complete,
    );

    expect(result).toMatchObject({ total: 5, partial: true });
    expect(result.skills.map((skill) => skill.id)).toEqual(successful.map((skill) => skill.id));
  });

  it("rejects a recommendation for a Skill that was not read", async () => {
    const skill = entry("one/repo/known");
    const complete = vi.fn(async () => complete.mock.calls.length === 1
      ? JSON.stringify({ queries: ["known"], interpretation: "Find known Skills." })
      : JSON.stringify({
          recommendations: [{
            id: "one/repo/invented",
            description: "Invented.",
            reason: "Not grounded.",
          }],
        }));

    await expect(runSkillAiSearch(
      { query: "find known Skills", language: "en" },
      async () => page([skill]),
      async () => detail(skill),
      complete,
    )).rejects.toThrow("unread candidate");
  });

  it("deduplicates recommendations and accepts at most five", async () => {
    const skills = Array.from({ length: 7 }, (_, index) => entry(`one/repo/result-${index}`));
    const recommendationIds = [skills[0]!.id, skills[0]!.id, ...skills.slice(1).map((skill) => skill.id)];
    const complete = vi.fn(async () => complete.mock.calls.length === 1
      ? JSON.stringify({ queries: ["results"], interpretation: "Find results." })
      : JSON.stringify({
          recommendations: recommendationIds.map((id) => ({
            id,
            description: `Description ${id}.`,
            reason: `Reason ${id}.`,
          })),
        }));

    const result = await runSkillAiSearch(
      { query: "find results", language: "en" },
      async () => page(skills),
      async (skill) => detail(skill),
      complete,
    );

    expect(result.skills.map((skill) => skill.id)).toEqual(skills.slice(0, 5).map((skill) => skill.id));
  });
});
