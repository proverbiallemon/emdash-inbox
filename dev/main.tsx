import * as React from "react";
import { createRoot } from "react-dom/client";
import { pages } from "../src/admin";
const Inbox = pages["/"] as React.ComponentType;
function Preview() {
 const [width, setWidth] = React.useState("1440px");
 return <><div className="preview-tools"><strong>Daylight · Local preview</strong><label>Canvas <select aria-label="Preview width" value={width} onChange={event => setWidth(event.target.value)}><option value="1440px">Desktop · 1440</option><option value="1100px">Tablet · 1100</option><option value="390px">Mobile · 390</option></select></label><small>Sample mail only · no email is sent · refresh resets messages</small></div><div id="preview" style={{width}}><Inbox /></div></>;
}
createRoot(document.getElementById("root")!).render(<Preview />);

