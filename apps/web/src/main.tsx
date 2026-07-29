import "@inkshadow/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { createBrowserGuestWorkspaceService } from "./bootstrap";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) {
  throw new Error("InkShadow Web root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <App service={createBrowserGuestWorkspaceService()} />
  </StrictMode>,
);
