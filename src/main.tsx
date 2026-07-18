import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import BrandStudio from "./BrandStudio";
import RepairPanel from "./RepairPanel";
import "./brand-studio.css";
import "./styles.css";
import "./repair.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Governor could not find its root element.");
}

const path = window.location.pathname.replace(/\/+$/, "") || "/";
const isBrandStudio = path === "/brand";
const isRepair = path === "/repair";

if (isBrandStudio) {
  document.title = "Governor Brand Studio";
} else if (isRepair) {
  document.title = "Governor CI-Repair";
}

function activeView(): React.JSX.Element {
  if (isBrandStudio) {
    return <BrandStudio />;
  }
  if (isRepair) {
    return <RepairPanel />;
  }
  return <App />;
}

createRoot(root).render(<StrictMode>{activeView()}</StrictMode>);
