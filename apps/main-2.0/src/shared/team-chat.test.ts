import { describe, expect, it } from "vitest";
import {
  parseTeamChatMentions,
  removeMentionFromText,
  resolveMentionedMemberIds,
} from "./team-chat";

function member(agentId: string, displayName: string): { agentId: string; displayName: string } {
  return { agentId, displayName };
}

const members = [
  member("member-1", "Codex"),
  member("member-2", "Codex2"),
  member("member-3", "Front End Dev"),
  member("member-4", "C++ Dev"),
];

describe("parseTeamChatMentions", () => {
  it("returns no mentions for text without an @", () => {
    expect(parseTeamChatMentions("ship the release", members)).toEqual([]);
  });

  it("resolves a simple mention with its text range", () => {
    expect(parseTeamChatMentions("@Codex please review", members)).toEqual([
      { memberId: "member-1", start: 0, end: 6 },
    ]);
  });

  it("prefers the longest matching display name", () => {
    expect(resolveMentionedMemberIds("@Codex2 take this", members)).toEqual(["member-2"]);
  });

  it("resolves display names containing spaces", () => {
    expect(resolveMentionedMemberIds("@Front End Dev build the page", members))
      .toEqual(["member-3"]);
  });

  it("treats regex metacharacters in a display name as literals", () => {
    expect(resolveMentionedMemberIds("@C++ Dev optimize it", members)).toEqual(["member-4"]);
  });

  it("ignores an @ embedded in a word such as an email address", () => {
    expect(resolveMentionedMemberIds("mail codex@Codex.dev instead", members)).toEqual([]);
  });

  it("ignores a name that is only a prefix of a longer word", () => {
    expect(resolveMentionedMemberIds("@Codexington is not a member", members)).toEqual([]);
  });

  it("resolves several distinct mentions in one message", () => {
    expect(resolveMentionedMemberIds("@Codex and @Front End Dev sync up", members))
      .toEqual(["member-1", "member-3"]);
  });

  it("deduplicates a member mentioned more than once", () => {
    expect(resolveMentionedMemberIds("@Codex ping @Codex again", members)).toEqual(["member-1"]);
  });

  it("matches display names case-insensitively", () => {
    expect(resolveMentionedMemberIds("@codex review", members)).toEqual(["member-1"]);
  });

  it("resolves a mention followed by punctuation", () => {
    expect(resolveMentionedMemberIds("@Codex, please review", members)).toEqual(["member-1"]);
  });

  it("resolves a mention at the very end of the message", () => {
    expect(resolveMentionedMemberIds("over to you @Codex", members)).toEqual(["member-1"]);
  });

  it("ignores members whose display name is blank", () => {
    expect(resolveMentionedMemberIds("@ nobody", [member("member-9", "   ")])).toEqual([]);
  });

  it("returns no mentions when the room has no members", () => {
    expect(parseTeamChatMentions("@Codex hello", [])).toEqual([]);
  });
});

describe("removeMentionFromText", () => {
  function remove(content: string): { text: string; cursor: number } {
    const mention = parseTeamChatMentions(content, members)[0];
    if (!mention) throw new Error(`no mention found in ${content}`);
    return removeMentionFromText(content, mention);
  }

  it("preserves blank lines elsewhere in the draft", () => {
    expect(remove("Line1\n\nLine2 @Codex tail").text).toBe("Line1\n\nLine2 tail");
  });

  it("preserves leading indentation", () => {
    expect(remove("  indented @Codex x").text).toBe("  indented x");
  });

  it("leaves a single space when removing a mention between two words", () => {
    expect(remove("hi @Codex there").text).toBe("hi there");
  });

  it("keeps the surrounding newlines when the mention is on its own line", () => {
    expect(remove("a\n@Codex\nb").text).toBe("a\n\nb");
  });

  it("reports a cursor inside the remaining text", () => {
    const { text, cursor } = remove("hi @Codex there");
    expect(cursor).toBe(3);
    expect(cursor).toBeLessThanOrEqual(text.length);
  });
});
