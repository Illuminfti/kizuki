/* Kizuki Box AI Neural Observatory (Alt+I) & Live AI Pill */
(f=>{'use strict';const a=f();if(typeof module==='object')module.exports=a;if(typeof window!=='undefined')window.KizukiBoxAi=a;})(()=>{'use strict';
const M=Math,C=['building|01|BLD|#f59e0b|#fcd34d|#b45309|#d97706','designing|02|DSN|#a78bfa|#d8b4fe|#6d28d9|#7c3aed','predicting|03|PRD|#22d3ee|#67e8f9|#0e7490|#0891b2','orchestrating|04|ORC|#34d399|#6ee7b7|#15803d|#16a34a'].map(s=>s.split('|'));
const CM=Object.fromEntries(C.map(c=>[c[0],c])),MF=' "Geist Mono",monospace',SF=' "Geist",sans-serif';
const D=typeof document!=='undefined'?document:null,W=typeof window!=='undefined'?window:null;
const S={open:false,f:'all',sel:null,hov:null,d:{ts:'',summary:{total_live:0,building:0,designing:0,predicting:0,orchestrating:0,total_cpu_pct:0,total_ram_mb:0,host_load:0},agents:[],resources:[],edges:[]},tm:0,es:null,raf:0,t0:0,L:{n:[],e:[],c:[],w:0,h:0},el:{},bt:0};
const on=(e,v,fn)=>e?.addEventListener?.(v,fn),cl=s=>`${s??''}`.replace(/\s*\u2014\s*/g,' - ').replace(/\u2014/g,'-'),es=s=>cl(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const lt=()=>D?.documentElement?.getAttribute('data-theme')==='light',rm=()=>{const o=D?.documentElement?.getAttribute('data-detail')==='off';try{return o||!!W?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;}catch{return o;}};
const cc=(id,hi)=>{const c=CM[id]||CM.orchestrating;return lt()?(hi?c[6]:c[5]):(hi?c[4]:c[3]);},rc=hi=>lt()?(hi?'#2563eb':'#1d4ed8'):(hi?'#93c5fd':'#60a5fa');
const p0=v=>M.max(0,+v||0),nm=(v,b)=>v!=null&&v!==''&&Number.isFinite(+v)?+v:b,cat=v=>CM[`${v||''}`.toLowerCase()]?`${v}`.toLowerCase():'orchestrating';
const fR=m=>m>=1024?`${(m/1024).toFixed(1)} GB`:`${M.round(m||0)} MB`,fU=s=>{const n=p0(s)|0;return n>=3600?`${n/3600|0}h ${(n%3600)/60|0}m`:n>=60?`${n/60|0}m`:`${n}s`;},A=x=>Array.isArray(x)?x:[];
const dv=(c,b)=>`<div class=${c}>${b}</div>`,sp=(c,b)=>`<span class=${c}>${b}</span>`;

function norm(r){
  if(!r||typeof r!=='object')return S.d;
  const s=r.summary||{},ag=A(r.agents).map((a,i)=>{a=a||{};return{id:`${a.id||i}`,kind:'agent',name:cl(a.name||a.runtime||'ai'),runtime:cl(a.runtime||'proc'),category:cat(a.category),state:cl(a.state||'live'),pid:+a.pid||0,cpu_pct:p0(a.cpu_pct),ram_mb:p0(a.ram_mb),uptime_s:p0(a.uptime_s),repo:cl(a.repo),current_action:cl(a.current_action),active_tool:cl(a.active_tool),recent_actions:A(a.recent_actions).slice(0,6).map(x=>cl(x?.action||x?.text||x?.tool||x))};});
  const rs=A(r.resources).map((x,i)=>{x=x||{};return{id:`${x.id||i}`,kind:'resource',name:cl(x.label||x.name||'Hub'),rk:cl(x.kind||'hub').toUpperCase(),metric:cl(x.metric),active_count:p0(x.active_count)};});
  const ed=A(r.edges).map((e,i)=>{e=e||{};return{id:`${e.id||i}`,from:`${e.from||''}`,to:`${e.to||''}`,category:cat(e.category),label:cl(e.label),weight:M.max(.2,M.min(2,+e.weight||1)),cpu_pct:p0(e.cpu_pct),active:e.active!==false};});
  const sm={total_live:nm(s.total_live,ag.length),total_cpu_pct:nm(s.total_cpu_pct,ag.reduce((t,a)=>t+a.cpu_pct,0)),total_ram_mb:nm(s.total_ram_mb,ag.reduce((t,a)=>t+a.ram_mb,0)),host_load:s.host_load??0};
  C.forEach(c=>sm[c[0]]=nm(s[c[0]],ag.filter(a=>a.category===c[0]).length));
  return{ts:cl(r.ts),summary:sm,agents:ag,resources:rs,edges:ed};
}

function injectPills(){
  if(!D)return;
  const mk=(id,c,t,h)=>{const b=D.createElement('button');b.type='button';b.id=id;b.className=c;b.title=t;b.setAttribute('aria-label',t);b.innerHTML=h;on(b,'click',()=>open());return b;};
  const rail=D.querySelector('.os-rail-controls'),mr=D.querySelector('.mobile-topbar-right');
  if(rail&&!D.getElementById('bai-live-pill'))S.el.p=rail.appendChild(mk('bai-live-pill','bai-pill','Box AI Neural Observatory (Alt+I)',dv('br1',sp('bpl','<span class=bd data-b=d></span><span class=bcn data-b=n>-- AI live</span>')+sp('bpr','<span class=bcp data-b=c>--%</span><kbd class=bkb>Alt+I</kbd>'))+dv('br2',C.map(c=>`<span class=bt data-c=${c[0]}><span class=bbw><span class=bbr data-b=b-${c[0]}></span></span><span class=btk>${c[2]}</span><span class=btv data-b=v-${c[0]}>0</span></span>`).join(''))));
  if(mr&&!D.getElementById('bai-mobile-pill')){const m=mk('bai-mobile-pill','bai-mob','Box AI Neural Observatory','<span class=bd data-b=md></span><span data-b=mn>-- AI</span>'),w=D.getElementById('mobile-whoop-pill');w?.parentNode===mr?mr.insertBefore(m,w):mr.prepend(m);S.el.m=m;}
}

function syncUI(){
  const s=S.d.summary,tot=s.total_live||0,mx=M.max(1,...C.map(c=>s[c[0]]||0)),q=(r,k)=>r?.querySelector(`[data-b="${k}"]`),tx=(e,v)=>e&&(e.textContent=v);
  if(S.el.p){q(S.el.p,'d')?.classList.toggle('is-idle',!tot);tx(q(S.el.p,'n'),`${tot} AI live`);tx(q(S.el.p,'c'),`${M.round(s.total_cpu_pct||0)}%`);C.forEach(c=>{const v=s[c[0]]||0,br=q(S.el.p,`b-${c[0]}`);tx(q(S.el.p,`v-${c[0]}`),v);if(br)br.style.height=`${!v?12:M.max(24,M.min(100,M.round(v/mx*100)))}%`;});}
  if(S.el.m){q(S.el.m,'md')?.classList.toggle('is-idle',!tot);tx(q(S.el.m,'mn'),`${tot} AI`);}
  if(!S.el.bd)return;
  tx(S.el.mAi,tot);tx(S.el.mCpu,`${(s.total_cpu_pct||0).toFixed(0)}%`);tx(S.el.mRam,fR(s.total_ram_mb||0));tx(S.el.mLd,(+(Array.isArray(s.host_load)?s.host_load[0]:s.host_load)||0).toFixed(2));
  S.el.bd.querySelectorAll('[data-bf]').forEach(b=>{const f=b.dataset.bf;b.setAttribute('aria-pressed',`${f===S.f}`);tx(b.querySelector('[data-fc]'),f==='all'?tot:s[f]||0);});
}

function insp(){
  const bx=S.el.in;if(!bx)return;
  const all=[...S.d.agents,...S.d.resources],n=all.find(x=>x.id===S.sel)||S.d.agents.slice().sort((a,b)=>b.cpu_pct-a.cpu_pct)[0],sc=(t,b)=>`<div>${sp('bsk',t)}${b}</div>`;
  if(!n){bx.innerHTML=sc('LIVE X-RAY',dv('bw','Waiting for /api/box/ai-live...'));return;}
  const ag=n.kind==='agent',re=S.d.edges.filter(e=>e.from===n.id||e.to===n.id),prs=[...new Set(re.map(e=>e.from===n.id?e.to:e.from))].map(id=>all.find(x=>x.id===id)).filter(Boolean);
  const c=CM[n.category]||CM.orchestrating,kvs=ag?[['PID',n.pid||'--'],['CPU',`${n.cpu_pct.toFixed(1)}%`],['RAM',fR(n.ram_mb)],['UPTIME',fU(n.uptime_s)]]:[['METRIC',es(n.metric||'--')],['CIRCUITS',re.length]];
  bx.innerHTML=dv('bih',`<div>${dv('bnm',es(n.name))}${dv('bsb',ag?`${c[1]} ${c[0].toUpperCase()} · ${es(n.runtime)}`:`05 HUB · ${es(n.rk)}`)}</div>${sp('blv',ag?es(n.state.toUpperCase()):`${n.active_count}x`)}`)+dv('bkg',kvs.map(([k,v])=>dv('bk',`<span>${k}</span><b>${v}</b>`)).join(''))+(ag?dv('bcs',(n.repo?sp('bc',`repo:${es(n.repo)}`):'')+(n.active_tool?sp('bc',`tool:${es(n.active_tool)}`):''))+sc('CURRENT ACTION',dv('bw',es(n.current_action||'Idle'))):'')+sc(`${ag?'CIRCUITS':'AGENTS'} (${prs.length})`,dv('bcs',prs.length?prs.map(p=>`<button type=button class=bc data-bp="${es(p.id)}">${es(p.name)}${p.kind==='agent'?` · ${M.round(p.cpu_pct)}%`:''}</button>`).join(''):sp('bsb','Standalone')))+(ag?sc('RECENT ACTIONS',dv('ba',n.recent_actions.length?n.recent_actions.map(a=>dv('bac',es(a))).join(''):sp('bsb','None'))):'');
}

function layout(Wpx,Hpx){
  const cmp=Wpx<700,px=cmp?12:16,pt=38,ags=S.f==='all'?S.d.agents:S.d.agents.filter(a=>a.category===S.f),res=S.d.resources,ns=[],cs=[],by=new Map();
  const put=(ls,x,w,h,g,ci,rt)=>ls.forEach((o,i)=>{const y=pt+i*(h+g),n={...o,x,y,w,h,px:rt?x+w:x,py:y+h/2,ci};ns.push(n);by.set(n.id,n);});
  const fh=(av,k,lo,hi,g)=>M.max(lo,M.min(hi,(av/M.max(1,k)|0)-g));
  const grp=cmp?[[ags,'01-04 LIVE AGENTS',cc('orchestrating')]]:C.map(c=>[ags.filter(a=>a.category===c[0]),`${c[1]} ${c[0].toUpperCase()}`,cc(c[0])]);
  const g0=cmp?6:10,nC=grp.length,tw=cmp?(Wpx-px*2)*.12|0:54,gp=cmp?0:20,us=Wpx-px*2-tw-gp*(nC-1),cw=cmp?(Wpx-px*2)*.52|0:(us*.76)/nC|0,rw=cmp?(Wpx-px*2)*.36|0:M.max(150,us-cw*nC),rx=Wpx-px-rw;
  const ah=fh(M.max(160,Hpx-pt-(cmp?16:M.min(130,M.max(72,Hpx*.22|0)))),M.max(1,...grp.map(g=>g[0].length)),cmp?42:48,cmp?54:64,g0);
  grp.forEach(([ls,lb,cl0],ci)=>{const x=px+ci*(cw+gp);cs.push([x,cw,lb,cl0]);put(ls,x,cw,ah,g0,ci,1);});
  cs.push([rx,rw,'05 SHARED BRAINS & REPOS',rc()]);put(res,rx,rw,fh(Hpx-pt-16,res.length,cmp?38:44,cmp?54:62,g0),g0,4,0);
  const db=ns.reduce((m,n)=>n.kind==='agent'?M.max(m,n.y+n.h):m,pt+80),ve=S.d.edges.filter(e=>by.has(e.from)&&by.has(e.to)),lT=M.min(Hpx-22,db+18),lS=M.max(18,Hpx-lT-14);
  S.L={n:ns,c:cs,w:Wpx,h:Hpx,e:ve.map((e,i)=>{const s=by.get(e.from),d=by.get(e.to),p=buildConduitPoints(s,d,i,ve.length,lT,lS,cmp);let t=0,u=[0];for(let k=1;k<p.length;k++)u.push(t+=M.hypot(p[k][0]-p[k-1][0],p[k][1]-p[k-1][1]));return{...e,s,d,p,g:{t:t||1,c:u}};})};
}

function buildConduitPoints(s,d,i,tot,lT,lS,cmp){
  const sx=s.px,sy=s.py,tx=d.px,ty=d.py,bz=(x0,y0,a,b,c,e,x3,y3,n)=>Array.from({length:n+1},(_,k)=>{const t=k/n,m=1-t;return[m*m*m*x0+3*m*m*t*a+3*m*t*t*c+t*t*t*x3,m*m*m*y0+3*m*m*t*b+3*m*t*t*e+t*t*t*y3];});
  if(cmp||s.ci===3){const mx=(sx+tx)/2;return[[sx,sy],...bz(sx+10,sy,mx,sy,mx,ty,tx-10,ty,8),[tx,ty]];}
  const gx=sx+14+(i%3)*3,ly=lT+((i+.5)/M.max(1,tot))*lS,ch=M.min(10,M.abs(ly-sy)*.45),kx=tx-44+((i%4)-1.5)*4;
  return[[sx,sy],[sx+10,sy],[gx,sy+(ly>=sy?ch:-ch)],[gx,ly-ch],[gx+ch,ly],...bz(kx-10,ly,kx+14,ly,tx-26,ty,tx-10,ty,5),[tx,ty]];
}
const ptAt=(p,s,u)=>{const g=M.max(0,M.min(1,u))*s.t;let i=1;while(i<s.c.length-1&&s.c[i]<g)i++;const a=p[i-1],b=p[i],f=(g-s.c[i-1])/(s.c[i]-s.c[i-1]||1);return[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f,M.atan2(b[1]-a[1],b[0]-a[0])];};
const A0=(c,x,y,r,f,st,lw)=>{c.beginPath();c.arc(x,y,r,0,6.283);if(f){c.fillStyle=f;c.fill();}if(st){c.strokeStyle=st;c.lineWidth=lw||1;c.stroke();}};
const clip=(c,t,mw)=>{let s=`${t||''}`;if(c.measureText(s).width<=mw)return s;while(s.length>2&&c.measureText(s+'..').width>mw)s=s.slice(0,-1);return s+'..';};

function drawSocket(c,x,y,col,isL,side,p){
  c.strokeStyle=isL?'#0f172a57':'#ffffff47';c.lineWidth=2.4;c.beginPath();c.moveTo(x,y);c.lineTo(x+(side==='right'?7:-7),y);c.stroke();
  const g=c.createLinearGradient(x,y-5.5,x,y+5.5);g.addColorStop(0,isL?'#fff':'#71788a');g.addColorStop(1,isL?'#94a3b8':'#1e222e');
  A0(c,x,y,5.4,g);A0(c,x,y,3.3,isL?'#1e293b':'#090b10');A0(c,x,y,2,col);A0(c,x-.6,y-.6,.7,'#fff');
  if(p>.01){c.save();c.globalAlpha=(1-p)*.78;A0(c,x,y,5.8+p*10.5,0,col,1.25);c.restore();}
}

function draw(now){
  const cv=S.el.cv,c=cv&&S.open&&cv.getContext('2d'),{n:ns,e:es0,c:cs,w,h}=S.L;if(!c||!w||!h)return;
  const dp=M.min(2,W?.devicePixelRatio||1),rw=M.round(w*dp),rh=M.round(h*dp);if(cv.width!==rw||cv.height!==rh){cv.width=rw;cv.height=rh;}
  c.save();c.scale(dp,dp);c.clearRect(0,0,w,h);
  const isL=lt(),rM=rm(),tS=rM?1.8:((now||0)-S.t0)*.001,fid=S.hov||S.sel,cN=new Set(),cE=new Set();
  const P=(isL?'#0f172a0f|#0f172a|#f1f5f9eb|#fff|#f8fafc|#0f172a24|#ffffffe6|#475569|#64748b|#0f172a17|#fffffff5':'#ffffff0d|#e5e7eb|#090b10e6|#1d2230|#141720|#ffffff1f|#ffffff17|#94a3b8|#8b95a7|#ffffff14|#0d1018f2').split('|');
  const bx=(x,y,W0,H0,r,fl,st,lw)=>{c.beginPath();c.roundRect?c.roundRect(x,y,W0,H0,r):c.rect(x,y,W0,H0);if(fl){c.fillStyle=fl;c.fill();}if(st){c.lineWidth=lw||1;c.strokeStyle=st;c.stroke();}};
  const tx=(s,x,y,f,co,al)=>{c.font=f;c.fillStyle=co;c.textAlign=al||'left';c.fillText(s,x,y);};
  const ps=(pts,st,lw,al)=>{c.globalAlpha=al;c.strokeStyle=st;c.lineWidth=lw;c.beginPath();pts.forEach((p,i)=>i?c.lineTo(p[0],p[1]):c.moveTo(p[0],p[1]));c.stroke();};
  if(fid){cN.add(fid);es0.forEach(e=>{if(e.from===fid||e.to===fid){cE.add(e.id);cN.add(e.from);cN.add(e.to);}});}
  cs.forEach(([x,cw,lb,cl0])=>{bx(x,10,cw,20,5,P[0]);A0(c,x+9,20,3,cl0);tx(clip(c,lb,cw-22),x+17,23.5,'600 10.5px'+MF,P[1]);});
  const dk=new Map(),ord=fid?es0.slice().sort((a,b)=>cE.has(a.id)-cE.has(b.id)):es0,hlb=[];
  c.lineCap=c.lineJoin='round';
  for(const e of ord){
    const hi=!fid||cE.has(e.id),as=fid?(hi?1:.14):.92,bw=1.4+M.min(2.2,e.weight*.8+(e.cpu_pct||0)/85),sc=cc(e.category,hi&&fid),dc=rc(hi&&fid);
    ps(e.p,P[2],bw+5,hi?.92:.35);ps(e.p,sc,bw+2.4,as*(hi&&fid?.34:.2));ps(e.p,isL?'#0f172a':'#fff',bw+3.1,as*(isL?.18:.22));
    const g=c.createLinearGradient(e.s.px,e.s.py,e.d.px,e.d.py);g.addColorStop(0,sc);g.addColorStop(1,dc);ps(e.p,g,M.max(1.2,bw*.58),as*(hi&&fid?1:.86));
    if(e.active){
      const vel=.16+M.min(1,(e.cpu_pct||e.s.cpu_pct||12)/100)*.44,cnt=e.cpu_pct>=35?2:1,sd=((e.id.charCodeAt(e.id.length-1)||7)*.173)%1;
      for(let k=0;k<cnt;k++){
        const u=rM?.52+k*.16:(tS*vel+sd+k/cnt)%1;if(!rM&&u<.14)dk.set(e.to,M.max(dk.get(e.to)||0,u/.14));
        for(let q=2;q>=1;q--)if(u-q*.026>.01){const ep=ptAt(e.p,e.g,u-q*.026);c.globalAlpha=as*(q===1?.52:.24);A0(c,ep[0],ep[1],q===1?2.1:1.4,sc);}
        const hp=ptAt(e.p,e.g,u);c.save();c.translate(hp[0],hp[1]);c.rotate(hp[2]);c.globalAlpha=as;c.fillStyle=isL?sc:'#fff';c.strokeStyle=sc;c.lineWidth=1.1;c.beginPath();c.moveTo(4.8,0);c.lineTo(0,2.5);c.lineTo(-4,0);c.lineTo(0,-2.5);c.closePath();c.fill();c.stroke();c.restore();
      }
    }
    if(S.hov&&cE.has(e.id)){const mp=ptAt(e.p,e.g,.52);hlb.push([mp[0],mp[1],[e.cpu_pct?`${M.round(e.cpu_pct)}% CPU`:'',e.label].filter(Boolean).join(' · ')||'LIVE',sc]);}
  }
  const sS=new Set(es0.flatMap(e=>[e.from,e.to]));
  for(const n of ns){
    const foc=n.id===S.hov||n.id===S.sel,ag=n.kind==='agent',col=ag?cc(n.category,foc):rc(foc);c.globalAlpha=!fid||cN.has(n.id)?1:.36;
    bx(n.x,n.y,n.w,n.h,7,foc?P[3]:P[4],foc?col:P[5],foc?1.5:1);ps([[n.x+8,n.y+.8],[n.x+n.w-8,n.y+.8]],P[6],1,c.globalAlpha);bx(n.x+2,n.y+6,2.8,n.h-12,1.5,col);
    tx(clip(c,n.name,n.w-(ag?50:42)),n.x+(ag?10:12),n.y+18,'600 11.5px'+SF,P[1]);
    tx(ag?`${M.round(n.cpu_pct)}%`:`${n.active_count}x`,n.x+n.w-10,n.y+18,'600 10px'+MF,ag&&n.cpu_pct<50?P[7]:col,'right');
    tx(clip(c,(ag?[n.runtime,n.active_tool||n.repo]:[n.rk,n.metric]).filter(Boolean).join(' · '),n.w-22),n.x+(ag?10:12),n.y+33,'400 10px'+MF,P[8]);
    if(ag){const bw=n.w-22;bx(n.x+10,n.y+n.h-9,bw,3.2,1.6,P[9]);bx(n.x+10,n.y+n.h-9,M.max(4,M.min(bw,(M.min(100,n.cpu_pct)/100)*bw)),3.2,1.6,col);}
    if(sS.has(n.id))drawSocket(c,n.px,n.py,col,isL,ag?'right':'left',ag?0:dk.get(n.id)||0);
  }
  c.globalAlpha=1;
  for(const[lx,ly,lt0,lc]of hlb.slice(0,6)){c.font='600 10px'+MF;const tw=c.measureText(lt0).width+12,x=M.max(8,M.min(w-tw-8,lx-tw/2)),y=M.max(32,M.min(h-22,ly-9));bx(x,y,tw,18,5,P[10],lc,1);tx(lt0,x+6,y+12.2,'600 10px'+MF,P[1]);}
  if(!ns.length)tx('No live AI processes detected.',w/2,h/2,'500 12px'+MF,P[7],'center');
  c.restore();
}

const stopRaf=()=>{if(S.raf){cancelAnimationFrame(S.raf);S.raf=0;}},startRaf=()=>{stopRaf();if(!S.open||D?.hidden)return;if(rm())return draw(performance.now());S.t0=performance.now();const tk=t=>{if(!S.open||D?.hidden){S.raf=0;return;}draw(t);S.raf=requestAnimationFrame(tk);};S.raf=requestAnimationFrame(tk);};
const fit=()=>{const r=S.open&&S.el.st?.getBoundingClientRect();if(r&&r.width>10&&r.height>10){layout(M.round(r.width),M.round(r.height));draw(performance.now());}};
const hit=(cx,cy)=>{const r=S.el.cv?.getBoundingClientRect();if(!r)return null;const x=cx-r.left,y=cy-r.top;return S.L.n.findLast(n=>x>=n.x&&x<=n.x+n.w&&y>=n.y&&y<=n.y+n.h)||null;};

function buildModalDom(){
  if(!D||S.el.bd?.isConnected)return;
  const bd=D.createElement('div');bd.id='kizuki-box-ai-backdrop';bd.className='bai-bd';bd.hidden=true;
  const fl=[['all','All'],...C.map(c=>[c[0],c[0][0].toUpperCase()+c[0].slice(1)])].map(f=>`<button type=button data-bf=${f[0]} aria-pressed=${f[0]===S.f}>${f[0]!=='all'?`<span class=bfd data-c=${f[0]}></span>`:''}<span>${f[1]}</span><span data-fc=1>0</span></button>`).join('');
  const mt=[['mAi','0',' AI'],['mCpu','0%',''],['mRam','0 MB',''],['mLd','0.00','']].map(([k,v,s],i)=>`<span>${['','CPU ','RAM ','Load '][i]}<b data-k=${k}>${v}</b>${s}</span>`).join('');
  bd.innerHTML=`<div class=bm role=dialog aria-modal=true aria-label="Box AI Neural Observatory"><header class=bh><div class=bhl><span class=bd></span><span class=btl>Box AI Neural Observatory</span><span class=blv>LIVE</span></div><div class=bf role=group>${fl}</div><div class=bhr><div class=bmt>${mt}</div><button type=button class=bx data-bx=1>Esc</button></div></header><div class=bb2><div class=bst data-k=st><canvas class=bcv data-k=cv></canvas></div><aside class=bi data-k=in></aside></div></div>`;
  D.body.appendChild(bd);S.el.bd=bd;bd.querySelectorAll('[data-k]').forEach(n=>{S.el[n.dataset.k]=n;});
  on(bd,'click',e=>{if(e.target===bd||e.target.closest('[data-bx]'))return close();const fb=e.target.closest('[data-bf]'),pk=e.target.closest('[data-bp]');if(fb)setFilter(fb.dataset.bf||'all');else if(pk)selectNode(pk.dataset.bp);});
  const mv=e=>{const h=e.type==='pointerleave'?null:hit(e.clientX,e.clientY),id=h?.id||null;if(id!==S.hov){S.hov=id;S.el.cv.classList.toggle('is-hit',!!id);if(rm())draw(performance.now());}};
  on(S.el.cv,'pointermove',mv);on(S.el.cv,'pointerleave',mv);on(S.el.cv,'click',e=>{const h=hit(e.clientX,e.clientY);if(h)selectNode(h.id);});
  if(typeof ResizeObserver==='function')new ResizeObserver(fit).observe(S.el.st);
  if(typeof MutationObserver==='function'&&D.documentElement)new MutationObserver(()=>{if(S.open){fit();startRaf();}}).observe(D.documentElement,{attributes:true,attributeFilter:['data-theme','data-detail']});
}

const applySnapshot=r=>{S.d=norm(r);syncUI();if(S.open){fit();insp();}};
async function refresh(){if(typeof fetch!=='function')return S.d;try{const r=await fetch('/api/box/ai-live',{headers:{Accept:'application/json'}});if(r?.ok)applySnapshot(await r.json());}catch{}return S.d;}
const stopNet=()=>{if(S.es){try{S.es.close();}catch{}S.es=null;}if(S.tm){clearInterval(S.tm);S.tm=0;}},startPl=ms=>{stopNet();if(!D?.hidden)S.tm=setInterval(()=>{if(!D?.hidden)refresh();},ms||5000);};
function startEs(){stopNet();if(D?.hidden||typeof EventSource!=='function')return startPl(3000);try{const z=new EventSource('/api/box/ai-live/stream'),ev=e=>{try{applySnapshot(JSON.parse(e.data));}catch{}};z.addEventListener('snapshot',ev);z.addEventListener('update',ev);z.onmessage=ev;z.onerror=()=>{stopNet();if(S.open&&!D?.hidden)startPl(3000);};S.es=z;}catch{startPl(3000);}}

function open(o){buildModalDom();if(!S.el.bd)return false;if(o?.filter&&(o.filter==='all'||CM[o.filter]))S.f=o.filter;S.open=true;S.el.bd.hidden=false;syncUI();insp();refresh();startEs();(typeof requestAnimationFrame==='function'?requestAnimationFrame:f=>setTimeout(f,0))(()=>{fit();startRaf();});return true;}
function close(){S.open=false;S.hov=null;stopRaf();stopNet();if(S.el.bd)S.el.bd.hidden=true;if(!D?.hidden)startPl(5000);return true;}
const toggle=()=>S.open?close():open(),setFilter=c=>{S.f=c==='all'||CM[c]?c:'all';syncUI();fit();insp();return S.f;},selectNode=id=>{S.sel=id||null;insp();if(rm())draw(performance.now());return S.sel;};

function boot(){
  if(!D||S.bt)return;S.bt=1;injectPills();syncUI();
  on(D,'keydown',e=>{if(e.key==='Escape'&&S.open){e.preventDefault();return close();}if(e.altKey&&!e.ctrlKey&&!e.metaKey&&(`${e.key||''}`.toLowerCase()==='i'||e.code==='KeyI')){e.preventDefault();toggle();}});
  on(D,'visibilitychange',()=>{if(D.hidden){stopRaf();stopNet();}else{refresh();if(S.open){startEs();startRaf();}else startPl(5000);}});
  on(W,'resize',()=>{if(S.open)fit();});refresh();if(!D.hidden)startPl(5000);
  try{if(W?.location?.search&&new URLSearchParams(W.location.search).get('ai')==='live')open();}catch{}
}
if(D)D.readyState==='loading'?on(D,'DOMContentLoaded',boot):boot();
return{open,close,toggle,isOpen:()=>S.open,setFilter,selectNode,refresh,applySnapshot,getState:()=>({open:S.open,filter:S.f,selectedId:S.sel,data:S.d}),boot};
});
