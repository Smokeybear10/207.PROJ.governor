import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import BrandStudio from "./BrandStudio";
import "./brand-studio.css";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Governor could not find its root element.");
}

const path = window.location.pathname.replace(/\/+$/, "") || "/";
const isBrandStudio = path === "/brand";

if (isBrandStudio) {
  document.title = "Governor Brand Studio";
}

createRoot(root).render(
  <StrictMode>
    {isBrandStudio ? <BrandStudio /> : <App />}
  </StrictMode>
);
