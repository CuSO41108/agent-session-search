import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styleFiles = [
  ["V1", new URL("../apps/main-1.0/src/renderer/src/styles.css", import.meta.url)],
  ["V2", new URL("../apps/main-2.0/src/renderer/src/styles/sessions.css", import.meta.url)],
];

for (const [appName, styleFile] of styleFiles) {
  test(`${appName} aligns the session result toolbar with the filters`, () => {
    const styles = readFileSync(styleFile, "utf8");
    const rule = styles.match(/\.result-count\s*\{([^}]*)\}/)?.[1];

    assert.ok(rule, ".result-count styles should exist");
    assert.match(rule, /margin:\s*8px 0;/, "the result toolbar should keep equal spacing from the filters and session list");
    assert.match(rule, /padding:\s*0;/, "the result toolbar should share the filters' left edge");
  });
}
