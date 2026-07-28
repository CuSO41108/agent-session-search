import { describe, expect, it } from "vitest";
import {
  extractFallbackKeywords,
  isLocalCliEndpoint,
  runAiAssistantFallback,
  runAiAssistantTurn,
  type AiChatMessage,
  type FallbackSessionHit,
  type SummaryEndpoint,
  type ToolChatCompletionFn,
  type ToolExecutor,
} from "./ai-assistant";

const endpoint: SummaryEndpoint = { baseUrl: "http://x", model: "m", apiKey: "k", apiFormat: "openai_chat" };
const codexEndpoint: SummaryEndpoint = { baseUrl: "", model: "codex", apiKey: "", apiFormat: "codex_exec", command: "codex" };

describe("runAiAssistantTurn", () => {
  it("executes a tool call, feeds the result back, and returns the final reply with surfaced sessionKeys", async () => {
    // Round 1: model asks to search. Round 2: model answers in plain text.
    const chatTurns: Array<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }> = [
      { content: "", toolCalls: [{ id: "c1", name: "search_sessions", arguments: JSON.stringify({ query: "sqlite migration" }) }] },
      { content: "Found the session where you fixed the SQLite migration.", toolCalls: [] },
    ];
    const sentMessages: AiChatMessage[][] = [];
    const chat: ToolChatCompletionFn = async (_endpoint, messages) => {
      sentMessages.push(messages);
      return chatTurns.shift()!;
    };

    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const executeTool: ToolExecutor = async (name, args) => {
      executed.push({ name, args });
      return {
        result: [{ sessionKey: "sess-42", title: "Fix migration" }],
        sessionKeys: ["sess-42"],
      };
    };

    const result = await runAiAssistantTurn(endpoint, [{ role: "user", content: "find my sqlite migration fix" }], executeTool, {
      chat,
    });

    expect(executed).toEqual([{ name: "search_sessions", args: { query: "sqlite migration" } }]);
    expect(result.reply).toBe("Found the session where you fixed the SQLite migration.");
    expect(result.sessionKeys).toEqual(["sess-42"]);
    // The second LLM call must include the tool result so the model can answer.
    const secondCall = sentMessages[1];
    expect(secondCall.some((m) => m.role === "tool" && m.content.includes("sess-42"))).toBe(true);
  });

  it("dedupes sessionKeys surfaced across multiple tool calls", async () => {
    const chatTurns: Array<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }> = [
      {
        content: "",
        toolCalls: [
          { id: "a", name: "search_sessions", arguments: JSON.stringify({ query: "auth" }) },
          { id: "b", name: "get_session", arguments: JSON.stringify({ sessionKey: "dup" }) },
        ],
      },
      { content: "done", toolCalls: [] },
    ];
    const chat: ToolChatCompletionFn = async () => chatTurns.shift()!;
    const executeTool: ToolExecutor = async (name) => ({
      result: {},
      sessionKeys: name === "search_sessions" ? ["dup", "other"] : ["dup"],
    });

    const result = await runAiAssistantTurn(endpoint, [{ role: "user", content: "x" }], executeTool, { chat });
    expect(result.sessionKeys).toEqual(["dup", "other"]);
  });

  it("captures a tool execution error and still completes", async () => {
    const chatTurns: Array<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }> = [
      { content: "", toolCalls: [{ id: "c1", name: "search_sessions", arguments: "{}" }] },
      { content: "I hit an error but here is what I can say.", toolCalls: [] },
    ];
    const captured: AiChatMessage[][] = [];
    const chat: ToolChatCompletionFn = async (_e, messages) => {
      captured.push(messages);
      return chatTurns.shift()!;
    };
    const executeTool: ToolExecutor = async () => {
      throw new Error("db is locked");
    };

    const result = await runAiAssistantTurn(endpoint, [{ role: "user", content: "x" }], executeTool, { chat });
    expect(result.reply).toBe("I hit an error but here is what I can say.");
    const toolMsg = captured[1].find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("db is locked");
  });
});

describe("isLocalCliEndpoint", () => {
  it("flags codex_exec and claude_exec, not HTTP formats", () => {
    expect(isLocalCliEndpoint(codexEndpoint)).toBe(true);
    expect(isLocalCliEndpoint({ ...codexEndpoint, apiFormat: "claude_exec" })).toBe(true);
    expect(isLocalCliEndpoint(endpoint)).toBe(false);
    expect(isLocalCliEndpoint({ ...endpoint, apiFormat: "anthropic" })).toBe(false);
  });
});

describe("extractFallbackKeywords", () => {
  it("distills the user's request into keywords via one CLI call", async () => {
    let extractionPrompt = "";
    const complete = async (_e: SummaryEndpoint, messages: { role: string; content: string }[]) => {
      extractionPrompt = messages.map((m) => m.content).join("\n");
      return "sqlite migration fix\n";
    };
    const keywords = await extractFallbackKeywords(
      codexEndpoint,
      [{ role: "user", content: "find my sqlite migration fix" }],
      complete,
    );
    expect(keywords).toBe("sqlite migration fix");
    expect(extractionPrompt).toContain("find my sqlite migration fix");
  });

  it("strips quotes and collapses whitespace, keeping only the first line", async () => {
    const complete = async () => `  "sqlite   migration"  \nignored second line`;
    const keywords = await extractFallbackKeywords(codexEndpoint, [{ role: "user", content: "x" }], complete);
    expect(keywords).toBe("sqlite migration");
  });

  it("falls back to the verbatim request when extraction throws", async () => {
    const complete = async () => {
      throw new Error("cli crashed");
    };
    const keywords = await extractFallbackKeywords(
      codexEndpoint,
      [{ role: "user", content: "the auth refactor" }],
      complete,
    );
    expect(keywords).toBe("the auth refactor");
  });

  it("falls back to the verbatim request when extraction returns empty", async () => {
    const complete = async () => "   \n  ";
    const keywords = await extractFallbackKeywords(codexEndpoint, [{ role: "user", content: "the auth refactor" }], complete);
    expect(keywords).toBe("the auth refactor");
  });
});

// Helper: a fake `complete` that returns extraction keywords (when the system
// prompt is the keyword-extraction one) vs a grounding reply otherwise.
function makeFakeComplete(extraction: () => string, grounding: (prompt: string) => string) {
  let groundingPrompt = "";
  const complete = async (_e: SummaryEndpoint, messages: { role: string; content: string }[]) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const isExtraction = system.includes("convert a developer's natural-language request into search keywords");
    if (isExtraction) return extraction();
    groundingPrompt = messages.map((m) => m.content).join("\n");
    return grounding(groundingPrompt);
  };
  return { complete, getGroundingPrompt: () => groundingPrompt };
}

describe("runAiAssistantFallback", () => {
  it("extracts keywords, searches with them, and grounds the CLI answer over the hits", async () => {
    const hits: FallbackSessionHit[] = [
      { sessionKey: "s1", title: "Fix SQLite migration", source: "claude-cli", project: "/p", summary: "fixed it" },
      { sessionKey: "s2", title: "Other", source: "codex-cli", project: "/q", summary: null },
    ];
    let searchedQuery = "";
    const search = async (query: string): Promise<FallbackSessionHit[]> => {
      searchedQuery = query;
      return hits;
    };
    const { complete, getGroundingPrompt } = makeFakeComplete(
      () => "sqlite migration",
      () => "The first session matches best.",
    );

    const history: AiChatMessage[] = [{ role: "user", content: "find my sqlite migration fix" }];
    const result = await runAiAssistantFallback(codexEndpoint, history, search, { complete });

    expect(searchedQuery).toBe("sqlite migration");
    expect(result.reply).toBe("The first session matches best.");
    expect(result.sessionKeys).toEqual(["s1", "s2"]);
    // The grounding prompt keeps the original request and the candidate catalog.
    const groundingPrompt = getGroundingPrompt();
    expect(groundingPrompt).toContain("find my sqlite migration fix");
    expect(groundingPrompt).toContain("Fix SQLite migration");
    expect(groundingPrompt).toContain("[1]");
  });

  it("retries with different keywords when the first search misses, then succeeds", async () => {
    const queries: string[] = [];
    const search = async (query: string): Promise<FallbackSessionHit[]> => {
      queries.push(query);
      // First keyword set misses; the second one hits.
      return query === "second try"
        ? [{ sessionKey: "s9", title: "Found it", source: "codex-cli", project: "/p", summary: null }]
        : [];
    };
    let extractionCalls = 0;
    const extractionPrompts: string[] = [];
    const complete = async (_e: SummaryEndpoint, messages: { role: string; content: string }[]) => {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("convert a developer's natural-language request into search keywords")) {
        extractionCalls += 1;
        extractionPrompts.push(messages.find((m) => m.role === "user")?.content ?? "");
        return extractionCalls === 1 ? "first try" : "second try";
      }
      return "Found the session you wanted.";
    };

    const result = await runAiAssistantFallback(
      codexEndpoint,
      [{ role: "user", content: "find that thing" }],
      search,
      { complete },
    );

    expect(queries).toEqual(["first try", "second try"]);
    expect(result.sessionKeys).toEqual(["s9"]);
    // The retry's extraction prompt must mention the keyword set that missed.
    expect(extractionPrompts[1]).toContain("first try");
    expect(extractionPrompts[1]).toContain("NO results");
  });

  it("stops retrying once a keyword set repeats", async () => {
    const queries: string[] = [];
    const search = async (query: string): Promise<FallbackSessionHit[]> => {
      queries.push(query);
      return [];
    };
    // Extraction always returns the same keywords -> loop must bail after one search.
    const { complete } = makeFakeComplete(
      () => "same keywords",
      () => "Nothing found.",
    );

    const result = await runAiAssistantFallback(
      codexEndpoint,
      [{ role: "user", content: "x" }],
      search,
      { complete },
    );

    expect(queries).toEqual(["same keywords"]);
    expect(result.sessionKeys).toEqual([]);
  });

  it("tells the CLI when nothing matched after all attempts", async () => {
    const search = async (): Promise<FallbackSessionHit[]> => [];
    let extractionCalls = 0;
    const { complete, getGroundingPrompt } = makeFakeComplete(
      () => `attempt-${++extractionCalls}`,
      () => "No matching sessions; try other keywords.",
    );

    const result = await runAiAssistantFallback(
      codexEndpoint,
      [{ role: "user", content: "nonexistent topic" }],
      search,
      { complete },
    );

    expect(result.sessionKeys).toEqual([]);
    // It exhausts the round budget and reports the keyword sets it tried.
    expect(extractionCalls).toBe(3);
    expect(getGroundingPrompt()).toContain("No sessions matched");
  });
});
