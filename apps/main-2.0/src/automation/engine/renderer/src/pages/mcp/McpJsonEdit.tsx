import { useEffect, useState } from "react";
import { FileJson, X } from "lucide-react";
import type { Language } from "../../app/language";
import type { McpServerDefinition } from "../../../../shared/mcp/types";
import { applyServerConfigJson, serverConfigToJson } from "./mcp-import";

export function McpJsonEdit({
  language = "en",
  server,
  onClose,
  onApply,
}: {
  language?: Language;
  server: McpServerDefinition;
  onClose: () => void;
  onApply: (server: McpServerDefinition) => void;
}) {
  const zh = language === "zh";
  const [text, setText] = useState(() => serverConfigToJson(server));
  const [error, setError] = useState<string>();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = () => {
    setError(undefined);
    try {
      onApply(applyServerConfigJson(server, text, zh ? "zh" : "en"));
      onClose();
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? zh
            ? `JSON 解析失败：${cause.message}`
            : `Invalid JSON: ${cause.message}`
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    }
  };

  return (
    <div className="mcp-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mcp-modal is-wide"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? "以 JSON 编辑 MCP" : "Edit MCP as JSON"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mcp-modal-header">
          <div className="mcp-modal-title">
            <FileJson size={15} />
            <strong>{zh ? `以 JSON 编辑 · ${server.name}` : `Edit as JSON · ${server.name}`}</strong>
          </div>
          <button
            className="icon-btn"
            type="button"
            aria-label={zh ? "关闭" : "Close"}
            title={zh ? "关闭" : "Close"}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </header>
        <div className="mcp-modal-body">
          <p className="mcp-modal-description">
            {zh
              ? "编辑当前 Server 的连接配置。env / headers 的值是宿主机环境变量名引用，不保存密钥。应用后仍需点击「保存」才会生效。"
              : "Edit this server's connection config. Env / header values reference host environment variable names; secrets are not stored. Click Save after applying to persist."}
          </p>
          <textarea
            className="mcp-json-input"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {error ? (
            <div className="mcp-import-errors" role="alert">
              <span>{error}</span>
            </div>
          ) : null}
        </div>
        <footer className="mcp-modal-footer">
          <button className="control-btn compact secondary" type="button" onClick={onClose}>
            {zh ? "取消" : "Cancel"}
          </button>
          <button
            className="control-btn compact is-active"
            type="button"
            onClick={apply}
            disabled={!text.trim()}
          >
            {zh ? "应用" : "Apply"}
          </button>
        </footer>
      </div>
    </div>
  );
}
