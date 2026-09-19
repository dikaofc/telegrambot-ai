/**
 * Graphify viewer — a first-party, dependency-free page for `graphify-out/graph.json`.
 *
 * Why this exists: the `graphify` CLI ships its own dark `graph.html` with a fixed
 * 280px sidebar and a CDN dependency. It cannot be read on a phone and it looks
 * nothing like the rest of TeleAgent. This page renders the same real data with
 * the shared design system (`BASE_CSS`), no external requests, and a layout that
 * collapses into a bottom sheet on narrow screens.
 *
 * Everything on screen comes from the API (`/api/graphify/view`): node degree is
 * computed from the real links, communities and insights come from graphify's own
 * analysis file. When the graph is truncated the page says so instead of hiding it.
 */

import { BASE_CSS } from "./page.js";

export const GRAPH_PAGE_TITLE = "TeleAgent — Graphify";

const GRAPH_CSS = `
/* ---------- shell: canvas + rail ---------- */
html,body{height:100%}
body{overflow:hidden}
.gwrap{display:flex;flex-direction:row;height:100dvh;overflow:hidden}
.gmain{flex:1 1 auto;min-width:0;position:relative;background:var(--surface-2)}
canvas#g-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}
canvas#g-canvas.dragging{cursor:grabbing}
canvas#g-canvas:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.gempty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;background:var(--surface-2)}
.gempty .box{max-width:420px;display:grid;gap:10px;justify-items:center}
.gempty h2{font-size:16px}
.gempty p{color:var(--muted);font-size:13.5px;margin:0}

/* toolbar floating over the canvas */
.gtools{position:absolute;left:10px;top:10px;right:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;pointer-events:none}
.gtools .btn{font-size:12.5px;padding:0 10px}
.gtools > *{pointer-events:auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-xs);box-shadow:var(--shadow-1)}
.gsearch{display:flex;align-items:center;gap:6px;padding:0 8px;height:34px;flex:1 1 220px;max-width:340px}
.gsearch input{height:30px;border:0;background:transparent;font-size:13px;padding:0}
.gsearch input:focus{box-shadow:none}
.gtools .btn{height:34px}
.gstat{position:absolute;left:10px;bottom:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;pointer-events:none}
.gstat .pill{pointer-events:auto;background:var(--surface);border-color:var(--line)}

/* ---------- rail ---------- */
.rail{flex:0 0 330px;width:330px;background:var(--surface);border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.railhead{display:flex;align-items:center;gap:6px;padding:8px 8px 8px 12px;border-bottom:1px solid var(--line);flex:0 0 auto}
.railhead .seg{display:flex;gap:4px;flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}
.railhead .seg::-webkit-scrollbar{display:none}
.segbtn{flex:0 0 auto;height:28px;padding:0 10px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--muted);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.segbtn:hover{background:var(--surface-3);color:var(--text)}
.segbtn[aria-selected="true"]{background:var(--accent-soft);color:var(--accent)}
.railbody{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;padding:12px;display:none;gap:12px;align-content:start}
.rail[data-tab="detail"] .railbody[data-pane="detail"],
.rail[data-tab="communities"] .railbody[data-pane="communities"],
.rail[data-tab="insights"] .railbody[data-pane="insights"]{display:grid}
[hidden]{display:none!important}
.rail h3{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);display:flex;align-items:center;justify-content:space-between;gap:8px}
.rail h3 .hint{font-weight:500;text-transform:none;letter-spacing:0;font-size:11.5px}
.nodehead{display:flex;align-items:flex-start;gap:8px;justify-content:space-between}
.nodehead .label{font-weight:650;font-size:14.5px;word-break:break-word}
.comm{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:var(--radius-xs)}
.comm:hover{background:var(--surface-2)}
.comm.dim{opacity:.45}
.comm label{display:flex;align-items:center;gap:7px;flex:1 1 auto;min-width:0;cursor:pointer;text-transform:none;letter-spacing:0;font-size:12.5px;font-weight:600;color:var(--text)}
.comm .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.comm .cnt{color:var(--muted);font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums}
.swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
.nblist{display:grid;gap:4px;max-height:280px;overflow:auto}
.nb{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 7px;border-radius:var(--radius-xs);border:1px solid transparent;background:var(--surface-2);cursor:pointer;text-align:left;font:inherit;color:inherit;width:100%}
.nb:hover{border-color:var(--line-strong)}
.nb .rel{color:var(--muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.insight{padding:9px 10px;border-radius:var(--radius-sm);background:var(--surface-2);border:1px solid var(--line);display:grid;gap:4px}
.insight .why{color:var(--muted);font-size:12px;margin:0}
.insight .q{font-size:13px;margin:0}
.rank{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:5px 7px;border-radius:var(--radius-xs);background:var(--surface-2);cursor:pointer;font:inherit;color:inherit;border:1px solid transparent;width:100%;text-align:left}
.rank:hover{border-color:var(--line-strong)}

/* ---------- embed mode (inside the dashboard Graphify tab) ---------- */
.embed .ghead{display:none}
.embed .gwrap{height:100dvh}
.embed .gtools{top:8px}

/* ---------- tablet ---------- */
@media (max-width:1000px){
  .rail{flex-basis:290px;width:290px}
}

/* ---------- phone: rail becomes a bottom sheet ---------- */
@media (max-width:760px){
  .gwrap{flex-direction:column}
  .gmain{flex:1 1 auto}
  .gtools{top:8px;left:8px;right:8px;gap:5px;flex-wrap:nowrap}
  .gsearch{flex:1 1 130px;min-width:110px;max-width:none}
  /* keep the readout clear of the collapsed bottom sheet */
  .gstat{bottom:56px;left:8px;right:8px}
  .rail{position:fixed;left:0;right:0;bottom:0;width:auto;flex:0 0 auto;height:58dvh;max-height:58dvh;border-left:0;border-top:1px solid var(--line);border-radius:16px 16px 0 0;box-shadow:var(--shadow-2);transform:translateY(calc(100% - 48px));transition:transform .22s cubic-bezier(.22,.61,.36,1);z-index:30}
  .rail.open{transform:none}
  .railhead{cursor:pointer;padding-top:6px;padding-bottom:6px}
  .railhead::before{content:"";position:absolute;left:50%;top:6px;width:34px;height:4px;margin-left:-17px;border-radius:99px;background:var(--line-strong)}
  .railhead{padding-top:14px;position:relative}
  .railbody{padding:10px 12px calc(14px + env(safe-area-inset-bottom))}
}
@media (prefers-reduced-motion: reduce){
  .rail{transition:none}
}
`.trim();

const GRAPH_SCRIPT = `
'use strict';
var QS=new URLSearchParams(typeof location!=='undefined'?location.search:'');
var WS=QS.get('workspace')||'default';
var EMBED=QS.get('embed')==='1';
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]})};
var key=function(){try{return localStorage.getItem('teleagent_key')||''}catch(e){return ''}};

if(EMBED)document.documentElement.className='embed';

/* ---------- state ---------- */
var PAY=null;               // payload from /api/graphify/view
var X=null,Y=null,VX=null,VY=null,DRAG=null;  // typed arrays, index-aligned with nodes
var LK=null;                // Int32Array [from,to,from,to,…] index pairs
var NB=[];                  // adjacency: index -> array of {to,rel}
var ADJ=null;               // Uint8Array visibility per node
var selected=-1,hovering=-1;
var cam={x:0,y:0,k:1};
var alpha=0,running=false,frame=0;
var hidden=new Set();       // hidden community ids
var focusComm=null;         // community id being focused
var focusNodes=null;        // Set of indices when a node/community focus is active
var palette=[],dark=false;
var REDUCED=false;
try{REDUCED=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)}catch(e){REDUCED=false}

/* ---------- deterministic start (same layout every reload) ---------- */
function rng(seed){var s=seed>>>0;return function(){s=(s+0x6D2B79F5)>>>0;var t=s;t=Math.imul(t^(t>>>15),1|t);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296}}
function hash(str){var h=2166136261;for(var i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}

/* ---------- colours: muted, derived from the community id ---------- */
function buildPalette(){
  var n=PAY.communities.length||1;
  palette=PAY.communities.map(function(c,i){
    var hue=Math.round((i*360/Math.max(n,1)+18)%360);
    var sat=dark?46:58, light=dark?62:38;
    return {hue:hue,fill:'hsl('+hue+' '+sat+'% '+light+'%)',soft:'hsla('+hue+' '+sat+'% '+light+'% / .18)'};
  });
}
function commIndex(id){for(var i=0;i<PAY.communities.length;i++)if(PAY.communities[i].id===id)return i;return -1}
function colorOf(node){var i=commIndex(node.community);return i<0?(dark?'#7b8496':'#8a90a4'):palette[i].fill}

/* ---------- layout ---------- */
function seedLayout(){
  var n=PAY.nodes.length;
  X=new Float32Array(n);Y=new Float32Array(n);VX=new Float32Array(n);VY=new Float32Array(n);DRAG=new Uint8Array(n);
  var rnd=rng(hash(WS)||1);
  // communities on a ring, their members clustered around the ring position:
  // readable from the first frame instead of a hairball that never settles.
  var groups={};
  for(var i=0;i<n;i++){var c=PAY.nodes[i].community;(groups[c]=groups[c]||[]).push(i)}
  var keys=Object.keys(groups),R=Math.max(220,Math.sqrt(n)*34);
  keys.forEach(function(c,gi){
    var ang=(gi/Math.max(keys.length,1))*Math.PI*2;
    var cx=Math.cos(ang)*R+(rnd()-0.5)*40, cy=Math.sin(ang)*R+(rnd()-0.5)*40;
    groups[c].forEach(function(i){
      var a=rnd()*Math.PI*2,d=Math.sqrt(rnd())*Math.min(150,26+groups[c].length*7);
      X[i]=cx+Math.cos(a)*d;Y[i]=cy+Math.sin(a)*d;VX[i]=0;VY[i]=0;
    });
  });
  // links arrive as [fromIndex, toIndex, relation] over PAY.nodes
  var pairs=[];
  NB=PAY.nodes.map(function(){return []});
  (PAY.links||[]).forEach(function(l){
    var a=l[0],b=l[1];
    if(a===b||a<0||b<0||a>=PAY.nodes.length||b>=PAY.nodes.length)return;
    pairs.push(a,b);
    NB[a].push({to:b,rel:l[2]});NB[b].push({to:a,rel:l[2]});
  });
  LK=Int32Array.from(pairs);
  ADJ=new Uint8Array(n).fill(1);
  applyVisibility();
}

function visible(i){
  if(ADJ&&!ADJ[i])return false;
  if(focusNodes&&!focusNodes.has(i))return false;
  return true;
}

function applyVisibility(){
  PAY.nodes.forEach(function(nd,i){ADJ[i]=hidden.has(nd.community)?0:1});
}

function bounds(){
  var x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(var i=0;i<PAY.nodes.length;i++){if(!visible(i))continue;
    x0=Math.min(x0,X[i]);x1=Math.max(x1,X[i]);y0=Math.min(y0,Y[i]);y1=Math.max(y1,Y[i])}
  if(x0===Infinity)return {x0:-100,y0:-100,x1:100,y1:100};
  return {x0:x0,y0:y0,x1:x1,y1:y1};
}

function fit(){
  var b=bounds(),cv=$('g-canvas');
  if(!cv)return;
  var w=cv.clientWidth||900,h=cv.clientHeight||600;
  var gx=Math.max(b.x1-b.x0,40),gy=Math.max(b.y1-b.y0,40);
  var k=Math.min((w-70)/gx,(h-90)/gy);
  cam.k=Math.max(0.08,Math.min(k,2.4));
  cam.x=-(b.x0+b.x1)/2;cam.y=-(b.y0+b.y1)/2;
  draw();
}

function step(){
  var n=PAY.nodes.length,rep=2600,linkDist=58;
  // repulsion (n is capped, so pairwise is cheap) + community cohesion
  for(var i=0;i<n;i++){
    if(!visible(i))continue;
    for(var j=i+1;j<n;j++){
      if(!visible(j))continue;
      var dx=X[j]-X[i],dy=Y[j]-Y[i],d2=dx*dx+dy*dy;
      if(d2>90000||d2===0){if(d2===0){X[j]+=0.6;Y[j]+=0.6}continue}
      var f=rep/d2, d=Math.sqrt(d2)+0.01, fx=dx/d*f, fy=dy/d*f;
      var same=PAY.nodes[i].community===PAY.nodes[j].community;
      if(same){fx*=0.35;fy*=0.35}
      VX[i]-=fx;VY[i]-=fy;VX[j]+=fx;VY[j]+=fy;
    }
  }
  // springs + gravity toward the graph centre
  for(var p=0;p<LK.length;p+=2){
    var a=LK[p],b=LK[p+1];
    if(!visible(a)||!visible(b))continue;
    var dx=X[b]-X[a],dy=Y[b]-Y[a],d=Math.sqrt(dx*dx+dy*dy)+0.01;
    var f=(d-linkDist)*0.012, fx=dx/d*f, fy=dy/d*f;
    VX[a]+=fx;VY[a]+=fy;VX[b]-=fx;VY[b]-=fy;
  }
  var damp=0.82;
  for(var q=0;q<n;q++){
    if(!visible(q)||DRAG[q])continue;
    VX[q]*=damp;VY[q]*=damp;
    X[q]+=VX[q]*alpha;Y[q]+=VY[q]*alpha;
    VX[q]*=0.9;VY[q]*=0.9;
    X[q]*=0.999;Y[q]*=0.999;
  }
  alpha*=0.975;
}

function tick(){
  if(!PAY)return;
  if(alpha<0.012){running=false;return}
  var steps=10;
  for(var i=0;i<steps&&alpha>=0.012;i++)step();
  draw();
  frame=requestAnimationFrame(tick);
}
function reheat(a){
  alpha=a==null?1:a;
  if(REDUCED){for(var i=0;i<140;i++)step();alpha=0;draw();return}
  if(running)return;
  running=true;frame=requestAnimationFrame(tick);
}

/* ---------- drawing ---------- */
function css(name,fallback){
  try{var v=getComputedStyle(document.documentElement).getPropertyValue(name).trim();return v||fallback}catch(e){return fallback}
}
function draw(){
  var cv=$('g-canvas');if(!cv||!PAY)return;
  var ctx=cv.getContext('2d');if(!ctx)return;
  var w=cv.clientWidth,h=cv.clientHeight,dpr=Math.min(window.devicePixelRatio||1,2);
  if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr)}
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  var line=css('--line','#e4e7f0'),text=css('--text','#12162a'),muted=css('--muted','#5d6480');
  var s=cam.k, ox=w/2+cam.x*s, oy=h/2+cam.y*s;
  var px=function(i){return ox+X[i]*s}, py=function(i){return oy+Y[i]*s};
  var focusSet=null;
  if(selected>=0||hovering>=0){
    var c=hovering>=0?hovering:selected;
    focusSet=new Set([c]);
    NB[c].forEach(function(nb){focusSet.add(nb.to)});
  }
  // edges first
  ctx.lineWidth=1;
  for(var p=0;p<LK.length;p+=2){
    var a=LK[p],b=LK[p+1];
    if(!visible(a)||!visible(b))continue;
    var hot=focusSet&&(focusSet.has(a)&&focusSet.has(b));
    if(focusSet&&!hot){ctx.strokeStyle=muted;ctx.globalAlpha=0.12}else{ctx.strokeStyle=line;ctx.globalAlpha=0.5}
    ctx.beginPath();ctx.moveTo(px(a),py(a));ctx.lineTo(px(b),py(b));ctx.stroke();
  }
  ctx.globalAlpha=1;
  // nodes + labels (labels only when zoomed in or relevant: no label soup)
  for(var i=0;i<PAY.nodes.length;i++){
    if(!visible(i))continue;
    var nd=PAY.nodes[i],r=nodeRadius(nd),x=px(i),y=py(i);
    if(x<-30||y<-30||x>w+30||y>h+30)continue;
    var dim=focusSet&&!focusSet.has(i);
    ctx.globalAlpha=dim?0.22:1;
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);
    ctx.fillStyle=colorOf(nd);ctx.fill();
    if(i===selected){ctx.lineWidth=2;ctx.strokeStyle=text;ctx.stroke()}
    else if(nd.degree>=12){ctx.lineWidth=1.4;ctx.strokeStyle=dark?css('--surface','#12161f'):'#fff';ctx.stroke()}
    var showLabel=(s>1.5&&r>=4)||i===selected||i===hovering||(focusSet&&focusSet.has(i)&&s>0.9);
    if(showLabel){
      ctx.globalAlpha=dim?0.3:1;
      ctx.font=(i===selected?'600 ':'') + Math.max(10,Math.min(13,11/s*Math.max(1,s*0.8))).toFixed(1)+'px '+css('--sans','system-ui');
      ctx.fillStyle=text;ctx.textAlign='center';
      ctx.fillText(nd.label.length>26?nd.label.slice(0,25)+'…':nd.label,x,y-r-4);
    }
  }
  ctx.globalAlpha=1;
  var shownNodes=0,shownEdges=0;
  for(var v=0;v<PAY.nodes.length;v++)if(visible(v))shownNodes++;
  for(var e=0;e<LK.length;e+=2)if(visible(LK[e])&&visible(LK[e+1]))shownEdges++;
  var st=$('g-shown');
  if(st)st.textContent=shownNodes+' / '+PAY.totals.nodes+' node · '+shownEdges+' / '+PAY.totals.links+' edge';
}
function nodeRadius(nd){return Math.max(3.1,Math.min(15,3+Math.sqrt(nd.degree+1)*1.15))}

/* ---------- hit testing ---------- */
function at(mx,my){
  var cv=$('g-canvas'),w=cv.clientWidth,h=cv.clientHeight,s=cam.k;
  var ox=w/2+cam.x*s, oy=h/2+cam.y*s, best=-1,bd=1e9;
  for(var i=0;i<PAY.nodes.length;i++){
    if(!visible(i))continue;
    var dx=mx-(ox+X[i]*s),dy=my-(oy+Y[i]*s),d=dx*dx+dy*dy;
    var r=Math.max(nodeRadius(PAY.nodes[i]),9)+3;
    if(d<r*r&&d<bd){bd=d;best=i}
  }
  return best;
}
function toWorld(mx,my){
  var cv=$('g-canvas');
  return {x:(mx-cv.clientWidth/2-cam.x*cam.k)/cam.k,y:(my-cv.clientHeight/2-cam.y*cam.k)/cam.k};
}

/* ---------- panel rendering ---------- */
function fmtInt(n){return String(n).replace(/(.)(?=(.{3})+$)/g,'$1.')}
function renderDetail(){
  var box=$('g-detail');if(!box)return;
  if(selected<0){
    box.innerHTML='<div class="empty">Pilih node di canvas untuk melihat detailnya. Gulir untuk zoom, tarik latar untuk menggeser.</div>';
    return;
  }
  var nd=PAY.nodes[selected],ci=commIndex(nd.community),comm=ci>=0?PAY.communities[ci]:null;
  var commColor=ci>=0&&palette[ci]?palette[ci].fill:'#8a90a4';
  var nbs=NB[selected].filter(function(nb){return visible(nb.to)})
    .sort(function(a,b){return PAY.nodes[b.to].degree-PAY.nodes[a.to].degree}).slice(0,24);
  box.innerHTML='<div class="nodehead"><span class="label">'+esc(nd.label)+'</span>'+'<span class="bdg acc">'+esc(nd.fileType)+'</span></div>'
    +'<div class="kv" style="margin-top:8px">'
    +'<div><div class="k">komunitas</div><div class="v">'+(comm?'<span class="swatch" style="display:inline-block;vertical-align:middle;margin-right:6px;background:'+commColor+'"></span>'+esc(comm.name):'—')+'</div></div>'
    +'<div><div class="k">degree</div><div class="v">'+nd.degree+' link</div></div>'
    +(nd.sourceFile?'<div><div class="k">sumber</div><div class="v"><code>'+esc(nd.sourceFile)+(nd.sourceLocation?':'+esc(nd.sourceLocation):'')+'</code></div></div>':'')
    +'</div>'
    +(nbs.length?'<h3 style="margin-top:14px">Tetangga <span class="hint">'+NB[selected].length+' total</span></h3><div class="nblist">'
      +nbs.map(function(nb){return '<button class="nb" data-node="'+nb.to+'" type="button"><span>'+esc(PAY.nodes[nb.to].label)+'</span><span class="rel">'+esc(nb.rel||'')+'</span></button>'}).join('')
      +'</div>':'<div class="empty" style="margin-top:12px">Node tanpa link</div>');
}
function renderCommunities(){
  var box=$('g-communities');if(!box)return;
  box.innerHTML=PAY.communities.map(function(c){
    var idx=commIndex(c.id);
    var sw=idx>=0?palette[idx].fill:'#8a90a4';
    return '<div class="comm'+(hidden.has(c.id)?' dim':'')+'" data-comm="'+c.id+'">'
      +'<label><input type="checkbox" data-comm-toggle="'+c.id+'"'+(hidden.has(c.id)?'':' checked')+'>'
      +'<span class="swatch" style="background:'+sw+'"></span><span class="nm">'+esc(c.name)+'</span></label>'
      +'<span class="cnt">'+c.count+(c.cohesion!=null?' · '+c.cohesion.toFixed(3):'')+'</span></div>';
  }).join('');
}
function renderInsights(){
  var box=$('g-insights');if(!box)return;
  var ins=PAY.insights;
  var h='';
  if(ins.gods.length){
    h+='<h3>Node paling terhubung</h3><div class="stack" style="gap:4px">'+ins.gods.map(function(g){
      return '<button class="rank" data-find="'+esc(g.label)+'" type="button"><span>'+esc(g.label)+'</span><span class="cnt">'+g.degree+' link</span></button>';
    }).join('')+'</div>';
  }
  if(ins.surprises.length){
    h+='<h3 style="margin-top:14px">Koneksi lintas komunitas</h3><div class="stack">'+ins.surprises.map(function(s){
      return '<div class="insight"><b>'+esc(s.source)+' → '+esc(s.target)+'</b>'+(s.why?'<p class="why">'+esc(s.why)+'</p>':'')+'</div>';
    }).join('')+'</div>';
  }
  if(ins.questions.length){
    h+='<h3 style="margin-top:14px">Pertanyaan arsitektur</h3><div class="stack">'+ins.questions.map(function(q){
      return '<div class="insight"><p class="q">'+esc(q.question)+'</p>'+(q.why?'<p class="why">'+esc(q.why)+'</p>':'')+'</div>';
    }).join('')+'</div>';
  }
  box.innerHTML=h||'<div class="empty">Belum ada analisis. graphify menulis file ini saat extract berjalan.</div>';
}

/* ---------- focus helpers ---------- */
function focusNodeAt(i,open){
  selected=i;focusNodes=new Set([i]);NB[i].forEach(function(nb){focusNodes.add(nb.to)});
  var cv=$('g-canvas');
  cam.x=-X[i];cam.y=-Y[i];
  if(cv)cam.k=Math.max(cam.k,1.3);
  setTab('detail');
  if(open)openRail();
  renderDetail();reheat(0.35);draw();
}
function clearFocus(){
  selected=-1;focusNodes=null;setTab('detail');renderDetail();draw();
}
function findNode(label){
  var low=String(label).toLowerCase();
  for(var i=0;i<PAY.nodes.length;i++)if(PAY.nodes[i].label.toLowerCase()===low)return i;
  for(var j=0;j<PAY.nodes.length;j++)if(PAY.nodes[j].label.toLowerCase().indexOf(low)>=0)return j;
  return -1;
}
function focusCommunity(id){
  focusComm=id;
  var sel=new Set();
  PAY.nodes.forEach(function(nd,i){if(nd.community===id)sel.add(i)});
  NB.forEach(function(list,i){if(sel.has(i))return;list.forEach(function(nb){if(sel.has(nb.to))sel.add(i)})});
  focusNodes=sel;
  var b=bounds();cam.x=-(b.x0+b.x1)/2;cam.y=-(b.y0+b.y1)/2;
  draw();
}
function clearCommunityFocus(){focusComm=null;focusNodes=null;draw()}

/* ---------- rail ---------- */
function setTab(name){
  var rail=$('rail');if(!rail)return;
  rail.setAttribute('data-tab',name);
  rail.setAttribute('data-open','1');
  ['detail','communities','insights'].forEach(function(t){
    var b=$('seg-'+t);if(b)b.setAttribute('aria-selected',String(t===name));
  });
}
function openRail(){var r=$('rail');if(r&&window.innerWidth<=760)r.classList.add('open')}
function toggleRail(){var r=$('rail');if(r)r.classList.toggle('open')}

/* ---------- data ---------- */
function api(path){
  return fetch(path,{headers:{'x-api-key':key()}}).then(function(r){
    if(!r.ok)return r.text().then(function(t){throw new Error('HTTP '+r.status+': '+String(t).slice(0,200))});
    return r.json();
  });
}
function skeleton(){
  var cv=$('g-canvas');
  var empty=$('g-empty');
  if(empty){empty.hidden=false;empty.innerHTML='<div class="box"><h2>Memuat graph…</h2><p>Membaca graph.json dan menghitung degree.</p></div>'}
  if(cv)cv.hidden=true;
}
function fail(msg){
  var empty=$('g-empty'),cv=$('g-canvas');
  if(cv)cv.hidden=true;
  if(empty){
    empty.hidden=false;
    empty.innerHTML='<div class="box"><h2>Graph belum bisa ditampilkan</h2><p>'+esc(msg)+'</p>'
      +'<p class="sub" style="margin:0">Jalankan <code>graphify_build</code> (agent tool) atau tab Graphify → Build, lalu muat ulang halaman ini.</p></div>';
  }
}
function load(){
  skeleton();
  return api('/api/graphify/view?workspace='+encodeURIComponent(WS)+'&limit=400').then(function(payload){
    PAY=payload;
    dark=isDark();
    buildPalette();
    hidden=new Set();focusComm=null;focusNodes=null;selected=-1;hovering=-1;
    seedLayout();
    var cv=$('g-canvas'),empty=$('g-empty');
    if(empty)empty.hidden=true;
    if(cv)cv.hidden=false;
    renderCommunities();renderInsights();renderDetail();renderMeta();
    fit();
    reheat(1);
  }).catch(function(e){fail(e&&e.message?e.message:String(e))});
}
function isDark(){
  try{
    var attr=document.documentElement.getAttribute('data-theme');
    if(attr==='dark')return true;
    if(attr==='light')return false;
    return !!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
  }catch(e){return false}
}
function renderMeta(){
  var t=$('g-title');if(t)t.textContent='Graphify · '+WS;
  var m=$('g-meta');
  if(m)m.innerHTML='<span class="pill">'+fmtInt(PAY.totals.nodes)+' node</span>'
    +'<span class="pill">'+fmtInt(PAY.totals.links)+' edge</span>'
    +'<span class="pill">'+PAY.totals.communities+' komunitas</span>'
    +(PAY.builtAtCommit?'<span class="pill">commit '+esc(PAY.builtAtCommit)+'</span>':'');
  var n=$('g-note');
  if(n)n.textContent=PAY.truncated?('Menampilkan '+PAY.shown.nodes+' node dengan degree tertinggi dari '+PAY.totals.nodes+' — edge hanya yang kedua ujungnya tampil.'):'Seluruh graph tampil.';
  // the backend's honest diagnosis of an empty/stale graph, shown not buried
  var nb=$('g-note-box');
  if(nb)nb.innerHTML=PAY.note?alertBox('warn','Graph perlu diperhatikan',PAY.note):'';
  var pill=$('g-note-pill');
  if(pill)pill.hidden=!PAY.note;
  var s=$('g-shown');
  if(s)s.textContent=PAY.shown.nodes+' / '+PAY.totals.nodes+' node · '+PAY.shown.links+' / '+PAY.totals.links+' edge';
}

/* ---------- input ---------- */
function bindAll(){
  var cv=$('g-canvas');
  if(cv){
    var dragMode=0,lastX=0,lastY=0,dragNode=-1;
    cv.addEventListener('pointerdown',function(ev){
      cv.setPointerCapture&&cv.setPointerCapture(ev.pointerId);
      var hit=at(ev.offsetX,ev.offsetY);
      lastX=ev.offsetX;lastY=ev.offsetY;
      if(hit>=0){dragMode=1;dragNode=hit;DRAG[hit]=1;var w=toWorld(ev.offsetX,ev.offsetY);X[hit]=w.x;Y[hit]=w.y}
      else{dragMode=2;cv.classList.add('dragging')}
    });
    cv.addEventListener('pointermove',function(ev){
      if(dragMode===1&&dragNode>=0){
        var w=toWorld(ev.offsetX,ev.offsetY);
        X[dragNode]=w.x;Y[dragNode]=w.y;VX[dragNode]=0;VY[dragNode]=0;
        draw();return;
      }
      if(dragMode===2){
        cam.x+=(ev.offsetX-lastX)/cam.k;cam.y+=(ev.offsetY-lastY)/cam.k;
        lastX=ev.offsetX;lastY=ev.offsetY;draw();return;
      }
      var h=at(ev.offsetX,ev.offsetY);
      if(h!==hovering){hovering=h;cv.style.cursor=h>=0?'pointer':'grab';draw()}
    });
    var endDrag=function(){
      if(dragNode>=0)DRAG[dragNode]=0;
      dragMode=0;dragNode=-1;cv.classList.remove('dragging');
      if(alpha>0)reheat(0.4);
    };
    cv.addEventListener('pointerup',function(ev){
      var wasDrag=dragMode;
      endDrag();
      if(wasDrag===2&&Math.abs(ev.offsetX-lastX)<3&&Math.abs(ev.offsetY-lastY)<3){
        var hit=at(ev.offsetX,ev.offsetY);
        if(hit<0){clearFocus();return}
      }
      var hit2=at(ev.offsetX,ev.offsetY);
      if(hit2>=0)focusNodeAt(hit2,true);
    });
    cv.addEventListener('pointercancel',endDrag);
    cv.addEventListener('wheel',function(ev){
      ev.preventDefault();
      var before=toWorld(ev.offsetX,ev.offsetY);
      var factor=ev.deltaY<0?1.12:1/1.12;
      cam.k=Math.max(0.08,Math.min(cam.k*factor,4));
      var after=toWorld(ev.offsetX,ev.offsetY);
      cam.x+=after.x-before.x;cam.y+=after.y-before.y;
      draw();
    },{passive:false});
    cv.addEventListener('keydown',function(ev){
      var st=40/cam.k;
      if(ev.key==='ArrowLeft')cam.x+=st;
      else if(ev.key==='ArrowRight')cam.x-=st;
      else if(ev.key==='ArrowUp')cam.y+=st;
      else if(ev.key==='ArrowDown')cam.y-=st;
      else if(ev.key==='+'||ev.key==='=')cam.k=Math.min(cam.k*1.15,4);
      else if(ev.key==='-')cam.k=Math.max(cam.k/1.15,0.08);
      else if(ev.key==='0'||ev.key==='f')fit();
      else if(ev.key==='Escape')clearFocus();
      else return;
      ev.preventDefault();draw();
    });
  }
  var rail=$('rail');
  if(rail){
    var head=rail.querySelector('.railhead');
    if(head)head.addEventListener('click',function(ev){
      var seg=ev.target&&ev.target.closest?ev.target.closest('.segbtn'):null;
      if(seg){setTab(seg.getAttribute('data-tab'));openRail();return}
      if(window.innerWidth<=760)toggleRail();
    });
    rail.addEventListener('click',function(ev){
      var t=ev.target;
      var nb=t&&t.closest?t.closest('[data-node]'):null;
      if(nb){focusNodeAt(Number(nb.getAttribute('data-node')),true);return}
      var fin=t&&t.closest?t.closest('[data-find]'):null;
      if(fin){
        var i=findNode(fin.getAttribute('data-find'));
        if(i>=0)focusNodeAt(i,true);
        return;
      }
      var comm=t&&t.closest?t.closest('.comm'):null;
      if(comm&&!(t.closest&&t.closest('label'))){
        var id=Number(comm.getAttribute('data-comm'));
        if(focusComm===id)clearCommunityFocus();else focusCommunity(id);
        return;
      }
    });
    rail.addEventListener('change',function(ev){
      var cb=ev.target;
      if(!cb||!cb.hasAttribute||!cb.hasAttribute('data-comm-toggle'))return;
      var id=Number(cb.getAttribute('data-comm-toggle'));
      if(cb.checked)hidden.delete(id);else hidden.add(id);
      if(focusComm===id&&!cb.checked)clearCommunityFocus();
      applyVisibility();renderCommunities();draw();
    });
  }
  var search=$('g-search');
  if(search){
    var results=$('g-results');
    var run=function(){
      var q=search.value.trim().toLowerCase();
      if(!q||!PAY){if(results){results.hidden=true;results.innerHTML=''}return}
      var hits=[];
      for(var i=0;i<PAY.nodes.length&&hits.length<12;i++){
        if(PAY.nodes[i].label.toLowerCase().indexOf(q)>=0)hits.push(i);
      }
      if(!results)return;
      results.hidden=false;
      results.innerHTML=hits.length?hits.map(function(i){
        return '<button class="nb" data-node="'+i+'" type="button"><span>'+esc(PAY.nodes[i].label)+'</span><span class="rel">'+esc(PAY.nodes[i].fileType)+'</span></button>';
      }).join(''):'<div class="sub" style="padding:4px 6px;margin:0">Tidak ada node yang cocok</div>';
    };
    search.addEventListener('input',run);
    search.addEventListener('keydown',function(ev){
      if(ev.key==='Escape'){search.value='';run();search.blur()}
      if(ev.key==='Enter'){
        var first=$('g-results')&&$('g-results').querySelector('[data-node]');
        if(first)focusNodeAt(Number(first.getAttribute('data-node')),true);
      }
    });
    if(results)results.addEventListener('click',function(ev){
      var btn=ev.target&&ev.target.closest?ev.target.closest('[data-node]'):null;
      if(btn)focusNodeAt(Number(btn.getAttribute('data-node')),true);
    });
  }
  ['fit','reload','relayout','close'].forEach(function(act){
    var b=$('g-'+act);
    if(!b)return;
    b.addEventListener('click',function(){
      if(act==='fit')fit();
      else if(act==='reload')load();
      else if(act==='relayout'){seedLayout();fit();reheat(1)}
      else toggleRail();
    });
  });
  if(window.matchMedia){
    try{
      var mq=window.matchMedia('(prefers-color-scheme: dark)');
      var onChange=function(){dark=isDark();buildPalette();draw()};
      mq.addEventListener?mq.addEventListener('change',onChange):mq.addListener(onChange);
    }catch(e){}
  }
  window.addEventListener('resize',function(){draw()});
  document.addEventListener('keydown',function(ev){
    if(ev.key==='/'&&document.activeElement!==search){ev.preventDefault();if(search)search.focus()}
  });
}

bindAll();
load();
`;

export function graphifyPage(): string {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="TeleAgent graph viewer — node, relasi, komunitas, dan insight dari graphify-out/graph.json.">
<meta name="robots" content="noindex">
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<meta name="theme-color" content="#f4f5f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0e14" media="(prefers-color-scheme: dark)">
<title>${GRAPH_PAGE_TITLE}</title>
<style>
${BASE_CSS}
${GRAPH_CSS}
</style>
</head>
<body>
<div class="ghead top">
  <header class="topbar">
    <div class="brand"><img src="/logo.svg" alt="" width="26" height="26" style="width:26px;height:26px;vertical-align:-6px;border-radius:8px"><span id="g-title">Graphify</span><span class="tag">knowledge graph</span></div>
    <div class="statusline" id="g-meta"></div>
    <div class="actions">
      <a class="btn" href="/diagram">Kembali ke dashboard</a>
      <a class="btn" href="/api/graphify/raw" target="_blank" rel="noopener">Output asli graphify</a>
    </div>
  </header>
</div>
<div class="gwrap">
  <div class="gmain">
    <canvas id="g-canvas" tabindex="0" role="img" aria-label="Graf pengetahuan workspace: node dan relasi"></canvas>
    <div class="gtools">
      <div class="gsearch"><label class="sr" for="g-search">Cari node</label><input id="g-search" type="search" placeholder="Cari node…  /" autocomplete="off"></div>
      <button class="btn" id="g-fit" type="button" title="Sesuaikan tampilan ke seluruh graph">Fit</button>
      <button class="btn" id="g-relayout" type="button" title="Hitung ulang posisi node">Layout</button>
      <button class="btn" id="g-reload" type="button" title="Ambil ulang data graph.json">Data</button>
      <button class="btn icon" id="g-close" type="button" title="Buka panel detail" aria-label="Buka panel detail">
        <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true" focusable="false"><path d="M1 3h13M1 7.5h13M1 12h13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>
      </button>
    </div>
    <div class="gstat">
      <span class="pill" id="g-shown">—</span>
      <span class="pill warn" id="g-note-pill" hidden>graph perlu diperhatikan</span>
    </div>
    <div class="gempty" id="g-empty"><div class="box"><h2>Memuat graph…</h2></div></div>
  </div>
  <aside class="rail" id="rail" data-tab="detail" aria-label="Panel graph">
    <div class="railhead">
      <div class="seg" role="tablist">
        <button class="segbtn" id="seg-detail" data-tab="detail" role="tab" aria-selected="true" type="button">Detail</button>
        <button class="segbtn" id="seg-communities" data-tab="communities" role="tab" aria-selected="false" type="button">Komunitas</button>
        <button class="segbtn" id="seg-insights" data-tab="insights" role="tab" aria-selected="false" type="button">Insight</button>
      </div>
    </div>
    <div class="railbody" data-pane="detail">
      <div id="g-note-box"></div>
      <div id="g-detail"></div>
      <h3>Catatan <span class="hint">data apa adanya</span></h3>
      <p class="sub" id="g-note" style="margin:0"></p>
      <div id="g-results" hidden></div>
    </div>
    <div class="railbody" data-pane="communities">
      <h3>Komunitas <span class="hint">klik untuk fokus</span></h3>
      <div id="g-communities"></div>
    </div>
    <div class="railbody" data-pane="insights">
      <div id="g-insights"></div>
    </div>
  </aside>
</div>
<script>
${GRAPH_SCRIPT}</script>
</body>
</html>`;
}
