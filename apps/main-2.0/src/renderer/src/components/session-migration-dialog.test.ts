import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SessionSearchResult } from "../../../core/types";
import { SessionMigrationDialog } from "./session-migration-dialog";

describe("SessionMigrationDialog background behavior", () => {
  it("keeps the close action available while migration continues", () => {
    const html = renderToStaticMarkup(createElement(SessionMigrationDialog, {
      session: { displayTitle: "Synthetic", environmentKind: "local" } as SessionSearchResult,
      language: "zh",
      busy: true,
      targets: ["codex"],
      onSelect: () => undefined,
      onClose: () => undefined,
    }));

    expect(html).toContain('aria-label="转到后台"');
    expect(html).not.toContain('aria-label="转到后台" disabled=""');
  });
});
