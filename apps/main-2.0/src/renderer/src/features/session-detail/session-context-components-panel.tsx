import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import type {
  ContextComponent,
  SessionContextComponents,
} from "../../../../core/session-context-components";
import { localize, type LanguageMode } from "../../language";
import { sourceUiFamily } from "../../session-ui";
import type { SessionSearchResult } from "../../../../core/types";

const PREVIEW_CHAR_LIMIT = 12_000;

function truncateContextText(text: string, limit = PREVIEW_CHAR_LIMIT): {
  preview: string;
  truncated: boolean;
} {
  if (text.length <= limit) return { preview: text, truncated: false };
  return { preview: `${text.slice(0, limit)}\n…`, truncated: true };
}

function supportsContextComponents(session: SessionSearchResult): boolean {
  const family = sourceUiFamily(session.source);
  return family === "claude" || family === "codex";
}

function componentTitle(component: ContextComponent, language: LanguageMode): string {
  switch (component.kind) {
    case "system_instructions":
      return localize(language, "System / base instructions", "系统 / 基础指令");
    case "developer_instructions":
      return localize(language, "Developer instructions (extra)", "Developer 指令（额外指令）");
    case "tool_inventory":
      return localize(language, "Tools", "工具清单");
    case "skill_listing":
      return localize(language, "Skills", "Skills 清单");
    case "mcp_instructions":
      return localize(language, "MCP instructions", "MCP 说明");
    case "deferred_tools":
      return localize(language, "Deferred tools", "延迟加载工具");
    case "agent_listing":
      return localize(language, "Agents", "Agent 清单");
    default:
      return component.title;
  }
}

function ContextComponentBlock({
  component,
  language,
}: {
  component: ContextComponent;
  language: LanguageMode;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = component.text?.trim() ?? "";
  const { preview, truncated } = text ? truncateContextText(text) : { preview: "", truncated: false };
  const shown = expanded || !truncated ? text : preview;

  return (
    <div className="context-component">
      <div className="context-component-head">
        <strong>{componentTitle(component, language)}</strong>
        <span className="context-component-fidelity">
          {component.fidelity === "full"
            ? localize(language, "full text", "全文")
            : localize(language, "listing", "清单")}
        </span>
      </div>
      {component.note ? <p className="context-component-note">{component.note}</p> : null}
      {component.items && component.items.length > 0 ? (
        <ul className="context-component-items">
          {component.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {text ? (
        <div className="context-component-text">
          <pre>{shown}</pre>
          {truncated ? (
            <button type="button" className="context-component-expand" onClick={() => setExpanded((value) => !value)}>
              {expanded
                ? localize(language, "Collapse", "收起全文")
                : localize(language, "Expand full text", "展开全文")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SessionContextComponentsPanel({
  session,
  language,
}: {
  session: SessionSearchResult;
  language: LanguageMode;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<SessionContextComponents | null>(null);

  useEffect(() => {
    setOpen(false);
    setPayload(null);
    setLoading(false);
    setError(null);
  }, [session.sessionKey]);

  useEffect(() => {
    if (!open || !supportsContextComponents(session)) return;
    // Do not put `loading` in deps / guards: setLoading(true) would retrigger the
    // effect, cancel the in-flight request, then bail because loading===true —
    // leaving the panel stuck on "加载中…" forever.
    if (payload) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.sessionSearch.getSessionContextComponents(session.sessionKey)
      .then((result) => {
        if (!cancelled) setPayload(result);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause ?? "unknown error");
        setError(message);
        setPayload({
          status: "source_unavailable",
          source: session.source,
          format: null,
          components: [],
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, session.sessionKey, session.source, payload]);

  if (!supportsContextComponents(session)) return null;

  const l = (en: string, zh: string) => localize(language, en, zh);

  return (
    <div className="detail-context-components">
      <button
        type="button"
        className="detail-context-components-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Layers size={13} />
        <span>{l("Context composition", "上下文构成")}</span>
      </button>
      {open ? (
        <div className="detail-context-components-body">
          {loading ? <p className="detail-context-components-empty">{l("Loading…", "加载中…")}</p> : null}
          {!loading && error ? (
            <p className="detail-context-components-empty">
              {l("Failed to load context composition", "加载上下文构成失败")}
              {error ? `: ${error}` : ""}
            </p>
          ) : null}
          {!loading && !error && payload?.status === "source_unavailable" ? (
            <p className="detail-context-components-empty">
              {l("Source file unavailable", "源文件不可用")}
            </p>
          ) : null}
          {!loading && !error && payload?.status === "unsupported" ? (
            <p className="detail-context-components-empty">
              {l("This session source is not supported", "此会话来源暂不支持")}
            </p>
          ) : null}
          {!loading && !error && payload?.status === "ok" && payload.components.length === 0 ? (
            <p className="detail-context-components-empty">
              {l(
                "No extractable context metadata in this session.",
                "此会话无可提取的上下文元数据",
              )}
            </p>
          ) : null}
          {!loading && !error && payload?.status === "ok" ? payload.components.map((component) => (
            <ContextComponentBlock
              key={`${component.kind}:${component.sourceHint ?? ""}:${component.title}`}
              component={component}
              language={language}
            />
          )) : null}
        </div>
      ) : null}
    </div>
  );
}
