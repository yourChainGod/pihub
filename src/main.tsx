import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Apply the persisted theme before first paint to avoid a flash.
document.documentElement.classList.toggle("dark", localStorage.getItem("pihub-theme") !== "light");

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
