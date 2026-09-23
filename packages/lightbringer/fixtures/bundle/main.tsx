import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
// Namespace import + dynamic exposure: the bundler can't tree-shake, so every
// feature ships in the "features" chunk even though the page calls only `summary`.
// Coverage then shows the chunk mostly unused (over-shipping).
import * as features from "./features";

(window as unknown as { features: typeof features }).features = features;

const data = Array.from({ length: 64 }, (_, i) => (i * 37) % 100);

function App() {
  const [out, setOut] = useState(() => features.summary(data));
  return (
    <main>
      <h1>bundle fixture</h1>
      {/* a 1600×1200 image rendered into a 128×96 box: real-bytes over-fetch */}
      <img className="thumb" src="/photo.png" width={128} height={96} alt="" />
      <div>
        <button id="run" type="button" onClick={() => setOut(features.summary(data))}>
          summary
        </button>
        <div id="out">{out}</div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
