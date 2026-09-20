/**
 * TeleAgent dashboard — single dependency-free shell, one real route per tab.
 *
 * Design language: modern "soft console" — light-first with automatic dark mode,
 * system fonts only (no external font request, so it stays instant + offline),
 * restrained accent colour, soft depth, generous tap targets, and a
 * mobile-first layout where tables collapse into labelled cards.
 *
 * Every tab is addressable (`/`, `/diagram`, `/sessions`, …) so deep links,
 * refreshes and browser back/forward all work; the client router keeps the URL
 * and the rendered view in sync.
 */

export const DASHBOARD_TITLE = "TeleAgent — Super Harness";

/** Tab order is the nav order. Labels are also the client-side view keys. */
export const DASHBOARD_TABS = [
  "Status", "Diagram", "Sessions", "Runs", "Approvals", "Workspaces",
  "Providers", "Usage", "Audit", "Settings", "Graphify",
] as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[number];

/** Canonical path per tab. `Status` owns the root. */
export const TAB_ROUTES: Record<string, string> = {
  Status: "/",
  Diagram: "/diagram",
  Sessions: "/sessions",
  Runs: "/runs",
  Approvals: "/approvals",
  Workspaces: "/workspaces",
  Providers: "/providers",
  Usage: "/usage",
  Audit: "/audit",
  Settings: "/settings",
  Graphify: "/graphify",
};

export function routeForTab(tab: string): string {
  return TAB_ROUTES[tab] ?? "/";
}

/**
 * Resolve a request path to a tab. An explicit `?tab=` wins (that is deliberate
 * user intent and the legacy dashboard URL shape), then the canonical path,
 * then a case-insensitive path match, else Status.
 */
export function tabFromPath(pathname: string): DashboardTab {
  const raw = String(pathname ?? "/");
  const [rawPath, rawQuery] = raw.split("?");
  const clean = (rawPath ?? "/").replace(/\/+$/, "") || "/";
  const m = /(?:^|[?&])tab=([A-Za-z]+)/.exec(rawQuery ? `?${rawQuery}` : "");
  if (m) {
    const hit = DASHBOARD_TABS.find((t) => t.toLowerCase() === String(m[1]).toLowerCase());
    if (hit) return hit;
  }
  for (const tab of DASHBOARD_TABS) if (TAB_ROUTES[tab] === clean) return tab;
  const lower = clean.toLowerCase();
  const ci = DASHBOARD_TABS.find((t) => TAB_ROUTES[t]!.toLowerCase() === lower);
  return ci ?? "Status";
}

/**
 * Shared design system CSS: tokens, layout primitives, controls, tables, states.
 * Every first-party page (dashboard, graph viewer) imports this so they cannot
 * drift apart — one palette, one typography scale, one set of breakpoints.
 */
export const BASE_CSS = `
/* ---------- tokens: light first, dark follows the system ---------- */
:root{
  --bg:#f4f5f9; --surface:#ffffff; --surface-2:#f7f8fc; --surface-3:#eef0f7;
  --text:#12162a; --muted:#5b6280; --line:#e4e7f0; --line-strong:#d3d7e4;
  /* deep teal, not the default violet every generated dashboard reaches for */
  --accent:#0e7490; --accent-ink:#ffffff; --accent-soft:#e3f1f4;
  --ok:#0f7f4c; --ok-soft:#e7f5ee; --warn:#9c6309; --warn-soft:#fdf3e4;
  --bad:#c5382c; --bad-soft:#fdeceb; --info:#4c5ea8; --info-soft:#eceffb;
  --radius:14px; --radius-sm:10px; --radius-xs:8px;
  --shadow-1:0 1px 2px rgba(18,22,42,.05), 0 1px 1px rgba(18,22,42,.04);
  --shadow-2:0 1px 2px rgba(18,22,42,.05), 0 12px 28px -18px rgba(18,22,42,.35);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --hdr-h:56px;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0b0e14; --surface:#12161f; --surface-2:#171c27; --surface-3:#1d2330;
    --text:#eaeefb; --muted:#98a2bd; --line:#232a39; --line-strong:#2e374a;
    --accent:#5cc8dd; --accent-ink:#08161a; --accent-soft:#122b31;
    --ok:#4ecf92; --ok-soft:#12291f; --warn:#e0b45c; --warn-soft:#2a2313;
    --bad:#f0736b; --bad-soft:#2c1718; --info:#9aa8e6; --info-soft:#181d31;
    --shadow-1:0 1px 2px rgba(0,0,0,.4);
    --shadow-2:0 1px 2px rgba(0,0,0,.4), 0 18px 36px -22px rgba(0,0,0,.75);
  }
}
:root[data-theme="dark"]{
  --bg:#0b0e14; --surface:#12161f; --surface-2:#171c27; --surface-3:#1d2330;
  --text:#eaeefb; --muted:#98a2bd; --line:#232a39; --line-strong:#2e374a;
  --accent:#5cc8dd; --accent-ink:#08161a; --accent-soft:#122b31;
  --ok:#4ecf92; --ok-soft:#12291f; --warn:#e0b45c; --warn-soft:#2a2313;
  --bad:#f0736b; --bad-soft:#2c1718; --info:#9aa8e6; --info-soft:#181d31;
  --shadow-1:0 1px 2px rgba(0,0,0,.4);
  --shadow-2:0 1px 2px rgba(0,0,0,.4), 0 18px 36px -22px rgba(0,0,0,.75);
}

/* ---------- base ---------- */
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--text); font-family:var(--sans);
  font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased;
  min-height:100vh; overscroll-behavior-y:none;
}
h1,h2,h3{margin:0;font-weight:650;letter-spacing:-.01em}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.skip{position:absolute;left:-9999px;top:0;background:var(--surface);padding:10px 14px;border-radius:var(--radius-xs);z-index:99}
.skip:focus{left:12px;top:12px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* ---------- top area (single sticky container = no height math) ---------- */
.top{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:saturate(160%) blur(10px);border-bottom:1px solid var(--line)}
header.topbar{display:flex;align-items:center;gap:10px;padding:9px 14px;min-height:var(--hdr-h);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:-.02em}
.brand .tag{font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.statusline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pill{font-size:11.5px;font-weight:600;padding:4px 9px;border-radius:999px;border:1px solid var(--line-strong);background:var(--surface);color:var(--muted);white-space:nowrap}
.pill.ok{background:var(--ok-soft);color:var(--ok);border-color:transparent}
.pill.warn{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.pill.bad{background:var(--bad-soft);color:var(--bad);border-color:transparent}
.actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.actions input{width:150px;height:34px;padding:0 10px;border-radius:var(--radius-xs);border:1px solid var(--line-strong);background:var(--surface);color:var(--text);font:inherit;font-size:13px}
.actions input::placeholder{color:var(--muted)}

/* ---------- controls ---------- */
.btn{height:34px;padding:0 12px;border-radius:var(--radius-xs);border:1px solid var(--line-strong);background:var(--surface);color:var(--text);font:inherit;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .16s ease,border-color .16s ease,transform .1s ease,color .16s ease}
.btn:hover{background:var(--surface-3)}
.btn:active{transform:scale(.97)}
.btn.primary{background:var(--accent);border-color:transparent;color:var(--accent-ink)}
.btn.primary:hover{filter:brightness(1.06)}
.btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,var(--line-strong))}
.btn.danger:hover{background:var(--bad-soft)}
.btn.icon{width:34px;padding:0;justify-content:center;font-size:15px}
.btn[disabled]{opacity:.5;cursor:not-allowed}

/* ---------- tabs: scrollable segmented strip, snap on touch ---------- */
nav.tabs{display:flex;gap:6px;padding:0 12px 9px;overflow-x:auto;scroll-snap-type:x proximity;scrollbar-width:none;-webkit-overflow-scrolling:touch}
nav.tabs::-webkit-scrollbar{display:none}
.tab{flex:0 0 auto;scroll-snap-align:start;height:34px;padding:0 13px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:7px;transition:background .16s ease,color .16s ease,border-color .16s ease}
.tab:hover{background:var(--surface-3);color:var(--text)}
.tab[aria-selected="true"]{background:var(--surface);color:var(--text);border-color:var(--line-strong);box-shadow:var(--shadow-1)}
.tab .count{font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:1px 6px}

/* ---------- layout ---------- */
main.view{max-width:1180px;margin:0 auto;padding:16px 14px 40px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-1);padding:16px;margin-bottom:14px}
.panel > h3{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:12px}
.panel > h3 .hint{font-weight:500;text-transform:none;letter-spacing:0;font-size:12px}
.sub{color:var(--muted);font-size:13.5px;margin:-4px 0 12px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(148px,1fr))}
.split{display:grid;gap:14px;grid-template-columns:1.15fr .85fr;align-items:start}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.spread{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:space-between}
.stack{display:grid;gap:10px}

/* ---------- stat cards ---------- */
.stat{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px 13px;transition:border-color .16s ease,background .16s ease}
.stat:hover{border-color:var(--line-strong)}
.stat b{display:block;font-size:23px;font-weight:700;line-height:1.15;letter-spacing:-.02em}
.stat span{display:block;margin-top:2px;font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}

/* ---------- badges ---------- */
.bdg{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--surface-3);color:var(--muted);white-space:nowrap}
.bdg.ok{background:var(--ok-soft);color:var(--ok)}
.bdg.warn{background:var(--warn-soft);color:var(--warn)}
.bdg.bad{background:var(--bad-soft);color:var(--bad)}
.bdg.info{background:var(--info-soft);color:var(--info)}
.bdg.acc{background:var(--accent-soft);color:var(--accent)}
.bdg .dot{width:6px;height:6px;border-radius:50%;background:currentColor}

/* ---------- tables: responsive by default (cards on mobile) ---------- */
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:0 10px 8px;border-bottom:1px solid var(--line)}
td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background .14s ease}
tbody tr:hover{background:var(--surface-2)}
td .mono,th .mono{font-family:var(--mono);font-size:12.5px}
code{font-family:var(--mono);font-size:12.5px;background:var(--surface-3);border-radius:6px;padding:2px 6px;word-break:break-word}
pre{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;margin:0;overflow:auto;max-height:420px;font-family:var(--mono);font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}

/* ---------- list items / cards ---------- */
.item{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;display:grid;gap:8px}
.item .head{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.item .title{font-weight:650;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kv{display:grid;gap:6px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));font-size:13px}
.kv .k{color:var(--muted);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.kv .v{word-break:break-word}
.tree{display:flex;flex-wrap:wrap;gap:5px;max-height:300px;overflow:auto}
.chip{font-family:var(--mono);font-size:11.5px;background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:3px 9px;white-space:nowrap;color:var(--muted)}
.chip.dir{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 30%,var(--line))}
.empty{color:var(--muted);font-size:13.5px;padding:13px 14px;background:var(--surface-2);border:1px solid var(--line);border-left:3px solid var(--line-strong);border-radius:var(--radius-xs);text-align:left;line-height:1.55}
.alert{display:flex;gap:10px;align-items:flex-start;border-radius:var(--radius-sm);padding:12px;font-size:13.5px;background:var(--bad-soft);color:var(--bad)}
.alert.warn{background:var(--warn-soft);color:var(--warn)}
.alert.info{background:var(--info-soft);color:var(--info)}
.alert b{font-weight:700}
.fld{display:grid;gap:5px;margin-top:10px}
label{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
input,select,textarea{width:100%;height:38px;padding:0 11px;border-radius:var(--radius-xs);border:1px solid var(--line-strong);background:var(--surface);color:var(--text);font:inherit;font-size:14px;transition:border-color .16s ease,box-shadow .16s ease}
textarea{height:auto;min-height:74px;padding:9px 11px;font-family:var(--mono);font-size:12.5px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input[type=checkbox]{width:auto;height:auto;accent-color:var(--accent)}

/* ---------- loading + entrance ---------- */
.anim > *{animation:rise .22s cubic-bezier(.22,.61,.36,1) both}
@keyframes rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.sk{border-radius:var(--radius-sm);background:var(--surface-2);position:relative;overflow:hidden}
.sk::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--surface-3) 80%,transparent),transparent);transform:translateX(-100%);animation:shimmer 1.15s infinite}
.sk.panel{height:118px;margin-bottom:14px}
@keyframes shimmer{100%{transform:translateX(100%)}}
@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}

svg.graph{width:100%;height:auto;display:block;background:var(--surface-2);border-radius:var(--radius-sm)}
.frame{border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden;background:var(--surface-2)}
.frame iframe{width:100%;height:520px;border:0;display:block;background:#fff}

/* ---------- footer ---------- */
.foot{color:var(--muted);font-size:12px;text-align:center;padding:6px 14px 28px}
.overlay{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(10,14,25,.55);padding:20px}
.overlay.open{display:flex}
.modal{width:min(360px,100%);background:var(--surface);color:var(--text);border-radius:18px;padding:24px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.modal h2{margin:0 0 4px;font-size:19px}
.modal .sub{margin-bottom:16px}
.modal input{text-align:center;font-size:22px;letter-spacing:8px;font-weight:700}
.modal .err{min-height:20px;color:var(--bad);font-size:13px;font-weight:600;margin-top:8px}
.modal .skip{background:none;border:0;color:var(--muted);font:inherit;font-size:13px;margin-top:10px;cursor:pointer;text-decoration:underline}
.foot code{font-size:11.5px}

/* ---------- tablet ---------- */
@media (max-width:900px){
  .split{grid-template-columns:1fr}
  main.view{padding:14px 12px 36px}
}

/* ---------- mobile: the primary target ---------- */
@media (max-width:760px){
  body{font-size:15px}
  header.topbar{gap:8px;padding:8px 12px;min-height:0}
  .brand .tag{display:none}
  .statusline{order:3;width:100%;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
  .statusline::-webkit-scrollbar{display:none}
  .actions{margin-left:0;width:100%;order:2}
  .actions input{flex:1;width:auto;min-width:0}
  nav.tabs{padding:0 12px 8px}
  main.view{padding:12px 12px 32px}
  .panel{padding:13px;border-radius:var(--radius-sm)}
  .stat b{font-size:21px}
  .grid{grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}
  /* tables become labelled cards — no horizontal scrolling on a phone */
  .tablewrap{overflow:visible}
  table,tbody,tr,td{display:block;width:100%}
  thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  tbody tr{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);margin-bottom:10px;padding:4px}
  tbody tr:hover{background:var(--surface-2)}
  td{border:0;border-bottom:1px dashed var(--line);padding:8px 9px;display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
  tbody tr td:last-child{border-bottom:0}
  td::before{content:attr(data-label);color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;flex:0 0 42%;max-width:42%}
  td:empty{display:none}
  .frame iframe{height:420px}
}
@media (max-width:420px){
  .grid{grid-template-columns:1fr 1fr}
  .actions .btn{padding:0 10px}
}
`.trim();

const SCRIPT = `
const ROUTES=${JSON.stringify(TAB_ROUTES)};
const TABS=${JSON.stringify(DASHBOARD_TABS)};
const STEP_ICON={completed:"✓",in_progress:"→",failed:"✗",skipped:"-",pending:"•"};
const $=id=>document.getElementById(id);
function key(){try{return localStorage.getItem("teleagent_key")||""}catch(e){return ""}}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function attr(s){return esc(s).replace(/'/g,"&#39;")}

/* ---------- routing: URL and view stay in sync ---------- */
function tabFromPath(p){
  try{
    const raw=String(p||"/");
    const clean=(raw.split("?")[0]||"/").replace(/\\/+$/,"")||"/";
    const q=raw.indexOf("?")>=0?raw.slice(raw.indexOf("?")):"";
    const m=/[?&]tab=([A-Za-z]+)/.exec(q);
    if(m){const hit=TABS.filter(t=>t.toLowerCase()===m[1].toLowerCase())[0];if(hit)return hit}
    for(const t of TABS)if(ROUTES[t]===clean)return t;
    const low=clean.toLowerCase();
    for(const t of TABS)if(String(ROUTES[t]).toLowerCase()===low)return t;
  }catch(e){}
  return "Status";
}
let cur=tabFromPath(typeof location!=="undefined"?location.pathname:"/");
function setTitle(){try{document.title="TeleAgent · "+cur+" — Super Harness"}catch(e){}}
function pushPath(p){try{if(typeof history!=="undefined"&&history.pushState)history.pushState({tab:cur},"",p)}catch(e){}}

/* ---------- theme: follows the system unless overridden ---------- */
function storedTheme(){try{return localStorage.getItem("teleagent_theme")||""}catch(e){return ""}}
const SUN_ICON='<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 .8v1.9M8 13.3v1.9M.8 8h1.9M13.3 8h1.9M2.9 2.9l1.3 1.3M11.8 11.8l1.3 1.3M13.1 2.9l-1.3 1.3M4.2 11.8l-1.3 1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';
const MOON_ICON='<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M13.4 10.1A5.8 5.8 0 0 1 5.9 2.6 5.9 5.9 0 1 0 13.4 10.1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
function applyTheme(t){
  try{
    const root=document.documentElement;
    if(!root||!root.setAttribute)return;
    if(t)root.setAttribute("data-theme",t);else root.removeAttribute("data-theme");
  }catch(e){}
  try{
    const b=document.querySelector&&document.querySelector('[data-action="theme"]');
    if(b&&b.innerHTML!==undefined)b.innerHTML=(t==="dark"?SUN_ICON:MOON_ICON);
  }catch(e){}
}
function toggleTheme(){
  const next=storedTheme()==="dark"?"light":"dark";
  try{localStorage.setItem("teleagent_theme",next)}catch(e){}
  applyTheme(next);
}

/* ---------- tiny render helpers (all data is escaped) ---------- */
function badge(text,kind){return '<span class="bdg '+esc(kind||"")+'">'+esc(text)+'</span>'}
function statusKind(s){return s==="ok"||s==="completed"||s==="pass"||s==="healthy"||s==="approved"?"ok":s==="degraded"||s==="warn"||s==="running"||s==="pending"||s==="interrupted"?"warn":s==="down"||s==="fail"||s==="failed"||s==="rejected"?"bad":"acc"}
function stat(value,label){return '<div class="stat"><b>'+esc(value)+'</b><span>'+esc(label)+'</span></div>'}
function stats(items){return '<div class="grid">'+items.map(it=>stat(it[0],it[1])).join("")+'</div>'}
function empty(msg){return '<div class="empty">'+esc(msg)+'</div>'}
function alertBox(kind,title,body){return '<div class="alert '+esc(kind)+'"><div><b>'+esc(title)+'</b>'+(body?'<div>'+esc(body)+'</div>':"")+'</div></div>'}
function kv(pairs){return '<div class="kv">'+pairs.map(p=>'<div><div class="k">'+esc(p[0])+'</div><div class="v">'+(p[1]==null?"—":p[1])+'</div></div>').join("")+'</div>'}
function table(cols,rows){
  if(!rows||rows.length===0)return empty("Belum ada data");
  return '<div class="tablewrap"><table><thead><tr>'+cols.map(c=>'<th>'+esc(c)+'</th>').join("")+'</tr></thead><tbody>'
    +rows.map(r=>'<tr>'+r.map((cell,i)=>'<td data-label="'+attr(cols[i]||"")+'">'+(cell==null?"":cell)+'</td>').join("")+'</tr>').join("")
    +'</tbody></table></div>';
}
function skeleton(){return '<div class="sk panel"></div><div class="sk panel"></div>'}
function shortId(id){return '<span class="mono">'+esc(String(id||"").slice(0,8))+'</span>'}

/* ---------- data access ---------- */
async function api(path,opts){
  opts=opts||{};
  const r=await fetch(path,Object.assign({},opts,{headers:Object.assign({},opts.headers||{},{"content-type":"application/json","x-api-key":key()})}));
  if(r.status===401){showKeyModal("PIN salah/belum diisi — masukkan PIN lalu Masuk.");throw new Error("🔑 PIN salah/belum diisi — masukkan PIN lalu Masuk.");}
  if(!r.ok)throw new Error("HTTP "+r.status+": "+(await r.text()).slice(0,300));
  return r.json();
}

const VIEWS={
Status:async v=>{
  const s=await api("/api/status");
  const h=s.health||{};
  const checks=Object.keys(h).filter(k=>typeof h[k]==="boolean").map(k=>'<div class="item"><div class="head"><span class="title">'+esc(k)+'</span>'+badge(h[k]?"ok":"fail",h[k]?"ok":"bad")+'</div></div>').join("");
  const counts=Object.keys(s.counts||{}).map(k=>[s.counts[k],k]);
  v.innerHTML='<section class="panel"><h3>Overview</h3>'+stats(counts)+'</section>'
  +'<div class="split">'
  +'<section class="panel"><h3>Health <span class="hint">'+esc(h.status||"?")+'</span></h3><div class="stack">'+(checks||empty("Tidak ada detail health"))+'</div>'
  +(h.detail?'<div class="stack" style="margin-top:12px">'+kv(Object.keys(h.detail).map(k=>[k,h.detail[k]]))+'</div>':"")
  +'</section>'
  +'<section class="panel"><h3>Runtime</h3>'+kv([["provider",esc(s.provider)],["model",esc(s.model)],["active runs",esc(s.activeRuns)],["access",esc(s.access)],["workspace",'<code>'+esc(s.workspace)+'</code>']])+'</section>'
  +'</div>';
},
Diagram:async v=>{
  const wsSel=(function(){try{return localStorage.getItem("diagram_ws")||"default"}catch(e){return "default"}})();
  const d=await api("/api/diagram?workspace="+encodeURIComponent(wsSel));
  const tree=(d.tree||[]).map(f=>'<span class="chip'+(f.endsWith("/")?" dir":"")+'">'+esc(f)+'</span>').join("");
  const runs=(d.runs||[]).map(r=>[shortId(r.id),esc(String(r.input||"").slice(0,60)),badge(r.status,statusKind(r.status)),esc(String(r.created_at||"").slice(0,19))]);
  const g=d.graphStatus;
  const planBadge=d.plan?badge("revision "+d.plan.revision,"acc"):badge("belum ada","");
  const planHtml='<section class="panel"><h3>Agent Plan <span class="hint">'+(d.planRunId?"run "+esc(String(d.planRunId).slice(0,8)):"")+'</span></h3>'
    +(d.plan?'<div class="row" style="margin-bottom:10px">'+planBadge+'</div><pre>'+esc(planText(d.plan))+'</pre>'
            :empty("Belum ada plan — jalankan task dulu. Plan dibuat agent saat run, bukan dipalsukan."))+'</section>';
  let svg="";
  if(d.graph&&d.graph.nodes&&d.graph.nodes.length){
    const nodes=d.graph.nodes.slice(0,40), edges=d.graph.edges.slice(0,60);
    const cols=7, W=900, H=Math.max(180,40+Math.ceil(nodes.length/cols)*74);
    const pos=new Map();
    nodes.forEach((n,i)=>{pos.set(n.id,{x:70+(i%cols)*(W-120)/(cols-1),y:44+Math.floor(i/cols)*74})});
    const lines=edges.map(e=>{const a=pos.get(e.from),b=pos.get(e.to);if(!a||!b)return"";return '<line x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke="currentColor" stroke-width="1.2" opacity="0.28"/>'}).join("");
    const boxes=nodes.map(n=>{const p=pos.get(n.id);return '<g><rect x="'+(p.x-52)+'" y="'+(p.y-15)+'" width="104" height="30" rx="8" fill="var(--surface)" stroke="var(--line-strong)"/><text x="'+p.x+'" y="'+(p.y+4)+'" text-anchor="middle" font-size="10.5" fill="currentColor">'+esc(String(n.label).slice(0,16))+'</text></g>'}).join("");
    svg='<section class="panel"><h3>Import Graph <span class="hint">'+nodes.length+' nodes · '+edges.length+' edges</span></h3><svg class="graph" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="import graph">'+lines+boxes+'</svg></section>';
  }
  let wsList="";
  try{const wss=await api("/api/workspaces");wsList=(wss.workspaces||[]).map(w=>'<option value="'+attr(w.name)+'"'+(w.name===wsSel?" selected":"")+'>'+esc(w.name)+'</option>').join("")}catch(e){}
  const gInfo=g?stats([[g.built?"YES":"NO","graph built"],[g.nodes==null?"—":g.nodes,"nodes"],[g.edges==null?"—":g.edges,"edges"],[g.available?"OK":"NO CLI","graphify"]]):empty("graphify belum terdeteksi");
  v.innerHTML='<section class="panel"><h3>Live Workspace <span class="hint">update '+esc(new Date(d.generatedAt||Date.now()).toLocaleTimeString())+'</span></h3>'
    +'<div class="row" style="margin-bottom:12px"><label for="diag-ws">Workspace</label><select id="diag-ws" style="max-width:260px">'+(wsList||'<option value="default">default</option>')+'</select>'
    +'<label style="display:inline-flex;align-items:center;gap:6px;text-transform:none;letter-spacing:0"><input type="checkbox" id="diag-auto" checked> auto refresh</label></div>'
    +'<div class="split"><div><div class="k" style="margin-bottom:8px">Files</div><div class="tree">'+(tree||'<span class="chip">workspace kosong</span>')+'</div></div>'
    +'<div><div class="k" style="margin-bottom:8px">Git</div><pre>'+(d.gitStat?esc(String(d.gitStat).slice(0,1500)):"clean")+'</pre></div></div></section>'
  +'<section class="panel"><h3>Recent Runs</h3>'+table(["id","input","status","time"],runs)+'</section>'
  +planHtml+svg
  +'<section class="panel"><h3>Graphify</h3>'+gInfo+'<pre style="margin-top:12px">'+esc(JSON.stringify(g,null,2))+'</pre></section>';
  bind("diag-ws","change",function(){try{localStorage.setItem("diagram_ws",$("diag-ws").value)}catch(e){}VIEWS.Diagram($("view"))});
  const chk=$("diag-auto");
  if(chk&&chk.checked)schedule(function(){if(cur==="Diagram")VIEWS.Diagram($("view"))},3000);
},
Sessions:async v=>{
  const d=await api("/api/sessions?limit=50");
  const rows=(d.sessions||[]).map(s=>[shortId(s.id),shortId(s.chat_id),esc(s.provider)+" / "+esc(s.model),badge(s.status,statusKind(s.status)),esc(String(s.updated_at||""))]);
  v.innerHTML='<section class="panel"><h3>Sessions <span class="hint">'+(d.sessions||[]).length+' terbaru</span></h3>'+table(["id","chat","provider / model","status","updated"],rows)+'</section>';
},
Runs:async v=>{
  const d=await api("/api/runs?limit=50");
  const rows=(d.runs||[]).map(r=>[shortId(r.id),shortId(r.session_id),esc(String(r.input||"").slice(0,90)),badge(r.status,statusKind(r.status)),esc((r.tokens_input||0)+"+"+(r.tokens_output||0)),r.status==="running"?'<button class="btn danger" data-action="stop-run" data-id="'+attr(r.id)+'">Stop</button>':""]);
  v.innerHTML='<section class="panel"><h3>Runs <span class="hint">'+(d.runs||[]).length+' terbaru</span></h3>'+table(["id","session","input","status","tokens","aksi"],rows)+'</section>';
},
Approvals:async v=>{
  const d=await api("/api/approvals/pending");
  const list=d.approvals||[];
  const items=list.map(a=>'<div class="item"><div class="head"><span class="title">'+esc(a.tool)+' '+badge(a.risk,statusKind(String(a.risk).toLowerCase().replace("high","warn").replace("critical","bad")))+'</span><span class="mono">'+esc(String(a.id).slice(0,8))+'</span></div>'
    +'<pre style="max-height:150px">'+esc(a.command)+'</pre>'
    +'<div class="row"><button class="btn primary" data-action="approve" data-id="'+attr(a.id)+'">Approve</button><button class="btn danger" data-action="reject" data-id="'+attr(a.id)+'">Reject</button></div></div>').join("");
  v.innerHTML='<section class="panel"><h3>Pending Approvals <span class="hint">'+list.length+' nunggu</span></h3>'+(items||empty("Tidak ada approval yang nunggu"))+'</section>';
},
Workspaces:async v=>{
  const d=await api("/api/workspaces");
  const items=(d.workspaces||[]).map(w=>{
    const p=w.profile||{};
    const chips=Object.keys(p).filter(k=>p[k]).map(k=>'<span class="chip">'+esc(k+": "+p[k])+'</span>').join("");
    return '<div class="item"><div class="head"><span class="title">'+esc(w.name)+'</span><span class="mono" style="color:var(--muted)">'+esc(w.path)+'</span></div><div class="tree">'+(chips||'<span class="chip">profil belum terdeteksi</span>')+'</div></div>';
  }).join("");
  v.innerHTML='<section class="panel"><h3>Workspaces <span class="hint">'+(d.workspaces||[]).length+'</span></h3><div class="stack">'+(items||empty("Belum ada workspace"))+'</div></section>';
},
Providers:async v=>{
  const d=await api("/api/providers");
  const items=(d.providers||[]).map(p=>'<div class="item"><div class="head"><span class="title">'+esc(p.name)+' '+(p.selected?badge("selected","acc"):"")+'</span>'+(p.selected?badge(p.healthy?"healthy":"down",p.healthy?"ok":"bad"):badge("idle",""))+'</div>'
    +((p.models||[]).length?'<div class="tree">'+p.models.slice(0,10).map(m=>'<span class="chip">'+esc(m)+'</span>').join("")+'</div>':'<div class="sub">tidak ada daftar model</div>')+'</div>').join("");
  v.innerHTML='<section class="panel"><h3>Providers <span class="hint">health dicek hanya untuk provider aktif</span></h3><div class="stack">'+(items||empty("Tidak ada provider"))+'</div>'
    +'<div class="alert info" style="margin-top:12px"><div>Ganti provider dari <code>.env</code> (PROVIDER), lewat tab Settings, atau <code>/provider</code> di Telegram.</div></div></section>';
},
Usage:async v=>{
  const u=await api("/api/usage");
  const t=u.total||{runs:0,t_in:0,t_out:0,cost:0};
  const rows=(u.perModel||[]).map(m=>[esc(m.provider),esc(m.model),esc(m.runs),esc((m.t_in+m.t_out)),"$"+Number(m.cost).toFixed(4)]);
  v.innerHTML='<section class="panel"><h3>Total</h3>'+stats([[t.runs,"runs"],[t.t_in+t.t_out,"tokens"],["$"+Number(t.cost).toFixed(4),"cost"]])+'</section>'
  +'<section class="panel"><h3>Per model</h3>'+table(["provider","model","runs","tokens","cost"],rows)+'</section>';
},
Audit:async v=>{
  const d=await api("/api/audit?limit=100");
  const rows=(d.logs||[]).map(l=>[esc(String(l.created_at||"").slice(0,19)),esc(l.tool||""),badge(l.risk||"-",statusKind(String(l.risk||"").toLowerCase().replace("high","warn").replace("critical","bad"))),esc(l.approval||""),esc(l.exit_code==null?"":l.exit_code),esc(l.duration_ms==null?"":l.duration_ms)]);
  v.innerHTML='<section class="panel"><h3>Audit <span class="hint">100 terbaru · secret di-redact</span></h3>'+table(["time","tool","risk","approval","exit","ms"],rows)+'</section>';
},
Settings:async v=>{
  const pair=await Promise.all([api("/api/settings"),api("/api/provider-config")]);
  const d=pair[0],prov=pair[1];
  const rows=(d.settings||[]).map(s=>['<code>'+esc(s.key)+'</code>',esc(s.scope)+" / "+esc(String(s.scope_id||"").slice(0,8)),'<code>'+esc(String(s.value).slice(0,60))+'</code>']);
  v.innerHTML='<section class="panel"><h3>Provider Config</h3><p class="sub">Sama seperti <code>.env</code>: PROVIDER, endpoint, API key, model. Disimpan ke <code>.env</code> dan langsung aktif tanpa restart.</p>'
  +'<div class="split"><div>'
  +'<div class="fld"><label for="p-provider-sel">Provider</label><select id="p-provider-sel">'+["9router","openai","xai","anthropic","ollama","custom"].map(p=>'<option value="'+p+'"'+(p===prov.provider?" selected":"")+'>'+p+'</option>').join("")+'</select></div>'
  +'<div class="fld"><label for="p-base">Endpoint (PROVIDER_BASE_URL)</label><input id="p-base" value="'+attr(prov.baseUrl||"")+'" placeholder="https://api.openai.com/v1"></div>'
  +'<div class="fld"><label for="p-key">API Key (PROVIDER_API_KEY)</label><input id="p-key" type="password" placeholder="kosongkan jika tidak diganti"></div>'
  +'<div class="fld"><label for="p-model">Model (PROVIDER_MODEL)</label><input id="p-model" value="'+attr(prov.model||"")+'" placeholder="auto"></div>'
  +'<div class="row" style="margin-top:12px"><button class="btn primary" data-action="save-provider">Save provider</button><span id="p-save-msg" class="sub" style="margin:0"></span></div></div>'
  +'<div class="item"><div class="k">Saat ini</div>'+kv([["provider",esc(prov.provider)],["endpoint",'<code>'+esc(prov.baseUrl||"(preset)")+'</code>'],["api key",prov.hasKey?esc(prov.apiKeyMasked):"— belum ada"],["model",'<code>'+esc(prov.model)+'</code>']])+'</div></div></section>'
  +'<section class="panel"><h3>Settings</h3>'+table(["key","scope","value"],rows)+'</section>'
  +'<section class="panel"><h3>Set Manual</h3><div class="split"><div>'
  +'<div class="fld"><label for="s-key">key</label><input id="s-key" placeholder="model"></div>'
  +'<div class="fld"><label for="s-val">value</label><input id="s-val" placeholder="cph/cehpoint-ai"></div>'
  +'<div class="fld"><label for="s-scope">scope</label><select id="s-scope"><option>global</option><option>session</option><option>workspace</option><option>user</option></select></div>'
  +'<div class="fld"><label for="s-id">scope id (opsional)</label><input id="s-id" placeholder=""></div>'
  +'<div class="row" style="margin-top:12px"><button class="btn" data-action="save-setting">Save setting</button></div></div>'
  +'<div class="alert warn"><div>Key rahasia (token/api key/secret) ditolak di sini — set lewat <code>.env</code> saja.</div></div></div></section>';
},
Graphify:async v=>{
  let opts="";
  try{const ws=(await api("/api/workspaces")).workspaces||[];opts=ws.map(w=>'<option value="'+attr(w.name)+'">'+esc(w.name)+'</option>').join("")}catch(e){}
  v.innerHTML='<section class="panel"><h3>Knowledge Graph</h3><div class="row"><label for="g-ws">workspace</label><select id="g-ws" style="max-width:220px">'+opts+'</select></div>'
  +'<div class="row" style="margin-top:10px"><button class="btn" data-action="g-status">Status</button><button class="btn primary" data-action="g-build">Build</button><button class="btn" data-action="g-update">Update</button><button class="btn" data-action="g-preview">Preview</button></div>'
  +'<pre id="g-out" style="margin-top:12px">Pilih workspace lalu cek status.</pre></section>'
  +'<section class="panel"><h3>Graph <span class="hint">viewer TeleAgent · data graph.json asli</span></h3><div class="frame"><iframe id="g-frame" src="about:blank" title="Graph workspace" loading="lazy"></iframe></div>'
  +'<div class="row" style="margin-top:10px"><button class="btn" data-action="g-preview">Muat ulang viewer</button><a class="btn" id="g-open" href="#" target="_blank" rel="noopener">Buka layar penuh</a><a class="btn" id="g-raw" href="#" target="_blank" rel="noopener">Output asli graphify</a></div><div id="g-preview-msg" class="sub" style="margin-top:8px"></div></section>'
  +'<section class="panel"><h3>Report <span class="hint">GRAPH_REPORT.md</span></h3><pre id="g-report">Belum ada report — build dulu.</pre></section>'
  +'<section class="panel"><h3>Query</h3><div class="fld"><label for="g-q">pertanyaan / simbol</label><input id="g-q" placeholder="what connects auth to database?"></div>'
  +'<div class="row" style="margin-top:10px"><button class="btn primary" data-action="g-query">Query</button><button class="btn" data-action="g-explain">Explain symbol</button></div>'
  +'<div class="row" style="margin-top:12px"><input id="g-a" placeholder="from" style="flex:1;min-width:120px"><input id="g-b" placeholder="to" style="flex:1;min-width:120px"><button class="btn" data-action="g-path">Path</button></div>'
  +'<pre id="g-qout" style="margin-top:12px"></pre></section>';
  bind("g-ws","change",function(){gPreview()});
  schedule(gPreview,300);
},
};

function planText(p){
  if(!p)return "";
  const total=Math.max(p.steps.length,1);
  const done=p.steps.filter(s=>s.status==="completed"||s.status==="skipped").length;
  const lines=["objective: "+(p.objective||"(empty)"),"revision: "+p.revision+" · progress: "+done+"/"+p.steps.length+" ("+Math.round(done/total*100)+"%)",""];
  for(const s of p.steps)lines.push(" "+(STEP_ICON[s.status]||"•")+" ["+s.phase+"] "+s.title+(s.note?" — "+s.note:""));
  if(p.verification&&p.verification.length){lines.push("","verification:");for(const x of p.verification)lines.push(" - "+x)}
  if(p.completionCriteria&&p.completionCriteria.length){lines.push("","completion criteria:");for(const c of p.completionCriteria)lines.push(" - "+c)}
  return lines.join("\\n");
}

/* ---------- tabs ---------- */
function renderTabs(){
  const host=$("tabs");
  if(!host)return;
  host.innerHTML=TABS.map(t=>'<button class="tab" role="tab" data-tab="'+attr(t)+'" aria-selected="'+(t===cur)+'"'+(t===cur?' aria-current="page"':"")+'>'+esc(t)+'</button>').join("");
  // keep the active tab visible in the horizontal strip (phone-width nav)
  try{
    if(document.querySelector&&host.querySelector){
      const active=host.querySelector('[aria-selected="true"]');
      if(active&&active.scrollIntoView)active.scrollIntoView({block:"nearest",inline:"center"});
    }
  }catch(e){}
}
function go(t,nav){
  if(!ROUTES[t])return;
  cur=t;setTitle();renderTabs();
  if(nav!==false)pushPath(ROUTES[t]);
  refresh();
}

/* ---------- status pills ---------- */
async function refreshStatus(){
  const st=$("p-status"),pv=$("p-provider"),rn=$("p-runs");
  try{
    const s=await api("/api/status");
    if(st){st.textContent=s.health.status;st.className="pill "+statusKind(s.health.status)}
    if(pv){pv.textContent=s.provider+" · "+s.model}
    if(rn){rn.textContent=s.activeRuns+" running"}
  }catch(e){
    if(st){st.textContent="offline";st.className="pill bad"}
    if(pv){pv.textContent="—"}
    if(rn){rn.textContent="—"}
  }
}

/* ---------- refresh ---------- */
let lastRendered="";
async function refresh(){
  renderTabs();
  const switched=lastRendered!==cur;
  lastRendered=cur;
  await refreshStatus();
  const v=$("view");
  if(!v)return;
  // tab switches get one soft entrance; auto-refreshes must not re-animate
  try{v.className=switched?"view anim":"view"}catch(e){}
  if(switched)schedule(function(){try{v.className="view"}catch(e){}},340);
  v.innerHTML=skeleton();
  try{await VIEWS[cur](v)}catch(e){v.innerHTML='<div class="alert"><div><b>Tidak bisa memuat tab '+esc(cur)+'</b><div>'+esc(e&&e.message?e.message:String(e))+'</div></div></div>'}
}

/* ---------- graphify actions ---------- */
function wsValue(){const el=$("g-ws");return el&&el.value?el.value:"default"}
async function gStatus(){
  const out=$("g-out");if(out)out.textContent="Mengecek status...";
  try{const s=await api("/api/graphify/status?workspace="+encodeURIComponent(wsValue()));if(out)out.textContent=JSON.stringify(s,null,2);gPreview()}
  catch(e){if(out)out.textContent=e.message}
}
async function gBuild(updateOnly){
  const out=$("g-out");if(out)out.textContent="Memproses — bisa beberapa menit...";
  try{const r=await api("/api/graphify/build",{method:"POST",body:JSON.stringify({workspace:wsValue(),updateOnly:!!updateOnly})});if(out)out.textContent=JSON.stringify(r,null,2);schedule(gPreview,800)}
  catch(e){if(out)out.textContent=e.message}
}
async function gPreview(){
  const ws=wsValue();
  const frame=$("g-frame"),msg=$("g-preview-msg"),open=$("g-open"),raw=$("g-raw"),report=$("g-report");
  const q="?workspace="+encodeURIComponent(ws);
  if(frame)frame.src="/api/graphify/html"+q+"&embed=1";
  if(open)open.href="/api/graphify/html"+q;
  if(raw)raw.href="/api/graphify/raw"+q;
  if(msg)msg.textContent="Memuat viewer...";
  try{
    const rep=await api("/api/graphify/report?workspace="+encodeURIComponent(ws));
    if(report)report.textContent=String(rep.report||"").slice(0,12000);
    if(msg)msg.textContent="Preview & report dimuat — "+new Date().toLocaleTimeString();
  }catch(e){
    if(report)report.textContent="Belum ada report — build dulu untuk generate GRAPH_REPORT.md";
    if(msg)msg.textContent=String(e.message).indexOf("404")>=0?"Belum ada graph.html — build dulu":"Gagal memuat preview";
  }
}
async function gQuery(){
  const out=$("g-qout");if(out)out.textContent="Mencari...";
  try{const r=await api("/api/graphify/query",{method:"POST",body:JSON.stringify({workspace:wsValue(),question:$("g-q").value})});if(out)out.textContent=r.output||"(empty)"}
  catch(e){if(out)out.textContent=e.message}
}
async function gExplain(){
  const out=$("g-qout");if(out)out.textContent="Menjelaskan...";
  try{const r=await api("/api/graphify/explain",{method:"POST",body:JSON.stringify({workspace:wsValue(),symbol:$("g-q").value})});if(out)out.textContent=r.output||"(empty)"}
  catch(e){if(out)out.textContent=e.message}
}
async function gPath(){
  const out=$("g-qout");if(out)out.textContent="Menelusuri jalur...";
  try{const r=await api("/api/graphify/path",{method:"POST",body:JSON.stringify({workspace:wsValue(),from:$("g-a").value,to:$("g-b").value})});if(out)out.textContent=r.output||"(empty)"}
  catch(e){if(out)out.textContent=e.message}
}

/* ---------- actions ---------- */
async function stopRun(id){try{await api("/api/runs/"+encodeURIComponent(id)+"/stop",{method:"POST"})}catch(e){}refresh()}
async function resolveAppr(id,st){try{await api("/api/approvals/"+encodeURIComponent(id),{method:"POST",body:JSON.stringify({status:st})})}catch(e){}refresh()}
async function saveSetting(){
  try{await api("/api/settings",{method:"POST",body:JSON.stringify({key:$("s-key").value,value:$("s-val").value,scope:$("s-scope").value,scopeId:$("s-id").value})})}catch(e){}
  refresh();
}
async function saveProvider(){
  const msg=$("p-save-msg");if(msg)msg.textContent="Menyimpan...";
  try{
    const body={provider:$("p-provider-sel").value,baseUrl:$("p-base").value,model:$("p-model").value};
    const k=$("p-key").value;if(k)body.apiKey=k;
    const r=await api("/api/provider-config",{method:"POST",body:JSON.stringify(body)});
    if(msg)msg.textContent="Tersimpan — "+r.provider+" / "+(r.model||"auto");
    schedule(refresh,900);
  }catch(e){if(msg)msg.textContent="Gagal: "+e.message}
}
function showKeyModal(msg){try{const m=$("keymodal");if(!m)return;if(m.classList)m.classList.add("open");else m.style.display="flex";const e=$("pinErr");if(e)e.textContent=msg||"";const i=$("pinInput");if(i&&i.focus)i.focus()}catch(e){}}
function hideKeyModal(){try{const m=$("keymodal");if(!m)return;if(m.classList)m.classList.remove("open");else m.style.display="none"}catch(e){}}
function savePin(){try{const i=$("pinInput");const v=i?String(i.value||"").trim():"";const e=$("pinErr");if(v.length<4){if(e)e.textContent="PIN minimal 4 karakter.";return}localStorage.setItem("teleagent_key",v);if(i)i.value="";hideKeyModal();refresh()}catch(e){}}

/* ---------- bindings ---------- */
function bind(id,evt,fn){try{const el=$(id);if(el&&el.addEventListener)el.addEventListener(evt,fn)}catch(e){}}
function schedule(fn,ms){try{return setTimeout(fn,ms)}catch(e){return 0}}
function onKeys(ev){
  try{
    if(!ev||ev.ctrlKey||ev.metaKey||ev.altKey)return;
    const t=ev.target||{};
    const tag=String(t.tagName||"").toUpperCase();
    if(tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT"||t.isContentEditable)return;
    if(ev.key!=="ArrowRight"&&ev.key!=="ArrowLeft")return;
    const i=TABS.indexOf(cur);
    const n=ev.key==="ArrowRight"?(i+1)%TABS.length:(i-1+TABS.length)%TABS.length;
    go(TABS[n]);
    if(ev.preventDefault)ev.preventDefault();
  }catch(e){}
}
function onEvent(ev){
  const tgt=ev&&ev.target;
  const closest=tgt&&tgt.closest?function(sel){return tgt.closest(sel)}:function(){return null};
  const tabEl=closest("[data-tab]");
  if(tabEl&&tabEl.dataset&&tabEl.dataset.tab){ev.preventDefault&&ev.preventDefault();go(tabEl.dataset.tab);return}
  const actEl=closest("[data-action]");
  if(!actEl||!actEl.dataset)return;
  const act=actEl.dataset.action,id=actEl.dataset.id||"";
  if(ev.preventDefault&&actEl.tagName==="A")ev.preventDefault();
  switch(act){
    case "refresh":refresh();break;
    case "key":showKeyModal();break;
    case "save-pin":savePin();break;
    case "skip-pin":hideKeyModal();break;
    case "theme":toggleTheme();break;
    case "stop-run":stopRun(id);break;
    case "approve":resolveAppr(id,"approved");break;
    case "reject":resolveAppr(id,"rejected");break;
    case "save-setting":saveSetting();break;
    case "save-provider":saveProvider();break;
    case "g-status":gStatus();break;
    case "g-build":gBuild(false);break;
    case "g-update":gBuild(true);break;
    case "g-preview":gPreview();break;
    case "g-query":gQuery();break;
    case "g-explain":gExplain();break;
    case "g-path":gPath();break;
    default:break;
  }
}

/* ---------- boot ---------- */
applyTheme(storedTheme());
setTitle();
bind("pinInput","input",function(){try{const i=$("pinInput");if(i&&String(i.value||"").length>=6)savePin()}catch(e){}});
bind("pinInput","keydown",function(ev){try{if(ev&&ev.key==="Enter")savePin()}catch(e){}});
if(!key())showKeyModal();
try{if(typeof document!=="undefined"&&document.addEventListener){document.addEventListener("click",onEvent)} }catch(e){}
try{if(typeof window!=="undefined"&&window.addEventListener){window.addEventListener("popstate",function(){const t=tabFromPath(location.pathname);if(t!==cur){cur=t;setTitle();refresh()}})} }catch(e){}
try{if(typeof document!=="undefined"&&document.addEventListener){document.addEventListener("visibilitychange",function(){if(!document.hidden)refresh()})} }catch(e){}
try{if(typeof document!=="undefined"&&document.addEventListener){document.addEventListener("keydown",onKeys)} }catch(e){}
renderTabs();
refresh();
try{setInterval(function(){try{if(typeof document!=="undefined"&&document.hidden)return}catch(e){}if(cur==="Approvals"||cur==="Runs"||cur==="Status")refresh()},15000)}catch(e){}
`;

export function dashboardPage(opts?: { activeTab?: string }): string {
  const active = opts?.activeTab && TAB_ROUTES[opts.activeTab] ? opts.activeTab : "Status";
  const title = active === "Status" ? DASHBOARD_TITLE : `${DASHBOARD_TITLE} · ${active}`;
  return `<!DOCTYPE html>
<html lang="id" data-active-tab="${active}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="TeleAgent Super Harness — live control plane: runs, approvals, workspaces, providers, usage, audit, knowledge graph.">
<meta name="robots" content="noindex">
<meta property="og:title" content="TeleAgent — Super Harness">
<meta property="og:description" content="Live control plane untuk agent coding Telegram: runs, approvals, workspaces, providers, usage, audit, knowledge graph.">
<meta property="og:type" content="website">
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<meta name="theme-color" content="#f4f5f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0e14" media="(prefers-color-scheme: dark)">
<title>${title}</title>
<style>
${BASE_CSS}
</style>
</head>
<body>
<a class="skip" href="#view">Lewati ke konten</a>
<div class="top">
  <header class="topbar">
    <div class="brand"><img src="/logo.svg" alt="" width="26" height="26" style="width:26px;height:26px;vertical-align:-6px;border-radius:8px"><span>TeleAgent</span><span class="tag">super harness</span></div>
    <div class="statusline" role="status" aria-live="polite">
      <span class="pill" id="p-status">…</span>
      <span class="pill" id="p-provider">…</span>
      <span class="pill" id="p-runs">…</span>
    </div>
    <div class="actions">
      <button class="btn" data-action="refresh" type="button">Refresh</button>
      <button class="btn" data-action="key" type="button">PIN</button>
      <button class="btn icon" data-action="theme" type="button" title="Ganti tema" aria-label="Ganti tema">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M13.4 10.1A5.8 5.8 0 0 1 5.9 2.6 5.9 5.9 0 1 0 13.4 10.1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </header>
  <nav id="tabs" class="tabs" role="tablist" aria-label="Bagian dashboard"></nav>
</div>
<main id="view" class="view" role="tabpanel" aria-live="polite"></main>
<div class="overlay" id="keymodal" role="dialog" aria-modal="true" aria-labelledby="keymodal-title">
  <div class="modal">
    <h2 id="keymodal-title">Masuk Dashboard</h2>
    <div class="sub">Masukkan PIN 6 digit untuk membuka semua tab.</div>
    <input id="pinInput" type="password" inputmode="numeric" autocomplete="off" maxlength="64" placeholder="••••••" aria-label="PIN dashboard">
    <div class="err" id="pinErr"></div>
    <div class="row" style="justify-content:center;margin-top:12px"><button class="btn primary" data-action="save-pin" type="button">Masuk</button></div>
    <button class="skip" data-action="skip-pin" type="button">Lewati dulu (cuma Status)</button>
  </div>
</div>
<footer class="foot">TeleAgent · <code>/api/status</code> publik · <code>/api/doctor</code> untuk diagnosa lengkap</footer>
<script>
${SCRIPT}</script>
</body>
</html>`;
}
