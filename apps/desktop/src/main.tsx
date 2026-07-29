import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@inkshadow/ui/styles.css";

import { App } from "./app";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Missing #root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
