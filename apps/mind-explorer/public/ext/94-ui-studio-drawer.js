/* Kizuki UI/UX Studio Drawer (Alt+U) & Embla Momentum Rails */
(function(root,factory){'use strict';const api=factory();if(typeof module!=='undefined'&&module.exports)module.exports=api;if(root&&typeof root==='object')root.KizukiUIStudio=api;if(typeof window!=='undefined')window.KizukiUIStudio=api;})(typeof globalThis!=='undefined'?globalThis:typeof window!=='undefined'?window:this,function(){'use strict';
const RAIL_SELECTOR='.pr-lanes, .pr-radar-lanes, .taste-deck-strip, .pb-prep-cards';
const SEG=['Focus','Flow','Deep'],CF=['Perspective','Tactile','Signal'],STEPS=['Init','Tune','Lock','Ship'];
const ECG=[['REST',58,'2.6s'],['FOCUS',72,'1.9s'],['PEAK',108,'1.2s']];
const TILES=[['01', 'Solar Chronometer'],['02', 'Spring Segmented'],['03', 'Theme Detent'],['04', 'Sonner Stack'],['05', 'Neural Radar'],['06', 'Detent Stamp'],['07', 'Elastic Vernier'],['08', 'Biometric ECG'],['09', 'Cover Flow'],['10', 'Magnetic CTA'],['11', 'Step Track'],['12', 'Live Wire & Perf']];
const st={open:false,rm:false,seg:1,toasts:0,stamped:false,ver:64,ecg:0,cf:1,mag:0,step:2,tick:null,obs:null,raf:0,el:{}};
const D=()=>typeof document!=='undefined'?document:null,W=()=>typeof window!=='undefined'?window:null;
const on=(e,ev,fn,o)=>e?.addEventListener(ev,fn,o);
const tx=(k,v)=>{if(st.el[k])st.el[k].textContent=v;};
const at=(k,a,v)=>st.el[k]?.setAttribute(a,String(v));
const th=()=>D()?.documentElement?.getAttribute('data-theme')==='light'?'light':'dark';
const dt=()=>D()?.documentElement?.getAttribute('data-detail')==='off'?'off':'on';

const flip=(id,a,off,onV,ls)=>{
  const d=D();if(!d)return;const b=d.getElementById(id);
  if(b?.click)b.click();
  else{const n=d.documentElement.getAttribute(a)===off?onV:off;d.documentElement.setAttribute(a,n);if(ls)try{W()?.localStorage?.setItem(ls,n);}catch(_){}}
  syncPills();
};
const toggleTheme=()=>flip('btn-theme-toggle','data-theme','light','dark','kizuki-theme');
const toggleDetail=()=>flip('btn-detail-toggle','data-detail','off','on');
const fireToast=()=>{
  const msg=`Studio signal #${++st.toasts} queued`,kt=W()?.KizukiToast;
  try{
    if(typeof kt==='function')kt(msg,{type:'success'});
    else if(kt?.push)kt.push({title:'UI/UX Studio',message:msg,kind:'success'});
    else(kt?.show||kt?.success||kt?.toast)?.call(kt,msg,'success');
  }catch(_){}
  if(st.el.tm)st.el.tm.innerHTML=`<div class="k-ch">${msg}</div>`;
  tx('tf',`${st.toasts} fired`);
};
const updateSolar=()=>{
  const t=new Date(),h=t.getHours(),m=t.getMinutes();
  if(st.el.sp)st.el.sp.style.left=`${Math.max(2,Math.min(98,((h*60+m)/1440)*100)).toFixed(1)}%`;
  tx('sr',`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
  tx('sph',h<6?'NIGHT':h<11?'DAWN':h<17?'ZENITH':h<21?'DUSK':'NIGHT');
};
const renderSeg=()=>{
  if(!st.el.seg)return;
  if(st.el.segt)st.el.segt.style.transform=`translateX(${st.seg*100}%)`;
  st.el.seg.querySelectorAll('button').forEach((b,i)=>{b.classList.toggle('is-on',i===st.seg);b.setAttribute('aria-pressed',String(i===st.seg));});
  tx('segf',SEG[st.seg].toUpperCase());
};
const renderVernier=(v)=>{st.ver=Math.max(0,Math.min(100,Math.round(v*10)/10));if(st.el.vn)st.el.vn.style.left=`${st.ver.toFixed(1)}%`;tx('vv',`${st.ver.toFixed(1)} mm`);};
const renderCF=()=>{st.el.cfw?.querySelectorAll('.k-cf').forEach((c,i)=>{const r=i-st.cf;c.setAttribute('data-pos',String(r>1?r-3:r<-1?r+3:r));});tx('cff',`${st.cf+1}/3 ${CF[st.cf]}`);};
const renderSteps=()=>{st.el.steps?.querySelectorAll('.k-sn').forEach((n,i)=>{n.classList.toggle('is-done',i<st.step);n.classList.toggle('is-cur',i===st.step);});if(st.el.sfill)st.el.sfill.style.width=`calc((100% - 24px) * ${st.step/3})`;tx('stepf',`0${st.step+1} ${STEPS[st.step]}`);};
const renderEcg=()=>{const m=ECG[st.ecg];if(st.el.ecgl)st.el.ecgl.style.animationDuration=m[2];tx('ef',`${m[1]} BPM · ${m[0]}`);};
const syncPills=()=>{
  const t=th(),d=dt();
  tx('pt',t==='dark'?'Dark / Light':'Light / Dark');at('pt','aria-pressed',t==='light');
  tx('pd',d==='on'?'Detail On / Off':'Detail: Off');at('pd','aria-pressed',d==='on');
  tx('pr',st.rm?'Motion: Reduced':'Reduced Motion Preview');at('pr','aria-pressed',st.rm);
  at('st','data-rm-preview',st.rm?'1':'0');tx('dl',t==='dark'?'OBSIDIAN':'PORCELAIN');tx('df',`theme=${t}`);
};
async function syncWire(){
  const hc=W()?.KizukiHyperCache?.getStats?.();
  tx('wh',String((hc?.hits||0)+(hc?.swrHits||0)));tx('wc',String(hc?.cacheSize||0));tx('ws',hc?.liveState?String(hc.liveState).toUpperCase():'IDLE');
  if(typeof fetch!=='function')return;
  try{const r=await fetch('/api/semantic/stats');if(r?.ok){const j=await r.json();tx('rc',`${(j.total_indexed??j.vectorized_count??0).toLocaleString()} idx`);}}catch(_){}
  try{const r=await fetch('/api/live/status');if(r?.ok){const j=await r.json();tx('ws',j.watcher_active?`LIVE (${j.connected_clients||0})`:'STANDBY');tx('we',String(j.events_emitted||0));}}catch(_){}
}

function buildModalDom(){
  const d=D();if(!d||st.el.bd?.isConnected)return;
  const bd=d.createElement('div');bd.id='kizuki-studio-backdrop';bd.className='k-bd';bd.hidden=true;
  const B=(c,a,t)=>`<button type="button" class="${c}" ${a}>${t}</button>`;
  const S=(k,t)=>`<span data-k="${k}">${t}</span>`;
  const rC=[38,24,10].map((r,i)=>`<circle cx="44" cy="44" r="${r}" fill="none" stroke="var(--${i>1?'s':'b'})"/>`).join('');
  const wK=[['SWR HITS','wh',0],['CACHE','wc',0],['SSE BUS','ws','IDLE'],['EVENTS','we',0]].map((x)=>`<div class="k-kv k-well"><span class="k-k">${x[0]}</span><span class="k-v" data-k="${x[1]}">${x[2]}</span></div>`).join('');
  const sp=[
    ['<div class="k-sol k-well"><div class="k-stx"></div><div class="k-pin" data-k="sp"></div></div>',S('sph','ZENITH'),S('sr','--:--')],
    [`<div class="k-sg k-well" data-k="seg"><div class="k-sgt" data-k="segt"></div>${SEG.map((l,i)=>B('',`data-seg="${i}"`,l)).join('')}</div>`,'SPRING',S('segf','FLOW')],
    [B('k-dt k-well k-row','data-a="theme"',`<span class="k-kb"></span>${S('dl','OBSIDIAN')}`),'LIVE POLARITY',S('df','dark')],
    [B('k-b','data-a="toast"','+ Fire Stacked Toast')+'<div class="k-tm k-row" data-k="tm"></div>','KizukiToast',S('tf','0 fired')],
    [`<svg class="k-svg" viewBox="0 0 88 88">${rC}<g class="k-swp"><line x1="44" y1="44" x2="44" y2="6" stroke="var(--accent-cyan)" stroke-width="1.5"/></g><circle cx="44" cy="44" r="2.5" fill="var(--accent-cyan)"/></svg>`,'/api/semantic/stats',S('rc','-- idx')],
    [B('k-st','data-k="sb" data-a="stamp" aria-pressed="false"','READY'),'DIE-SEAL',S('sf','UNSEALED')],
    ['<div class="k-vr k-well" data-k="ver" role="slider" tabindex="0" aria-label="Elastic Vernier"><div class="k-vtx"></div><div class="k-vn" data-k="vn"></div></div>','DRAG / KEYS',S('vv','64.0 mm')],
    [`<svg class="k-ecg" viewBox="0 0 180 54"><path data-k="ecgl" class="k-ecgl" d="M0 30H34L42 22 48 34 56 8 64 46 72 26 82 30H118L126 22 132 34 140 8 148 46 156 26 166 30H180"/></svg>${B('k-b','data-a="ecg"','Cycle Cadence')}`,'SINUS',S('ef','58 BPM · REST')],
    [`<div class="k-cfw" data-k="cfw">${CF.map((c,i)=>B('k-cf',`data-cf="${i}"`,c)).join('')}</div><div class="k-row">${B('k-b','data-a="cfp"','&lt;')}${B('k-b','data-a="cfn"','&gt;')}</div>`,'3D DECK',S('cff','2/3 Tactile')],
    [B('k-mg','data-k="mb" data-a="mag"','Engage Pulse'),'POINTER PULL',S('mf','0 clicks')],
    [`<div class="k-sp k-row" data-k="steps"><div class="k-sf" data-k="sfill"></div>${STEPS.map((l,i)=>B('k-sn',`data-step="${i}" title="${l}"`,i+1)).join('')}</div>`,'CALIBRATE',S('stepf','03 Lock')],
    [`<div class="k-wg">${wK}</div>`,'HYPERWIRE',B('k-b','data-a="sync"','Sync')],
  ];
  const body=TILES.map((t,i)=>`<section class="k-t" data-studio-tile="${t[0]}" data-tactile-rim="1"><div class="k-tt k-row"><span class="k-n">${t[1]}</span><span class="k-i">${t[0]}</span></div><div class="k-s">${sp[i][0]}</div><div class="k-f k-row"><span>${sp[i][1]}</span><span>${sp[i][2]}</span></div></section>`).join('');
  const pills=[['pt','theme','Dark / Light'],['pd','detail','Detail On / Off'],['pr','rm','Reduced Motion Preview'],['','close','Esc']].map((p)=>B('k-p',`${p[0]?`data-k="${p[0]}" `:''}data-a="${p[1]}"`,p[2])).join('');
  bd.innerHTML=`<div class="k-m" data-k="st" role="dialog" aria-modal="true" aria-label="Kizuki UI/UX Studio"><header class="k-hd k-row"><div class="k-row"><span class="k-dot"></span><span class="k-tl">Kizuki UI/UX Studio &middot; 12 live primitives</span><span class="k-sub">Alt+U</span></div><div class="k-ct k-row">${pills}</div></header><div class="k-sc"><div class="k-g">${body}</div></div></div>`;
  d.body.appendChild(bd);
  st.el={bd};bd.querySelectorAll('[data-k]').forEach((n)=>{st.el[n.dataset.k]=n;});

  const ACT={
    close,theme:toggleTheme,detail:toggleDetail,toast:fireToast,sync:syncWire,
    rm:()=>{st.rm=!st.rm;syncPills();},
    stamp:()=>{st.stamped=!st.stamped;st.el.sb.classList.toggle('is-on',st.stamped);at('sb','aria-pressed',st.stamped);tx('sb',st.stamped?'APPROVED':'READY');tx('sf',st.stamped?'ENGRAVED':'UNSEALED');},
    ecg:()=>{st.ecg=(st.ecg+1)%ECG.length;renderEcg();},
    cfp:()=>{st.cf=(st.cf+2)%3;renderCF();},cfn:()=>{st.cf=(st.cf+1)%3;renderCF();},
    mag:()=>tx('mf',`${++st.mag} clicks`),
  };
  on(bd,'click',(e)=>{
    const t=e.target;if(t===bd)return close();
    const a=t.closest('[data-a]')?.dataset.a;if(a&&ACT[a])return ACT[a]();
    const sb=t.closest('[data-seg]');if(sb){st.seg=+sb.dataset.seg||0;return renderSeg();}
    const cc=t.closest('[data-cf]');if(cc){st.cf=+cc.dataset.cf||0;return renderCF();}
    const p=t.closest('[data-step]');if(p){st.step=+p.dataset.step||0;return renderSteps();}
  });
  let vd=false;const setV=(x)=>{const r=st.el.ver.getBoundingClientRect();if(r.width)renderVernier(((x-r.left)/r.width)*100);};
  on(st.el.ver,'pointerdown',(e)=>{vd=true;try{st.el.ver.setPointerCapture(e.pointerId);}catch(_){}setV(e.clientX);});
  on(st.el.ver,'pointermove',(e)=>{if(vd)setV(e.clientX);});
  on(st.el.ver,'pointerup',()=>{vd=false;});
  on(st.el.ver,'keydown',(e)=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();renderVernier(st.ver+(e.key==='ArrowRight'?5:-5));}});
  const mt=bd.querySelector('[data-studio-tile="10"]');
  on(mt,'pointermove',(e)=>{if(st.rm||!st.el.mb)return;const r=st.el.mb.getBoundingClientRect(),cl=(v,m)=>Math.max(-m,Math.min(m,v));st.el.mb.style.transform=`translate(${cl((e.clientX-(r.left+r.width/2))*0.22,10).toFixed(1)}px,${cl((e.clientY-(r.top+r.height/2))*0.22,8).toFixed(1)}px)`;});
  on(mt,'pointerleave',()=>{if(st.el.mb)st.el.mb.style.transform='translate(0,0)';});
  renderSeg();renderVernier(st.ver);renderCF();renderSteps();renderEcg();
}

function open(){buildModalDom();if(!st.el.bd)return false;st.open=true;st.el.bd.hidden=false;syncPills();updateSolar();syncWire();if(st.tick)clearInterval(st.tick);st.tick=setInterval(updateSolar,1000);return true;}
function close(){st.open=false;if(st.tick){clearInterval(st.tick);st.tick=null;}if(st.el.bd)st.el.bd.hidden=true;return true;}
const toggle=()=>st.open?close():open();

function bindRail(rail){
  if(!rail||rail.getAttribute('data-ku-rail')==='1')return;
  rail.setAttribute('data-ku-rail','1');
  let drag=false,mv=false,sx=0,sl=0,vel=0,lx=0,raf=0,dots=null;
  on(rail,'pointerdown',(e)=>{if(e.button!==0||rail.scrollWidth<=rail.clientWidth+8)return;if(raf){cancelAnimationFrame(raf);raf=0;}drag=true;mv=false;sx=lx=e.clientX;sl=rail.scrollLeft;vel=0;});
  on(rail,'pointermove',(e)=>{if(!drag)return;const dx=e.clientX-sx;if(!mv&&Math.abs(dx)>6){mv=true;rail.classList.add('is-dragging');try{rail.setPointerCapture(e.pointerId);}catch(_){}}if(mv){vel=e.clientX-lx;lx=e.clientX;rail.scrollLeft=sl-dx;}});
  const end=()=>{if(!drag)return;drag=false;rail.classList.remove('is-dragging');if(mv&&Math.abs(vel)>1.2){let v=vel*1.15;const g=()=>{rail.scrollLeft-=v;v*=0.92;raf=Math.abs(v)>0.4?requestAnimationFrame(g):0;};raf=requestAnimationFrame(g);}};
  on(rail,'pointerup',end);on(rail,'pointercancel',end);
  on(rail,'click',(e)=>{if(mv){e.preventDefault();e.stopPropagation();mv=false;}},true);
  on(rail,'wheel',(e)=>{if(rail.scrollWidth>rail.clientWidth+8&&e.shiftKey&&e.deltaY){e.preventDefault();rail.scrollLeft+=e.deltaY;}},{passive:false});
  const d=D(),syncDots=()=>{
    const ov=rail.scrollWidth-rail.clientWidth;if(ov<=8){if(dots)dots.hidden=true;return;}
    const pgs=Math.max(2,Math.min(6,Math.ceil(rail.scrollWidth/Math.max(1,rail.clientWidth))));
    if(!dots&&d&&rail.parentNode){dots=d.createElement('div');dots.className='ku-rail-dots';rail.parentNode.insertBefore(dots,rail.nextSibling);}
    if(!dots)return;dots.hidden=false;
    if(dots.childElementCount!==pgs){dots.innerHTML='';for(let i=0;i<pgs;i+=1){const b=d.createElement('button');b.type='button';b.className='ku-rail-dot';b.setAttribute('aria-label',`Slide ${i+1}`);on(b,'click',()=>{const x=(i/Math.max(1,pgs-1))*(rail.scrollWidth-rail.clientWidth);rail.scrollTo?rail.scrollTo({left:x,behavior:'smooth'}):(rail.scrollLeft=x);});dots.appendChild(b);}}
    const act=Math.round((rail.scrollLeft/ov)*(pgs-1));dots.querySelectorAll('.ku-rail-dot').forEach((el,i)=>el.classList.toggle('is-active',i===act));
  };
  on(rail,'scroll',syncDots,{passive:true});syncDots();
}
function enhanceRails(sc){const el=sc||D();if(!el?.querySelectorAll)return 0;const l=el.querySelectorAll(RAIL_SELECTOR);l.forEach(bindRail);return l.length;}
function boot(){
  const d=D(),w=W();if(!d||d.__kuStudioBound)return;d.__kuStudioBound=true;
  on(d,'keydown',(e)=>{if(e.key==='Escape'&&st.open){e.preventDefault();return close();}if(e.altKey&&!e.ctrlKey&&!e.metaKey&&(String(e.key||'').toLowerCase()==='u'||e.code==='KeyU')){e.preventDefault();toggle();}});
  enhanceRails(d);
  if(typeof MutationObserver==='function'&&d.body){st.obs=new MutationObserver(()=>{if(st.raf)return;const sch=typeof requestAnimationFrame==='function'?requestAnimationFrame:(f)=>setTimeout(f,16);st.raf=sch(()=>{st.raf=0;enhanceRails(d);});});st.obs.observe(d.body,{childList:true,subtree:true});}
  try{const qs=w?.location?.search?new URLSearchParams(w.location.search):null;if(qs?.get('studio')==='1')open();}catch(_){}
}
const d0=D();if(d0)d0.readyState==='loading'?on(d0,'DOMContentLoaded',boot,{once:true}):boot();
return{open,close,toggle,isOpen:()=>st.open,enhanceRails,getTileIds:()=>TILES.map((t)=>t[0]),RAIL_SELECTOR,boot};
});
