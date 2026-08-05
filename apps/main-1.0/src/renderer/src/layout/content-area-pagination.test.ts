// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentArea, type ContentAreaProps } from "./content-area";

vi.mock("./toolbar", () => ({ Toolbar: () => null }));
vi.mock("../features/search/grouped-results", () => ({ GroupedResults: () => null }));

const noop = () => undefined;

describe("ContentArea Session pagination", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("jumps to a requested page and resets the result scroller", async () => {
    const onPageChange = vi.fn();
    const props = paginationProps(onPageChange);
    await act(async () => root.render(createElement(ContentArea, props)));
    const firstResults = container.querySelector(".results");
    const input = container.querySelector<HTMLInputElement>('input[name="page"]');
    const form = container.querySelector<HTMLFormElement>(".pagination-jump");
    if (!input || !form) throw new Error("Expected Session pagination controls.");

    input.value = "3";
    await act(async () => form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })));
    expect(onPageChange).toHaveBeenCalledWith(3);

    await act(async () => root.render(createElement(ContentArea, { ...props, currentPage: 2 })));
    expect(container.querySelector(".results")).not.toBe(firstResults);
  });
});

function paginationProps(onPageChange: (page: number) => void): ContentAreaProps {
  return {
    language: "zh",
    toolbar: {} as ContentAreaProps["toolbar"],
    queryBuilderOpen: false,
    queryBuilderInitial: {} as ContentAreaProps["queryBuilderInitial"],
    sourceOptions: [],
    tagOptions: [],
    onApplyQueryBuilder: noop,
    onCloseQueryBuilder: noop,
    onSaveSearch: noop,
    savedSearchesOpen: false,
    savedSearches: [],
    onApplySavedSearch: noop,
    onDeleteSavedSearch: noop,
    onCloseSavedSearches: noop,
    resultsHeader: null,
    sessions: [],
    groupMode: "flat",
    sortBy: "smart",
    selectedKey: null,
    liveStateFor: (() => "closed") as ContentAreaProps["liveStateFor"],
    onOpenMatch: noop,
    onSelect: noop,
    onOpen: noop,
    onRename: noop,
    onFavorite: noop,
    onContextMenu: noop,
    bulkSelectionActive: false,
    bulkSelectedKeys: new Set(),
    onToggleBulk: noop,
    currentPage: 1,
    totalPages: 4,
    onPageChange,
  };
}
