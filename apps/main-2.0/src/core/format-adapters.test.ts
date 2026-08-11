import { describe, expect, it } from "vitest";
import { codexAdapter } from "./format-adapters";

describe("Codex format adapter", () => {
  it("strips subagent notifications from user messages", () => {
    const notification = `<subagent_notification>
{"agent_path":"/root/researcher","status":{"completed":"done"}}
</subagent_notification>`;

    expect(
      codexAdapter.parseLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `${notification}\n重启服务后我来验证` }],
        },
      }),
    ).toMatchObject({ role: "user", content: "重启服务后我来验证" });

    expect(
      codexAdapter.parseLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: notification }],
        },
      }),
    ).toBeNull();
  });

  it("extracts the real user_query from a system notification wrapper", () => {
    const wrapped = (query: string) => `<timestamp>Friday</timestamp>
<system_notification><task>completed</task></system_notification>
<user_query>${query}</user_query>`;
    const row = (text: string) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });

    expect(codexAdapter.parseLine(row(wrapped("真实输入"))))
      .toMatchObject({ role: "user", content: "真实输入" });
    expect(codexAdapter.parseLine(row(wrapped(
      "Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required.",
    )))).toBeNull();
  });

  it("drops Cursor's system follow-up instruction from user messages", () => {
    const followUp = "Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required.";

    expect(
      codexAdapter.parseLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: followUp }],
        },
      }),
    ).toBeNull();
  });
});
