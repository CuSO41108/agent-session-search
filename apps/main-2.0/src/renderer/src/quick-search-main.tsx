import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyMessageFontSize, readInitialMessageFontSize } from "./message-font-size";
import { QuickSearch } from "./quick-search";
import "./quick-search.css";

applyMessageFontSize(readInitialMessageFontSize());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QuickSearch />
  </StrictMode>,
);
