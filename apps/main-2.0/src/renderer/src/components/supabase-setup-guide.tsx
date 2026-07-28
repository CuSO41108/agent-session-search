import { useState } from "react";
import type { ReactElement } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { localize, type LanguageMode } from "../language";

export function SupabaseSetupGuide({
  language,
  title,
  message,
  detail,
  tone = "warning",
  busy = false,
  showSqlActions = true,
  onCopySql,
  onOpenSqlEditor,
  onRefresh,
}: {
  language: LanguageMode;
  title?: string;
  message?: string;
  detail?: string | null;
  tone?: "info" | "warning" | "error";
  busy?: boolean;
  showSqlActions?: boolean;
  onCopySql: () => void | Promise<void>;
  onOpenSqlEditor: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function copySql(): Promise<void> {
    try {
      await onCopySql();
      setCopied(true);
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openSqlEditor(): Promise<void> {
    try {
      await onOpenSqlEditor();
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className={`supabase-setup-guide ${tone}`}>
      <div className="supabase-setup-copy">
        <strong>{title ?? l("Supabase setup required", "需要配置 Supabase")}</strong>
        <span>{message ?? (showSqlActions
          ? l("Run the SQL, then refresh here.", "执行 SQL 后回到这里刷新。")
          : l("Check the Supabase connection settings, then refresh here.", "请检查 Supabase 连接设置，然后回到这里刷新。"))}</span>
        {detail ? (
          <details>
            <summary>{l("Technical details", "技术详情")}</summary>
            <code>{detail}</code>
          </details>
        ) : null}
        {actionError ? <span className="supabase-setup-error">{actionError}</span> : null}
      </div>
      <div className="supabase-setup-actions">
        {showSqlActions ? (
          <>
            <button type="button" onClick={() => void copySql()} disabled={busy}>
              <Copy size={14} />
              {copied ? l("SQL copied", "SQL 已复制") : l("Copy latest SQL", "复制最新 SQL")}
            </button>
            <button type="button" onClick={() => void openSqlEditor()} disabled={busy}>
              <ExternalLink size={14} />
              {l("Open SQL Editor", "打开 SQL Editor")}
            </button>
          </>
        ) : null}
        {onRefresh ? (
          <button type="button" onClick={() => void onRefresh()} disabled={busy}>
            <RefreshCw size={14} />
            {l("Refresh", "刷新")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
