/** TeleAgent dashboard — dependency-free single page (works offline on any device). */
export const DASHBOARD_TITLE = "TeleAgent Dashboard";

export function dashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DASHBOARD_TITLE}</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--txt:#e6edf3;--dim:#8b949e;--acc:#2f81f7;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5;flex-wrap:wrap}
header h1{font-size:16px;margin:0}.pill{padding:2px 10px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:var(--dim)}
.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.bad{color:var(--bad);border-color:var(--bad)}.pill.warn{color:var(--warn);border-color:var(--warn)}
nav{display:flex;gap:6px;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
nav button{background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
nav button.active{background:var(--acc);border-color:var(--acc)}
main{padding:16px;max-width:1100px;margin:0 auto}
section.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600}code{background:#0d1117;padding:1px 5px;border-radius:5px;font-size:12px;word-break:break-all}
button.act{background:var(--acc);color:#fff;border:0;border-radius:7px;padding:5px 11px;cursor:pointer;margin-right:6px}
button.danger{background:var(--bad)}button.ghost{background:transparent;border:1px solid var(--line);color:var(--txt)}
input,select,textarea{background:#0d1117;color:var(--txt);border:1px solid var(--line);border-radius:7px;padding:7px 9px;width:100%;margin:4px 0}
label{color:var(--dim);font-size:12px}pre{white-space:pre-wrap;word-break:break-word;background:#0d1117;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:420px;overflow:auto;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:#0d1117;border:1px solid var(--line);border-radius:8px;padding:10px}.card b{font-size:20px;display:block}
.hidden{display:none}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
</style>
</head>
<body>
<header>
<h1>🤖 TeleAgent</h1>
<span class="pill" id="p-status">…</span>
<span class="pill" id="p-provider">…</span>
<span class="pill" id="p-runs">…</span>
<span style="flex:1"></span>
<input id="apiKey" type="password" placeholder="API key (if set)" style="width:200px">
<button class="ghost" onclick="saveKey()">save</button>
<button class="ghost" onclick="refresh()">⟳ refresh</button>
</header>
<nav id="tabs"></nav>
<main id="view"></main>
<script>
const TABS=["Status","Sessions","Runs","Approvals","Workspaces","Providers","Usage","Audit","Settings","Graphify"];
let cur="Status";
const $=id=>document.getElementById(id);
function key(){return localStorage.getItem("teleagent_key")||""}
function saveKey(){localStorage.setItem("teleagent_key",$("apiKey").value);refresh()}
$("apiKey").value=key();
async function api(path,opts={}){
  const r=await fetch(path,{...opts,headers:{...(opts.headers||{}),"content-type":"application/json","x-api-key":key()}});
  if(!r.ok)throw new Error("HTTP "+r.status+": "+(await r.text()).slice(0,300));
  return r.json();
}
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function renderTabs(){$("tabs").innerHTML=TABS.map(t=>'<button class="'+(t===cur?"active":"")+'" onclick="go(\\''+t+'\\')">'+t+"</button>").join("")}
function go(t){cur=t;renderTabs();refresh()}
async function refresh(){
  renderTabs();
  try{
    const s=await api("/api/status");
    const st=$("p-status");st.textContent=s.health.status;st.className="pill "+(s.health.status==="ok"?"ok":s.health.status==="degraded"?"warn":"bad");
    $("p-provider").textContent=s.provider+" / "+s.model;$("p-provider").className="pill";
    $("p-runs").textContent="active runs: "+s.activeRuns;$("p-runs").className="pill "+(s.activeRuns>0?"warn":"");
  }catch(e){$("p-status").textContent="offline";$("p-status").className="pill bad"}
  const v=$("view");v.innerHTML="<p>loading…</p>";
  try{await VIEWS[cur](v)}catch(e){v.innerHTML="<pre>"+esc(e.message)+"</pre>"}
}
const VIEWS={
Status:async v=>{
  const s=await api("/api/status");
  v.innerHTML='<section class="panel"><h3>Health</h3><pre>'+esc(JSON.stringify(s.health,null,2))+'</pre></section>'
  +'<section class="panel"><h3>Counts</h3><div class="grid">'+Object.entries(s.counts).map(([k,val])=>'<div class="card"><b>'+val+'</b>'+esc(k)+'</div>').join("")+'</div></section>'
  +'<section class="panel"><h3>Runtime</h3><pre>'+esc(JSON.stringify({provider:s.provider,model:s.model,activeRuns:s.activeRuns,access:s.access,workspace:s.workspace},null,2))+'</pre></section>';
},
Sessions:async v=>{
  const d=await api("/api/sessions?limit=50");
  v.innerHTML='<section class="panel"><h3>Sessions ('+d.sessions.length+')</h3><table><tr><th>id</th><th>chat</th><th>provider/model</th><th>status</th><th>updated</th></tr>'
  +d.sessions.map(s=>'<tr><td><code>'+esc(s.id.slice(0,8))+'</code></td><td><code>'+esc(s.chat_id.slice(0,8))+'</code></td><td>'+esc(s.provider)+' / '+esc(s.model)+'</td><td>'+esc(s.status)+'</td><td>'+esc(s.updated_at||"")+'</td></tr>').join("")+'</table></section>';
},
Runs:async v=>{
  const d=await api("/api/runs?limit=50");
  v.innerHTML='<section class="panel"><h3>Runs ('+d.runs.length+')</h3><table><tr><th>id</th><th>session</th><th>input</th><th>status</th><th>tokens</th><th>action</th></tr>'
  +d.runs.map(r=>'<tr><td><code>'+esc(r.id.slice(0,8))+'</code></td><td><code>'+esc(String(r.session_id).slice(0,8))+'</code></td><td>'+esc(String(r.input).slice(0,80))+'</td><td>'+esc(r.status)+'</td><td>'+(r.tokens_input||0)+'+'+(r.tokens_output||0)+'</td><td>'+(r.status==="running"?'<button class="act danger" onclick="stopRun(\\''+r.id+'\\')">stop</button>':"")+'</td></tr>').join("")+'</table></section>';
},
Approvals:async v=>{
  const d=await api("/api/approvals/pending");
  v.innerHTML='<section class="panel"><h3>Pending approvals ('+d.approvals.length+')</h3><table><tr><th>id</th><th>tool</th><th>command</th><th>risk</th><th>action</th></tr>'
  +d.approvals.map(a=>'<tr><td><code>'+esc(a.id.slice(0,8))+'</code></td><td>'+esc(a.tool)+'</td><td><code>'+esc(String(a.command).slice(0,120))+'</code></td><td>'+esc(a.risk)+'</td><td><button class="act" onclick="resolveAppr(\\''+a.id+'\\',\\'approved\\')">approve</button><button class="act danger" onclick="resolveAppr(\\''+a.id+'\\',\\'rejected\\')">reject</button></td></tr>').join("")+'</table></section>';
},
Workspaces:async v=>{
  const d=await api("/api/workspaces");
  v.innerHTML='<section class="panel"><h3>Workspaces</h3><table><tr><th>name</th><th>path</th><th>profile</th></tr>'
  +d.workspaces.map(w=>'<tr><td>'+esc(w.name)+'</td><td><code>'+esc(w.path)+'</code></td><td>'+esc(JSON.stringify(w.profile||{}))+'</td></tr>').join("")+'</table></section>';
},
Providers:async v=>{
  const d=await api("/api/providers");
  v.innerHTML='<section class="panel"><h3>Providers (single universal key; switch via PROVIDER in .env)</h3><table><tr><th>provider</th><th>selected</th><th>health</th><th>models</th></tr>'
  +d.providers.map(p=>'<tr><td>'+esc(p.name)+'</td><td>'+(p.selected?'<span class="pill ok">selected</span>':'<span class="pill">—</span>')+'</td><td>'+(p.healthy?'<span class="pill ok">ok</span>':'<span class="pill bad">down</span>')+'</td><td>'+esc((p.models||[]).slice(0,8).join(", "))+'</td></tr>').join("")+'</table></section>';
},
Usage:async v=>{
  const u=await api("/api/usage");
  v.innerHTML='<section class="panel"><h3>Total</h3><div class="grid"><div class="card"><b>'+u.total.runs+'</b>runs</div><div class="card"><b>'+(u.total.t_in+u.total.t_out)+'</b>tokens</div><div class="card"><b>$'+Number(u.total.cost).toFixed(4)+'</b>cost</div></div></section>'
  +'<section class="panel"><h3>Per model</h3><table><tr><th>provider</th><th>model</th><th>runs</th><th>tokens</th><th>cost</th></tr>'
  +u.perModel.map(m=>'<tr><td>'+esc(m.provider)+'</td><td>'+esc(m.model)+'</td><td>'+m.runs+'</td><td>'+(m.t_in+m.t_out)+'</td><td>$'+Number(m.cost).toFixed(4)+'</td></tr>').join("")+'</table></section>';
},
Audit:async v=>{
  const d=await api("/api/audit?limit=100");
  v.innerHTML='<section class="panel"><h3>Audit (secrets redacted, latest 100)</h3><table><tr><th>time</th><th>tool</th><th>risk</th><th>approval</th><th>exit</th><th>ms</th></tr>'
  +d.logs.map(l=>'<tr><td>'+esc(l.created_at||"")+'</td><td>'+esc(l.tool||"")+'</td><td>'+esc(l.risk||"")+'</td><td>'+esc(l.approval||"")+'</td><td>'+(l.exit_code??"")+'</td><td>'+(l.duration_ms??"")+'</td></tr>').join("")+'</table></section>';
},
Settings:async v=>{
  const d=await api("/api/settings");
  v.innerHTML='<section class="panel"><h3>Settings</h3><table><tr><th>key</th><th>scope</th><th>value</th></tr>'
  +d.settings.map(s=>'<tr><td><code>'+esc(s.key)+'</code></td><td>'+esc(s.scope)+'/'+esc(s.scope_id.slice(0,8))+'</td><td>'+esc(String(s.value).slice(0,120))+'</td></tr>').join("")+'</table></section>'
  +'<section class="panel"><h3>Set value</h3><label>key</label><input id="s-key" placeholder="model"><label>value</label><input id="s-val" placeholder="auto"><label>scope</label><select id="s-scope"><option>global</option><option>session</option><option>workspace</option><option>user</option></select><label>scope id (optional)</label><input id="s-id" placeholder=""><div class="row"><button class="act" onclick="saveSetting()">save setting</button></div><p><label>Note: secrets (API keys, tokens) can only be set via environment / .env, never here.</label></p></section>';
},
Graphify:async v=>{
  const ws=(await api("/api/workspaces")).workspaces;
  const opts=ws.map(w=>'<option value="'+esc(w.name)+'">'+esc(w.name)+'</option>').join("");
  v.innerHTML='<section class="panel"><h3>Knowledge graph</h3><label>workspace</label><select id="g-ws">'+opts+'</select><div class="row"><button class="act" onclick="gStatus()">status</button><button class="act" onclick="gBuild(false)">build graph</button><button class="act" onclick="gBuild(true)">update graph</button></div><pre id="g-out">pick a workspace, then status.</pre></section>'
  +'<section class="panel"><h3>Query</h3><input id="g-q" placeholder="what connects auth to the database?"><div class="row"><button class="act" onclick="gQuery()">query</button><button class="act ghost" onclick="gExplain()">explain symbol</button></div><label>path from → to</label><div class="row"><input id="g-a" placeholder="UserService" style="flex:1"><input id="g-b" placeholder="DatabasePool" style="flex:1"><button class="act" onclick="gPath()">path</button></div><pre id="g-qout"></pre></section>';
}
};
async function stopRun(id){await api("/api/runs/"+id+"/stop",{method:"POST"});refresh()}
async function resolveAppr(id,st){await api("/api/approvals/"+id,{method:"POST",body:JSON.stringify({status:st})});refresh()}
async function saveSetting(){await api("/api/settings",{method:"POST",body:JSON.stringify({key:$("s-key").value,value:$("s-val").value,scope:$("s-scope").value,scopeId:$("s-id").value})});refresh()}
async function gStatus(){try{$("g-out").textContent=JSON.stringify(await api("/api/graphify/status?workspace="+encodeURIComponent($("g-ws").value)),null,2)}catch(e){$("g-out").textContent=e.message}}
async function gBuild(u){$("g-out").textContent="working… (graph build can take minutes)";try{$("g-out").textContent=JSON.stringify(await api("/api/graphify/build",{method:"POST",body:JSON.stringify({workspace:$("g-ws").value,updateOnly:u})}),null,2)}catch(e){$("g-out").textContent=e.message}}
async function gQuery(){$("g-qout").textContent="querying…";try{$("g-qout").textContent=(await api("/api/graphify/query",{method:"POST",body:JSON.stringify({workspace:$("g-ws").value,question:$("g-q").value})})).output||"(empty)"}catch(e){$("g-qout").textContent=e.message}}
async function gExplain(){$("g-qout").textContent="explaining…";try{$("g-qout").textContent=(await api("/api/graphify/explain",{method:"POST",body:JSON.stringify({workspace:$("g-ws").value,symbol:$("g-q").value})})).output||"(empty)"}catch(e){$("g-qout").textContent=e.message}}
async function gPath(){$("g-qout").textContent="tracing…";try{$("g-qout").textContent=(await api("/api/graphify/path",{method:"POST",body:JSON.stringify({workspace:$("g-ws").value,from:$("g-a").value,to:$("g-b").value})})).output||"(empty)"}catch(e){$("g-qout").textContent=e.message}}
refresh();setInterval(()=>{if(cur==="Approvals"||cur==="Runs"||cur==="Status")refresh()},15000);
</script>
</body>
</html>`;
}
