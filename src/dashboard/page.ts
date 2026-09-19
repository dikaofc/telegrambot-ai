/** TeleAgent dashboard — neo brutalism, fully functional, responsive */
export const DASHBOARD_TITLE = "TeleAgent — Super Harness";

export function dashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DASHBOARD_TITLE}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
<style>
:root{--bg:#f4f4f0;--panel:#ffffff;--ink:#0a0a0a;--line:#0a0a0a;--acc:#ff3b30;--acc2:#00e5ff;--ok:#00c853;--warn:#ffab00;--bad:#ff1744;--shadow:6px 6px 0 var(--ink)}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font-family:"Space Grotesk",system-ui,sans-serif}
header{position:sticky;top:0;z-index:10;background:var(--acc);color:#fff;border-bottom:4px solid var(--ink);display:flex;align-items:center;gap:12px;padding:12px 16px;flex-wrap:wrap}
header h1{margin:0;font-size:22px;font-weight:800;letter-spacing:-0.02em;text-transform:uppercase}
header h1 span{background:#fff;color:var(--ink);padding:2px 8px;border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);margin-left:8px;font-size:14px}
.pill{border:3px solid var(--ink);background:#fff;color:var(--ink);padding:6px 12px;font-weight:800;font-size:12px;box-shadow:3px 3px 0 var(--ink);text-transform:uppercase}
.pill.ok{background:var(--ok);color:#fff}.pill.warn{background:var(--warn)}.pill.bad{background:var(--bad);color:#fff}
.hdr-actions{display:flex;gap:8px;align-items:center;margin-left:auto;flex-wrap:wrap}
.hdr-actions input{border:3px solid var(--ink);padding:8px 10px;font-weight:700;background:#fff;box-shadow:3px 3px 0 var(--ink);width:220px}
.hdr-actions button{border:3px solid var(--ink);background:var(--ink);color:#fff;padding:8px 14px;font-weight:800;cursor:pointer;box-shadow:3px 3px 0 #fff;text-transform:uppercase}
.hdr-actions button:active{transform:translate(2px,2px);box-shadow:1px 1px 0 #fff}
.burger{display:none;border:3px solid var(--ink);background:#fff;padding:8px 12px;font-weight:800;box-shadow:3px 3px 0 var(--ink);cursor:pointer}
nav{display:flex;gap:10px;padding:14px 16px;background:var(--bg);border-bottom:4px solid var(--ink);overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav button{flex:0 0 auto;border:3px solid var(--ink);background:var(--panel);color:var(--ink);padding:10px 16px;font-weight:800;font-size:13px;cursor:pointer;box-shadow:4px 4px 0 var(--ink);text-transform:uppercase;white-space:nowrap}
nav button.active{background:var(--acc);color:#fff;transform:translate(-1px,-1px);box-shadow:5px 5px 0 var(--ink)}
nav button:active{transform:translate(2px,2px);box-shadow:2px 2px 0 var(--ink)}
main{max-width:1200px;margin:0 auto;padding:18px}
.panel{background:var(--panel);border:4px solid var(--ink);box-shadow:var(--shadow);padding:16px;margin-bottom:16px}
.panel h3{margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:-0.01em;border-left:6px solid var(--acc);padding-left:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.card{border:3px solid var(--ink);background:#fff;box-shadow:4px 4px 0 var(--ink);padding:14px}
.card b{display:block;font-size:28px;font-weight:800;line-height:1}
.card span{font-weight:700;text-transform:uppercase;font-size:12px}
table{width:100%;border-collapse:collapse;border:3px solid var(--ink)}
th,td{padding:10px 12px;border-bottom:3px solid var(--ink);text-align:left;vertical-align:top;font-size:13px}
th{background:var(--ink);color:#fff;font-weight:800;text-transform:uppercase;letter-spacing:0.02em}
tr:nth-child(even) td{background:#f7f7f5}
code{font-family:"JetBrains Mono",monospace;background:#fff;border:2px solid var(--ink);padding:2px 6px;font-weight:700;box-shadow:2px 2px 0 var(--ink)}
pre{background:#0a0a0a;color:#00ff88;border:4px solid var(--ink);box-shadow:4px 4px 0 var(--ink);padding:14px;overflow:auto;max-height:420px;font-family:"JetBrains Mono",monospace;font-size:12px;white-space:pre-wrap;word-break:break-word}
button.act{border:3px solid var(--ink);background:var(--acc2);color:var(--ink);padding:8px 14px;font-weight:800;box-shadow:3px 3px 0 var(--ink);cursor:pointer;text-transform:uppercase}
button.act.danger{background:var(--bad);color:#fff}
button.ghost{border:3px solid var(--ink);background:#fff;color:var(--ink);padding:8px 14px;font-weight:800;box-shadow:3px 3px 0 var(--ink);cursor:pointer}
input,select,textarea{border:3px solid var(--ink);background:#fff;padding:10px 12px;font-weight:700;width:100%;box-shadow:3px 3px 0 var(--ink);font-family:inherit}
label{font-weight:800;text-transform:uppercase;font-size:12px;display:block;margin-top:8px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.hidden{display:none}
.badge{display:inline-block;border:2px solid var(--ink);padding:2px 8px;font-weight:800;font-size:11px;box-shadow:2px 2px 0 var(--ink);text-transform:uppercase}
@media(max-width:900px){
  .burger{display:block}
  nav{display:none;flex-direction:column}
  nav.open{display:flex}
  header h1{font-size:18px}
  .hdr-actions{width:100%}
  .hdr-actions input{width:1fr;flex:1}
  main{padding:12px}
  .grid{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:520px){.grid{grid-template-columns:1fr} table{font-size:12px} th,td{padding:8px}}
</style>
</head>
<body>
<header>
  <h1>TELEAGENT <span>SUPER HARNESS</span></h1>
  <span class="pill" id="p-status">…</span>
  <span class="pill" id="p-provider">…</span>
  <span class="pill" id="p-runs">…</span>
  <div class="hdr-actions">
    <input id="apiKey" type="password" placeholder="API key (jika ada)">
    <button onclick="saveKey()">SAVE</button>
    <button onclick="refresh()">REFRESH</button>
    <button class="burger" onclick="toggleNav()">MENU</button>
  </div>
</header>
<nav id="tabs"></nav>
<main id="view"></main>
<script>
const TABS=["Status","Diagram","Sessions","Runs","Approvals","Workspaces","Providers","Usage","Audit","Settings","Graphify"];
let cur="Status";
const $=id=>document.getElementById(id);
function key(){return localStorage.getItem("teleagent_key")||""}
function saveKey(){localStorage.setItem("teleagent_key",$("apiKey").value);refresh()}
$("apiKey").value=key();
function toggleNav(){const n=$("tabs");n.classList.toggle("open")}
async function api(path,opts={}){
  const r=await fetch(path,{...opts,headers:{...(opts.headers||{}),"content-type":"application/json","x-api-key":key()}});
  if(!r.ok)throw new Error("HTTP "+r.status+": "+(await r.text()).slice(0,400));
  return r.json();
}
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function renderTabs(){$("tabs").innerHTML=TABS.map(t=>'<button class="'+(t===cur?"active":"")+'" onclick="go(\\''+t+'\\')">'+t+"</button>").join("")}
function go(t){cur=t;renderTabs();if(window.innerWidth<=900)$("tabs").classList.remove("open");refresh()}
async function refresh(){
  renderTabs();
  try{
    const s=await api("/api/status");
    const st=$("p-status");st.textContent=s.health.status;st.className="pill "+(s.health.status==="ok"?"ok":s.health.status==="degraded"?"warn":"bad");
    $("p-provider").textContent=s.provider+" / "+s.model;
    $("p-runs").textContent="RUNS: "+s.activeRuns;
  }catch(e){$("p-status").textContent="OFFLINE";$("p-status").className="pill bad"}
  const v=$("view");v.innerHTML="<div class=\\"panel\\"><b>Memuat data...</b> sebentar</div>";
  try{await VIEWS[cur](v)}catch(e){v.innerHTML="<div class=\\"panel\\"><pre>"+esc(e.message)+"</pre></div>"}
}
const VIEWS={
Status:async v=>{
  const s=await api("/api/status");
  v.innerHTML='<div class="panel"><h3>Health</h3><pre>'+esc(JSON.stringify(s.health,null,2))+'</pre></div>'
  +'<div class="panel"><h3>Counts</h3><div class="grid">'+Object.entries(s.counts).map(([k,val])=>'<div class="card"><b>'+val+'</b><span>'+esc(k)+'</span></div>').join("")+'</div></div>'
  +'<div class="panel"><h3>Runtime</h3><pre>'+esc(JSON.stringify({provider:s.provider,model:s.model,activeRuns:s.activeRuns,access:s.access,workspace:s.workspace},null,2))+'</pre></div>';
},
Diagram:async v=>{
  const wsSel = localStorage.getItem("diagram_ws")||"default";
  const d = await api("/api/diagram?workspace="+encodeURIComponent(wsSel));
  const treeHtml = d.tree.length ? d.tree.map(f=>'<div style="border:2px solid var(--ink);padding:6px 10px;background:#fff;box-shadow:2px 2px 0 var(--ink);margin:4px 0;font-family:JetBrains Mono,monospace;font-size:12px">'+esc(f)+'</div>').join("") : '<div class="panel">Belum ada file — workspace masih kosong</div>';
  const runsHtml = d.runs.length ? d.runs.map(r=>'<tr><td><code>'+esc(r.id.slice(0,8))+'</code></td><td>'+esc(String(r.input).slice(0,60))+'</td><td><span class="badge">'+esc(r.status)+'</span></td><td>'+esc((r.created_at||"").slice(0,19))+'</td></tr>').join("") : '<tr><td colspan=4>Belum ada runs</td></tr>';
  const gitHtml = d.gitStat ? '<pre>'+esc(d.gitStat.slice(0,1500))+'</pre>' : '<pre>clean</pre>';
  const g = d.graphStatus;
  const gInfo = g ? '<div class="grid"><div class="card"><b>'+(g.built?"YES":"NO")+'</b><span>graph built</span></div><div class="card"><b>'+(g.nodes??"—")+'</b><span>nodes</span></div><div class="card"><b>'+(g.edges??"—")+'</b><span>edges</span></div><div class="card"><b>'+(g.available?"OK":"NO CLI")+'</b><span>graphify</span></div></div>' : '<div class="panel">graphify belum ada</div>';
  // simple SVG for graph: nodes as boxes, edges as lines (real data, not mock)
  let svg = "";
  if(d.graph && d.graph.nodes.length){
    const nodes = d.graph.nodes.slice(0,40);
    const edges = d.graph.edges.slice(0,60);
    const W=900, H=320, cols=8;
    const pos = new Map();
    nodes.forEach((n,i)=>{ const x= 80 + (i%cols)*110, y= 40 + Math.floor(i/cols)*70; pos.set(n.id,{x,y}); });
    let lines = edges.map(e=>{ const a=pos.get(e.from), b=pos.get(e.to); if(!a||!b) return ""; return '<line x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke="#0a0a0a" stroke-width="2" opacity="0.35"/>'; }).join("");
    let boxes = nodes.map(n=>{ const p=pos.get(n.id); return '<g><rect x="'+(p.x-45)+'" y="'+(p.y-14)+'" width="90" height="28" rx="0" fill="#fff" stroke="#0a0a0a" stroke-width="3"/><text x="'+p.x+'" y="'+(p.y+4)+'" text-anchor="middle" font-size="10" font-weight="800" font-family="JetBrains Mono,monospace">'+esc(n.label.slice(0,14))+'</text></g>'; }).join("");
    svg = '<div class="panel" style="overflow:auto"><div style="min-width:900px"><svg width="'+W+'" height="'+H+'" style="background:#fff;border:4px solid var(--ink);display:block">'+lines+boxes+'</svg></div><div style="margin-top:8px;font-weight:700">Live Graph — '+nodes.length+' nodes, '+edges.length+' edges • workspace: '+esc(d.workspace)+' • '+new Date(d.generatedAt).toLocaleTimeString()+'</div></div>';
  } else {
    svg = '<div class="panel">Graph belum dibangun — buka tab Graphify lalu BUILD, atau tunggu agent yang otomatis build saat ada task. Status: '+(g? (g.built?"built":"not built"):"unknown")+'</div>';
  }
  const wsOpts = ['default','telegrambot-ai'].map(n=>'<option value="'+n+'"'+(n===wsSel?' selected':"")+'>'+n+'</option>').join("");
  // also list real workspaces from API
  let wsList = "";
  try{ const wss=await api("/api/workspaces"); wsList=wss.workspaces.map(w=>'<option value="'+esc(w.name)+'"'+(w.name===wsSel?' selected':"")+'>'+esc(w.name)+'</option>').join(""); }catch{}
  v.innerHTML='<div class="panel"><h3>Live Diagram — Workspace & File Activity</h3><div class="row"><label>Workspace</label><select id="diag-ws" onchange="localStorage.setItem(\\'diagram_ws\\',this.value);VIEWS.Diagram(document.getElementById(\\'view\\'))">'+(wsList||wsOpts)+'</select><label style="margin-left:8px"><input type="checkbox" id="diag-auto" checked> Auto refresh (3s)</label><span style="margin-left:auto;font-weight:800">Update: '+new Date(d.generatedAt).toLocaleTimeString()+'</span></div></div>'
  +'<div class="grid" style="grid-template-columns:1.2fr 1fr;gap:12px"><div class="panel"><h3>File Tree (live, 120 files)</h3><div style="max-height:380px;overflow:auto">'+treeHtml+'</div></div><div class="panel"><h3>Git Status</h3>'+gitHtml+'</div></div>'
  +'<div class="panel"><h3>Recent Runs (live)</h3><table><tr><th>id</th><th>input</th><th>status</th><th>time</th></tr>'+runsHtml+'</table></div>'
  +svg
  +'<div class="panel"><h3>Graphify Live</h3>'+gInfo+'<pre>'+esc(JSON.stringify(g,null,2))+'</pre></div>';
  // auto refresh if checked
  const chk=document.getElementById("diag-auto");
  if(chk && chk.checked){ setTimeout(()=>{ if(cur==="Diagram") VIEWS.Diagram(v); },3000); }
},
Sessions:async v=>{
  const d=await api("/api/sessions?limit=50");
  v.innerHTML='<div class="panel"><h3>Sessions ('+d.sessions.length+')</h3><table><tr><th>id</th><th>chat</th><th>provider/model</th><th>status</th><th>updated</th></tr>'
  +d.sessions.map(s=>'<tr><td><code>'+esc(s.id.slice(0,8))+'</code></td><td><code>'+esc(s.chat_id.slice(0,8))+'</code></td><td>'+esc(s.provider)+' / '+esc(s.model)+'</td><td><span class="badge">'+esc(s.status)+'</span></td><td>'+esc(s.updated_at||"")+'</td></tr>').join("")+'</table></div>';
},
Runs:async v=>{
  const d=await api("/api/runs?limit=50");
  v.innerHTML='<div class="panel"><h3>Runs ('+d.runs.length+')</h3><table><tr><th>id</th><th>session</th><th>input</th><th>status</th><th>tokens</th><th>aksi</th></tr>'
  +d.runs.map(r=>'<tr><td><code>'+esc(r.id.slice(0,8))+'</code></td><td><code>'+esc(String(r.session_id).slice(0,8))+'</code></td><td>'+esc(String(r.input).slice(0,80))+'</td><td><span class="badge">'+esc(r.status)+'</span></td><td>'+(r.tokens_input||0)+'+'+(r.tokens_output||0)+'</td><td>'+(r.status==="running"?'<button class="act danger" onclick="stopRun(\\''+r.id+'\\')">STOP</button>':"")+'</td></tr>').join("")+'</table></div>';
},
Approvals:async v=>{
  const d=await api("/api/approvals/pending");
  v.innerHTML='<div class="panel"><h3>Pending Approvals ('+d.approvals.length+')</h3><table><tr><th>id</th><th>tool</th><th>command</th><th>risk</th><th>aksi</th></tr>'
  +d.approvals.map(a=>'<tr><td><code>'+esc(a.id.slice(0,8))+'</code></td><td>'+esc(a.tool)+'</td><td><code>'+esc(String(a.command).slice(0,120))+'</code></td><td><span class="badge">'+esc(a.risk)+'</span></td><td><button class="act" onclick="resolveAppr(\\''+a.id+'\\',\\'approved\\')">APPROVE</button><button class="act danger" onclick="resolveAppr(\\''+a.id+'\\',\\'rejected\\')">REJECT</button></td></tr>').join("")+'</table></div>';
},
Workspaces:async v=>{
  const d=await api("/api/workspaces");
  v.innerHTML='<div class="panel"><h3>Workspaces</h3><table><tr><th>nama</th><th>path</th><th>profile</th></tr>'
  +d.workspaces.map(w=>'<tr><td><b>'+esc(w.name)+'</b></td><td><code>'+esc(w.path)+'</code></td><td><code>'+esc(JSON.stringify(w.profile||{}))+'</code></td></tr>').join("")+'</table></div>';
},
Providers:async v=>{
  const d=await api("/api/providers");
  v.innerHTML='<div class="panel"><h3>Providers</h3><table><tr><th>provider</th><th>selected</th><th>health</th><th>models (top 8)</th></tr>'
  +d.providers.map(p=>'<tr><td><b>'+esc(p.name)+'</b></td><td>'+(p.selected?'<span class="pill ok">SELECTED</span>':'—')+'</td><td>'+(p.healthy?'<span class="pill ok">OK</span>':'<span class="pill bad">DOWN</span>')+'</td><td><code>'+esc((p.models||[]).slice(0,8).join(", "))+'</code></td></tr>').join("")+'</table><div class="panel" style="margin-top:12px"><b>Tips:</b> ganti via <code>.env</code> PROVIDER atau <code>/provider</code> di Telegram. Single universal key.</div>';
},
Usage:async v=>{
  const u=await api("/api/usage");
  v.innerHTML='<div class="panel"><h3>Total</h3><div class="grid"><div class="card"><b>'+u.total.runs+'</b><span>runs</span></div><div class="card"><b>'+(u.total.t_in+u.total.t_out)+'</b><span>tokens</span></div><div class="card"><b>$'+Number(u.total.cost).toFixed(4)+'</b><span>cost</span></div></div></div>'
  +'<div class="panel"><h3>Per model</h3><table><tr><th>provider</th><th>model</th><th>runs</th><th>tokens</th><th>cost</th></tr>'
  +u.perModel.map(m=>'<tr><td>'+esc(m.provider)+'</td><td>'+esc(m.model)+'</td><td>'+m.runs+'</td><td>'+(m.t_in+m.t_out)+'</td><td>$'+Number(m.cost).toFixed(4)+'</td></tr>').join("")+'</table></div>';
},
Audit:async v=>{
  const d=await api("/api/audit?limit=100");
  v.innerHTML='<div class="panel"><h3>Audit (100 terbaru, secrets di-redact)</h3><table><tr><th>time</th><th>tool</th><th>risk</th><th>approval</th><th>exit</th><th>ms</th></tr>'
  +d.logs.map(l=>'<tr><td>'+esc((l.created_at||"").slice(0,19))+'</td><td>'+esc(l.tool||"")+'</td><td>'+esc(l.risk||"")+'</td><td>'+esc(l.approval||"")+'</td><td>'+(l.exit_code??"")+'</td><td>'+(l.duration_ms??"")+'</td></tr>').join("")+'</table></div>';
},
Settings:async v=>{
  const [d, prov] = await Promise.all([api("/api/settings"), api("/api/provider-config")]);
  v.innerHTML='<div class="panel"><h3>Provider Config — Mirip .env, Lewat Dashboard</h3>'
  +'<p style="font-weight:700;margin-top:0">Atur provider kayak di .env: PROVIDER, endpoint, API key, model. Disimpen ke .env & langsung aktif tanpa restart.</p>'
  +'<label>Provider</label><select id="p-provider-sel"><option value="9router">9router</option><option value="openai">openai</option><option value="xai">xai</option><option value="anthropic">anthropic</option><option value="ollama">ollama</option><option value="custom">custom</option></select>'
  +'<label>Endpoint (PROVIDER_BASE_URL)</label><input id="p-base" placeholder="https://api.openai.com/v1 atau https://9router.../v1">'
  +'<label>API Key (PROVIDER_API_KEY)</label><input id="p-key" type="password" placeholder="sk-... (kosongkan jika tidak mau ganti)">'
  +'<label>Model (PROVIDER_MODEL)</label><input id="p-model" placeholder="oc/muse-spark-1.2-contributor-free">'
  +'<div class="row" style="margin-top:12px"><button class="act" onclick="saveProvider()">SAVE PROVIDER</button><span id="p-save-msg" style="font-weight:800"></span></div>'
  +'<div style="margin-top:12px;border:3px solid var(--ink);background:#f7f7f5;padding:10px"><b>Saat ini:</b> <code>'+esc(prov.provider)+'</code> • <code>'+esc(prov.baseUrl||"(preset)")+'</code> • key: '+(prov.hasKey?esc(prov.apiKeyMasked):"— belum ada")+' • model: <code>'+esc(prov.model)+'</code></div>'
  +'</div>'
  +'<div class="panel"><h3>Settings Lain</h3><table><tr><th>key</th><th>scope</th><th>value</th></tr>'
  +d.settings.map(s=>'<tr><td><code>'+esc(s.key)+'</code></td><td>'+esc(s.scope)+'/'+esc(s.scope_id.slice(0,8))+'</td><td><code>'+esc(String(s.value).slice(0,80))+'</code></td></tr>').join("")+'</table></div>'
  +'<div class="panel"><h3>Set Value Manual</h3><label>key</label><input id="s-key" placeholder="model"><label>value</label><input id="s-val" placeholder="cph/cehpoint-ai"><label>scope</label><select id="s-scope"><option>global</option><option>session</option><option>workspace</option><option>user</option></select><label>scope id (optional)</label><input id="s-id" placeholder=""><div class="row" style="margin-top:10px"><button class="act" onclick="saveSetting()">SAVE SETTING</button></div><p style="font-weight:700">Catatan: untuk provider gunakan panel di atas (bisa set API key). Key rahasia lain tetap via .env lebih aman.</p></div>';
  // prefill
  setTimeout(()=>{ const sel=$("p-provider-sel"); if(sel) sel.value=prov.provider; const b=$("p-base"); if(b) b.value=prov.baseUrl||""; const m=$("p-model"); if(m) m.value=prov.model||""; },50);
},
Graphify:async v=>{
  const ws=(await api("/api/workspaces")).workspaces;
  const opts=ws.map(w=>'<option value="'+esc(w.name)+'">'+esc(w.name)+'</option>').join("");
  v.innerHTML='<div class="panel"><h3>Knowledge Graph</h3><label>workspace</label><select id="g-ws" onchange="gPreview()">'+opts+'</select><div class="row"><button class="act" onclick="gStatus()">STATUS</button><button class="act" onclick="gBuild(false)">BUILD</button><button class="act ghost" onclick="gBuild(true)">UPDATE</button><button class="act ghost" onclick="gPreview()">PREVIEW</button></div><pre id="g-out">Pilih workspace untuk cek status</pre></div>'
  +'<div class="panel"><h3>Preview — Graph HTML (live)</h3><div style="border:4px solid var(--ink);background:#fff;min-height:320px;overflow:hidden"><iframe id="g-frame" style="width:100%;height:520px;border:0;display:block" src="about:blank"></iframe></div><div class="row" style="margin-top:10px"><button class="act ghost" onclick="gPreview()">REFRESH PREVIEW</button><a id="g-open" href="#" target="_blank" class="act ghost" style="text-decoration:none;display:inline-block">OPEN FULL</a></div><div id="g-preview-msg" style="font-weight:700;margin-top:8px"></div></div>'
  +'<div class="panel"><h3>Report — GRAPH_REPORT.md (detail)</h3><pre id="g-report" style="max-height:420px">Belum ada report — build dulu</pre></div>'
  +'<div class="panel"><h3>Query</h3><input id="g-q" placeholder="what connects auth to database?"><div class="row"><button class="act" onclick="gQuery()">QUERY</button><button class="act ghost" onclick="gExplain()">EXPLAIN SYMBOL</button></div><label>path from → to</label><div class="row"><input id="g-a" placeholder="UserService" style="flex:1"><input id="g-b" placeholder="DatabasePool" style="flex:1"><button class="act" onclick="gPath()">PATH</button></div><pre id="g-qout"></pre></div>';
  setTimeout(gPreview,300);
},
};
async function stopRun(id){await api("/api/runs/"+id+"/stop",{method:"POST"});refresh()}
async function resolveAppr(id,st){await api("/api/approvals/"+id,{method:"POST",body:JSON.stringify({status:st})});refresh()}
async function saveSetting(){await api("/api/settings",{method:"POST",body:JSON.stringify({key:$("s-key").value,value:$("s-val").value,scope:$("s-scope").value,scopeId:$("s-id").value})});refresh()}
async function saveProvider(){
  const msg=$("p-save-msg"); if(msg) msg.textContent="Menyimpan...";
  try{
    const body={provider:$("p-provider-sel").value, baseUrl:$("p-base").value, model:$("p-model").value};
    const key=$("p-key").value; if(key) body.apiKey=key;
    const r=await api("/api/provider-config",{method:"POST",body:JSON.stringify(body)});
    if(msg) msg.textContent="Tersimpan — "+r.provider+" / "+(r.model||"auto");
    setTimeout(refresh,800);
  }catch(e){ if(msg) msg.textContent="Gagal: "+e.message; }
}
async function gStatus(){
  try{
    const st=await api("/api/graphify/status?workspace="+encodeURIComponent($("g-ws").value));
    $("g-out").textContent=JSON.stringify(st,null,2);
    gPreview();
  }catch(e){$("g-out").textContent=e.message}
}
async function gBuild(u){
  $("g-out").textContent="Memproses — bisa beberapa menit";
  try{
    const r=await api("/api/graphify/build",{method:"POST",body:JSON.stringify({workspace:$("g-ws").value,updateOnly:u})});
    $("g-out").textContent=JSON.stringify(r,null,2);
    setTimeout(gPreview,800);
  }catch(e){$("g-out").textContent=e.message}
}
async function gPreview(){
  const ws=$("g-ws")?.value||"default";
  const frame=$("g-frame"), msg=$("g-preview-msg"), open=$("g-open"), report=$("g-report");
  if(frame){ frame.src="/api/graphify/html?workspace="+encodeURIComponent(ws); if(open) open.href="/api/graphify/html?workspace="+encodeURIComponent(ws); }
  if(msg) msg.textContent="Memuat preview...";
  try{
    const rep=await api("/api/graphify/report?workspace="+encodeURIComponent(ws));
    if(report) report.textContent=rep.report.slice(0,12000);
    if(msg) msg.textContent="Preview & report loaded — "+new Date().toLocaleTimeString();
  }catch(e){
    if(report) report.textContent="Belum ada report — build dulu untuk generate GRAPH_REPORT.md";
    if(msg) msg.textContent=e.message.includes("404")?"Belum ada graph.html — build dulu":"Gagal load preview";
  }
}
async function gQuery(){$("g-qout").textContent="Mencari...";try{$("g-qout").textContent=(await api("/api/graphify/query",{method:"POST",body:JSON.stringify({workspace:$("g-ws").value,question:$("g-q").value})})).output||"(empty)"}catch(e){$("g-qout").textContent=e.message}}
async function gExplain(){$("g-qout").textContent="Menjelaskan...";try{$("g-qout").textContent=(await api("/api/graphify/explain",{method:"POST",body:JSON.stringify({workspace:$("g-ws").value,symbol:$("g-q").value})})).output||"(empty)"}catch(e){$("g-qout").textContent=e.message}}
async function gPath(){$("g-qout").textContent="Menelusuri jalur...";try{$("g-qout").textContent=(await api("/api/graphify/path",{method:"POST",body:JSON.stringify({workspace:$("g-ws").value,from:$("g-a").value,to:$("g-b").value})})).output||"(empty)"}catch(e){$("g-qout").textContent=e.message}}
refresh();setInterval(()=>{if(cur==="Approvals"||cur==="Runs"||cur==="Status")refresh()},15000);
</script>
</body>
</html>`;
}
