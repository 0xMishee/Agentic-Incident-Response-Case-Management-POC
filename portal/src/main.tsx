import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ToastProvider, syncClock } from "./lib";
import "./styles.css";

syncClock().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StrictMode>,
  );
});
