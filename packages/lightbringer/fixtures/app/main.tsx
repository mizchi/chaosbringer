import { createRoot } from "react-dom/client";
import { App } from "./App";

// No StrictMode: it double-invokes renders in dev and would distort the bench.
createRoot(document.getElementById("root")!).render(<App />);
