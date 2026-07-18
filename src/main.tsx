import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import RepairPanel from "./RepairPanel";
import "./styles.css";
import "./repair.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Governor could not find its root element.");
}

const path = window.location.pathname.replace(/\/+$/, "") || "/";
const isRepair = path === "/repair";

if (isRepair) {
  document.title = "Governor CI-Repair";
}

function activeView(): React.JSX.Element {
  if (isRepair) {
    return <RepairPanel />;
  }
  return <App />;
}

createRoot(root).render(<StrictMode>{activeView()}</StrictMode>);
