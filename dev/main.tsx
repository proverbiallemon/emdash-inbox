import * as React from "react";
import { createRoot } from "react-dom/client";
import { pages } from "../src/admin";
import { setBundleScenario } from "./fixtureApi";
const settings = window.location.pathname.endsWith("/settings");
const Inbox = pages[settings ? "/settings" : "/"] as React.ComponentType;
function Preview() {
 const [width, setWidth] = React.useState("1440px");
 return <><style>{`.preview-tools{flex-wrap:wrap}.preview-tools>*{max-width:100%}.preview-tools small{overflow-wrap:anywhere}.preview-tools button{min-height:44px}.preview-tools label{display:flex;gap:6px;align-items:center}`}</style><div className="preview-tools"><strong>Daylight · Local preview</strong><label>Canvas <select aria-label="Preview width" value={width} onChange={event => setWidth(event.target.value)}><option value="1440px">Desktop · 1440</option><option value="1100px">Tablet · 1100</option><option value="390px">Mobile · 390</option><option value="320px">Narrow · 320</option></select></label><label>Scenario <select aria-label="Bundle preview scenario" onChange={event => setBundleScenario(event.target.value as Parameters<typeof setBundleScenario>[0])}>{["normal","partial","unknown","conflict","move-partial","move-error","settings-error","indexing","overview-error"].map(value => <option key={value}>{value}</option>)}</select></label><button onClick={() => {sessionStorage.removeItem("daylight-preview-operations");localStorage.removeItem("daylight:bundle-operation:v1:daylight-preview-user");location.reload();}}>Reset sample mail</button><small>Sample mail only · no email is sent · reset restores messages</small></div><div id="preview" style={{width}}><Inbox /></div></>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
