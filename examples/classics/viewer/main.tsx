import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "@xyflow/react/dist/style.css";
import "@petrus/net-viewer-react/style.css";

const container = document.getElementById("root");
if (container === null) throw new Error("The viewer root is missing");
createRoot(container).render(<App request={fetch} />);
