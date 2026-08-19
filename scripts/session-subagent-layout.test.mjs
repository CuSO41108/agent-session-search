import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styleFiles = [
  ["V1", new URL("../apps/main-1.0/src/renderer/src/styles.css", import.meta.url)],
  ["V2", new URL("../apps/main-2.0/src/renderer/src/styles.css", import.meta.url)],
];

for (const [appName, styleFile] of styleFiles) {
  test(`${appName} aligns related sessions with the conversation content`, () => {
    const styles = readFileSync(styleFile, "utf8");
    const rules = [...styles.matchAll(/\.subagent-session-tree\s*\{([^}]*)\}/g)];
    const rule = rules.at(-1)?.[1];

    assert.ok(rule, ".subagent-session-tree styles should exist");
    assert.match(
      rule,
      /padding:\s*14px 18px 0;/,
      "the related-session area should keep the same horizontal gutter as the conversation",
    );
  });
}
