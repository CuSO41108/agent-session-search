import type { ComponentProps, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SearchOptions, SessionMatchHit, SessionSearchResult, SessionSortBy } from "../../../core/types";
import type { SavedSearch } from "../../../core/store/saved-searches";
import { localize, type LanguageMode } from "../language";
import type { LiveSessionState } from "../live-filter";
import { QueryBuilder } from "../features/search/query-builder";
import { SavedSearchesPanel } from "../features/search/saved-searches-panel";
import { GroupedResults } from "../features/search/grouped-results";
import type { GroupMode } from "../features/search/group-logic";
import type { QueryBuilderState } from "../features/search/query-builder-types";
import { Toolbar, type ToolbarProps } from "./toolbar";

export type ContentAreaProps = {
  language: LanguageMode;
  toolbar: ToolbarProps;
  queryBuilderOpen: boolean;
  queryBuilderInitial: QueryBuilderState;
  sourceOptions: Array<{ label: string; value: SearchOptions["source"] }>;
  tagOptions: string[];
  onApplyQueryBuilder: (state: QueryBuilderState) => void;
  onCloseQueryBuilder: () => void;
  onSaveSearch: (name: string, state: QueryBuilderState) => void;
  savedSearchesOpen: boolean;
  savedSearches: SavedSearch[];
  onApplySavedSearch: (saved: SavedSearch) => void;
  onDeleteSavedSearch: (id: number) => void;
  onCloseSavedSearches: () => void;
  resultsHeader: ReactNode;
  sessions: ComponentProps<typeof GroupedResults>["sessions"];
  groupMode: GroupMode;
  sortBy: SessionSortBy;
  selectedKey: string | null;
  liveStateFor: (session: SessionSearchResult) => LiveSessionState;
  onOpenMatch: (session: SessionSearchResult, hit: SessionMatchHit) => void;
  onSelect: (sessionKey: string) => void;
  onOpen: (session: SessionSearchResult) => void;
  onRename: (session: SessionSearchResult) => void;
  onFavorite: (session: SessionSearchResult) => void;
  onContextMenu: (event: ReactMouseEvent, session: SessionSearchResult) => void;
  bulkSelectionActive: boolean;
  bulkSelectedKeys: Set<string>;
  onToggleBulk: (sessionKey: string) => void;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
};

export function ContentArea(props: ContentAreaProps): ReactElement {
  const {
    language,
    toolbar,
    queryBuilderOpen,
    queryBuilderInitial,
    sourceOptions,
    tagOptions,
    onApplyQueryBuilder,
    onCloseQueryBuilder,
    onSaveSearch,
    savedSearchesOpen,
    savedSearches,
    onApplySavedSearch,
    onDeleteSavedSearch,
    onCloseSavedSearches,
    resultsHeader,
    sessions,
    groupMode,
    sortBy,
    selectedKey,
    liveStateFor,
    onOpenMatch,
    onSelect,
    onOpen,
    onRename,
    onFavorite,
    onContextMenu,
    bulkSelectionActive,
    bulkSelectedKeys,
    onToggleBulk,
    currentPage,
    totalPages,
    onPageChange,
  } = props;
  const t = (en: string, zh: string) => localize(language, en, zh);

  return (
    <section className="content">
      <Toolbar {...toolbar} />

      {queryBuilderOpen ? (
        <QueryBuilder
          initial={queryBuilderInitial}
          sourceOptions={sourceOptions}
          tagOptions={tagOptions}
          language={language}
          onApply={onApplyQueryBuilder}
          onClose={onCloseQueryBuilder}
          onSaveSearch={onSaveSearch}
        />
      ) : null}

      {savedSearchesOpen ? (
        <SavedSearchesPanel
          savedSearches={savedSearches}
          language={language}
          onApply={onApplySavedSearch}
          onDelete={onDeleteSavedSearch}
          onClose={onCloseSavedSearches}
        />
      ) : null}

      {resultsHeader}

      <div key={currentPage} className="results">
        <GroupedResults
          sessions={sessions}
          groupMode={groupMode}
          sortBy={sortBy}
          selectedKey={selectedKey}
          liveStateFor={liveStateFor}
          language={language}
          onOpenMatch={onOpenMatch}
          onSelect={onSelect}
          onOpen={onOpen}
          onRename={onRename}
          onFavorite={onFavorite}
          onContextMenu={onContextMenu}
          bulkSelectionActive={bulkSelectionActive}
          bulkSelectedKeys={bulkSelectedKeys}
          onToggleBulk={onToggleBulk}
        />
        {sessions.length === 0 ? <div className="empty">{t("No sessions found.", "没有找到会话。")}</div> : null}
      </div>
      {totalPages > 1 ? (
        <nav className="session-pagination" aria-label={t("Session pages", "会话分页")}>
          <button type="button" className="pagination-button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1} title={t("Previous page", "上一页")} aria-label={t("Previous page", "上一页")}><ChevronLeft size={14} /></button>
          <div className="pagination-pages">
            {paginationItems(currentPage, totalPages).map((item) => typeof item === "number" ? (
              <button
                key={item}
                type="button"
                className={`pagination-button ${item === currentPage ? "active" : ""}`}
                data-page={item}
                aria-current={item === currentPage ? "page" : undefined}
                aria-label={t(`Page ${item}`, `第 ${item} 页`)}
                onClick={() => onPageChange(item)}
              >
                {item}
              </button>
            ) : <span key={item} className="pagination-ellipsis" aria-hidden="true">...</span>)}
          </div>
          <button type="button" className="pagination-button" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages} title={t("Next page", "下一页")} aria-label={t("Next page", "下一页")}><ChevronRight size={14} /></button>
          <form className="pagination-jump" onSubmit={(event) => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get("page")); if (Number.isInteger(value)) onPageChange(Math.min(totalPages, Math.max(1, value))); }}>
            <input key={`${currentPage}-${totalPages}`} name="page" type="number" min={1} max={totalPages} defaultValue={currentPage} aria-label={t("Page number", "页码")} />
            <span>/ {totalPages}</span>
            <button type="submit">{t("Go", "跳转")}</button>
          </form>
        </nav>
      ) : null}
    </section>
  );
}

function paginationItems(currentPage: number, totalPages: number): Array<number | string> {
  const pages = new Set<number>([1, totalPages]);
  for (let page = currentPage - 2; page <= currentPage + 2; page += 1) {
    if (page >= 1 && page <= totalPages) pages.add(page);
  }
  const sortedPages = [...pages].sort((left, right) => left - right);
  const items: Array<number | string> = [];
  for (const page of sortedPages) {
    const previous = items.at(-1);
    const previousPage = typeof previous === "number" ? previous : undefined;
    if (previousPage !== undefined && page - previousPage === 2) items.push(previousPage + 1);
    else if (previousPage !== undefined && page - previousPage > 2) items.push(`ellipsis-${previousPage}-${page}`);
    items.push(page);
  }
  return items;
}
