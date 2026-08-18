import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styleFiles = [
  ["V1", new URL("../apps/main-1.0/src/renderer/src/styles.css", import.meta.url)],
  ["V2", new URL("../apps/main-2.0/src/renderer/src/styles.css", import.meta.url)],
];

for (const [appName, styleFile] of styleFiles) {
  test(`${appName} aligns the subagent heading with its session cards`, () => {
    const styles = readFileSync(styleFile, "utf8");
    const rules = [...styles.matchAll(/\.subagent-tree-head\s*\{([^}]*)\}/g)];
    const rule = rules.at(-1)?.[1];

    assert.ok(rule, ".subagent-tree-head styles should exist");
    assert.match(
      rule,
      /margin-left:\s*18px;/,
      "the subagent heading should keep the same left gutter as its card content",
    );
  });
}
