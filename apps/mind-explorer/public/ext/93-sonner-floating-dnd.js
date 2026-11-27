/* Kizuki SFD */
(function(g,f){'use strict';const a=f(g||{});if(typeof module!='undefined'&&module.exports)module.exports=a;if(g)g.KizukiToast=a.toast,g.KizukiSfd=a;})(typeof globalThis!='undefined'?globalThis:this,function(G){
'use strict';
const W=G.window||null,D=G.document||null,LS=W?.localStorage,enc=encodeURIComponent,fin=Number.isFinite,isA=Array.isArray,sT=setTimeout,cT=clearTimeout,M=Math,R=M.round,P='pointer',A='aria-',rAF=G.requestAnimationFrame||sT,
T={info:1,ok:1,warn:1,accent:1},ECG={live:'M1 8 H9 L12 6 L14 8 L16 12 L19 2 L22 11 L24 8 L27 6.5 L29 8 H35',stale:'M1 8 H13 L16 7 L19 8.8 L22 8 H35',flat:'M1 8 H35'},
cln=v=>String(v??'').replace(/\s*\u2014\s*/g,' - ').replace(/\u2014/g,'-'),trm=v=>cln(v).trim(),esc=v=>cln(v).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';'),clp=(n,a,b)=>M.max(a,M.min(b,n)),
det=k=>{try{W?.KizukiTactile?.clickDetent?.(k||'tick');}catch{}},
on=(n,e,f,o)=>n?.addEventListener(e,f,o),off=(n,e,f)=>n?.removeEventListener(e,f),evs=(n,m,o)=>{for(const k in m)on(n,k,m[k],o);},
qs=(p,s)=>p?.querySelector(s),tx=(p,s)=>qs(p,s)?.textContent,clz=(e,s)=>e.target?.closest?.(s),ga=(n,k)=>n?.getAttribute(k),da=(n,k)=>ga(n,'data-'+k),sa=(n,k,v)=>n?.setAttribute(k,v),sp=(n,k,v)=>n?.style.setProperty(k,v),tg=(n,c,v)=>n?.classList.toggle(c,v),stp=e=>{e.preventDefault();e.stopPropagation();},
mk=(t,c,at)=>{const n=D.createElement(t);if(c)n.className=c;for(const k in at)sa(n,k,at[k]);return n;},
drg=(el,id,mv,dn)=>{try{el.setPointerCapture(id);}catch{}const up=()=>{off(el,P+'move',mv);off(el,P+'up',up);off(el,P+'cancel',up);dn();};evs(el,{[P+'move']:mv,[P+'up']:up,[P+'cancel']:up});},
card=(t,b,m,c,ch)=>`<div class=sph><span class=spt>${esc(t)}</span><span class=spb>${esc(b)}</span></div>`+(m?.length?`<div class=spm>${m.map(x=>`<span>${esc(x)}</span>`).join('')}</div>`:'')+(c?`<div class=spc>${esc(String(c).slice(0,180))}</div>`:'')+(ch?.length?`<div class=spcs>${ch.map(x=>`<span class=spch>${esc(x)}</span>`).join('')}</div>`:'');
function pos(a,p,v,o){
const m=o?.margin??12,g=o?.gap??8,vw=M.max(0,+v?.width||1024),vh=M.max(0,+v?.height||768),w=M.min(+p?.width||312,M.max(160,vw-m*2)),h=M.max(40,+p?.height||140),
aT=+a?.top||0,aB=+a?.bottom||aT,aL=+a?.left||0,aW=+a?.width||M.max(0,(+a?.right||aL)-aL),bl=vh-m-aB-g,ab=aT-g-m,
pl=o?.prefer==='top'?(ab>=h||ab>=bl?'top':'bottom'):(bl>=h||bl>=ab?'bottom':'top'),cx=aL+aW/2,
top=clp(R(pl==='bottom'?aB+g:aT-g-h),m,M.max(m,vh-m-h)),left=clp(R(cx-w/2),m,M.max(m,vw-m-w));
return{left,top,width:R(w),height:R(h),placement:pl,arrowX:clp(R(cx-left),14,M.max(14,R(w-14)))};
}
function reord(ids,f,t){const o=isA(ids)?[...ids]:[];if(f>=0&&f<o.length&&t>=0&&t<o.length&&f!==t)o.splice(t,0,o.splice(f,1)[0]);return o;}
function applyOrd(ids,sv){if(!isA(ids)||!isA(sv)||!sv.length)return isA(ids)?[...ids]:[];const rk=new Map(sv.map((x,i)=>[String(x),i]));return [...ids].sort((a,b)=>(rk.get(String(a))??1e6)-(rk.get(String(b))??1e6));}
function ecgSt(w,nowMs){
if(!w||typeof w!='object')return{status:'offline',tone:'stale',path:ECG.flat,summary:'Whoop offline',rows:[['Status','No telemetry']]};
const rec=w.recovery_pct??w.recovery,hrv=w.hrv_ms??w.hrv,slp=w.sleep_hours??w.sleep,rhr=w.rhr_bpm??w.resting_heart_rate??w.rhr,dl=cln(w.date_label||w.date||'--'),
ts=w.date?Date.parse(w.date):NaN,age=w.age_days!=null&&fin(+w.age_days)?+w.age_days:(fin(ts)?((nowMs||Date.now())-ts)/864e5:null),
st=Boolean(w.is_stale)||(age!==null&&age>2),rows=[];
for(const[k,v,u,f]of[['Recovery',rec,'%'],['HRV',hrv,' ms'],['Sleep',slp,' h',1],['RHR',rhr,' bpm']])if(v!=null&&fin(+v))rows.push([k,(f?(+v).toFixed(1):R(+v))+u]);
rows.push(['Sync',st?dl+' (stale)':dl]);
if(st)return{status:'stale',tone:'stale',path:ECG.stale,summary:`Whoop stale (${dl})`,rows};
const r=+rec;return{status:'live',tone:!fin(r)?'stale':r>=67?'green':r>=34?'amber':'red',path:ECG.live,summary:fin(r)?`Whoop ${R(r)}% live`:'Whoop live',rows};
}
function mkDeck(o){
const maxV=o?.maxVisible||3,now=o?.now||Date.now,st=o?.setTimeout||sT,ct=o?.clearTimeout||cT,xs=[];
let seq=0,pd=0,ex=0,lD=-Infinity,dk=null,ls=null;
const clr=x=>{if(x?.q!=null)ct(x.q),x.q=null;},drp=x=>{clr(x);x?.e?.remove();},
arm=x=>{clr(x);if(!pd&&fin(x.r)&&x.r>0)x.s=now(),x.q=st(()=>dismiss(x.id),x.r);},
pause=()=>{if(pd)return;pd=1;const t=now();for(const x of xs)if(x.q!=null)x.r=M.max(250,x.r-M.max(0,t-x.s)),clr(x);},
resume=()=>{if(pd)pd=0,xs.forEach(arm);},
sync=()=>{
if(!D?.body)return;
if(!dk?.isConnected){dk=D.getElementById('kizuki-sonner-deck');if(!dk){dk=D.body.appendChild(mk('section','',{id:'kizuki-sonner-deck',[A+'label']:'Notifications',[A+'live']:'polite',[A+'atomic']:'false'}));evs(dk,{[P+'enter']:()=>{ex=1;tg(dk,'is-exp',1);pause();},[P+'leave']:()=>{ex=0;tg(dk,'is-exp',0);resume();},focusin:pause,focusout:e=>{!dk.contains(e.relatedTarget)&&resume();},click:e=>{const li=clz(e,'.st'),x=li&&xs.find(z=>z.id===li.dataset.tid);if(!x)return;if(clz(e,'.sta')){det('stamp');try{x.f?.();}catch{}dismiss(x.id);}else if(clz(e,'.stc'))dismiss(x.id);},[P+'down']:e=>{const li=clz(e,'.st');if(!li||e.button||clz(e,'button'))return;let sx=e.clientX,dx=0;tg(li,'is-sw',1);drg(li,e.pointerId,ev=>{dx=ev.clientX-sx;sp(li,'--dx',dx+'px');li.style.opacity=clp(1-M.abs(dx)/220,.25,1);},()=>{tg(li,'is-sw',0);M.abs(dx)>=72?(tg(li,'is-out',1),st(()=>dismiss(li.dataset.tid),150)):(sp(li,'--dx','0px'),li.style.opacity='');});}});}ls=qs(dk,'.stl')||dk.appendChild(mk('ol','stl'));}
let ay=0;
xs.forEach((x,i)=>{if(!x.e){const li=x.e=mk('li','st is-in',{'data-tid':x.id,'data-tone':x.n});li.innerHTML=`<span class=std></span><div class=stb><div class=stt>${esc(x.t)}</div>${x.d?`<div class=sts>${esc(x.d)}</div>`:''}</div><div class=stt2>${x.a?`<button type=button class=sta>${esc(x.a)}</button>`:''}<button type=button class=stc aria-label=Dismiss>&times;</button></div>`;ls.prepend(li);rAF(()=>tg(li,'is-in',0));}x.e.dataset.idx=i;sp(x.e,'--idx',i);sp(x.e,'--ey',ay+'px');ay+=(x.e.offsetHeight||58)+8;});
tg(dk,'is-exp',ex);
},
push=s0=>{const s=s0&&typeof s0=='object'?s0:{title:s0},t=trm(s.title||'Notice');if(!t)return null;const tk=String(s.tone||'info').toLowerCase(),r=s.durationMs===0||s.durationMs===Infinity?Infinity:(+s.durationMs>0?+s.durationMs:4600),x={id:'t-'+(++seq),t,d:trm(s.detail),n:T[tk]?tk:'info',a:trm(s.actionLabel),f:typeof s.onAction=='function'?s.onAction:0,r,s:now(),q:null,e:null};xs.unshift(x);while(xs.length>maxV)drp(xs.pop());arm(x);sync();return x.id;},
dismiss=id=>{const i=xs.findIndex(x=>x.id===id);if(i<0)return false;drp(xs.splice(i,1)[0]);sync();return true;},
clear=()=>{while(xs.length)drp(xs.pop());sync();},
onLiveDelta=d=>{const t=now(),sc=isA(d?.scopes)?d.scopes.filter(Boolean):[];if(t-lD<12e3||!sc.length)return null;lD=t;return push({title:'Live sync',detail:sc.slice(0,4).join(', '),tone:'info',durationMs:3600});};
return{push,dismiss,clear,pause,resume,onLiveDelta,setExpanded:v=>(ex=v?1:0,sync()),getItems:()=>xs.map((x,idx)=>({id:x.id,idx,title:x.t,detail:x.d,tone:x.n,actionLabel:x.a})),demo:()=>['Saved','Stamped','Synced'].forEach((t,i)=>push({title:t,tone:['ok','accent','info'][i],actionLabel:i-1?'':'Undo'}))};
}
const toast=mkDeck(),pc=new Map(),ENT='[data-person-key],[data-open-person],[data-thread-id],.iask-cite-pill,.iask-cit-pill';
let pe=null,dw=null,cl=null,aa=null,ab=null;
const cP=()=>{cT(dw);cT(cl);dw=cl=null;try{ab?.abort();}catch{}ab=aa=null;if(pe)tg(pe,'is-open',0),sa(pe,A+'hidden','true');},
sC=()=>{cT(dw);dw=null;cT(cl);cl=sT(cP,120);},
pP=a=>{if(!pe||!a||!W)return;const p=pos(a.getBoundingClientRect(),{width:pe.offsetWidth||312,height:pe.offsetHeight||132},{width:W.innerWidth,height:W.innerHeight});sp(pe,'--px',p.left+'px');sp(pe,'--py',p.top+'px');pe.style.width=p.width+'px';pe.dataset.pl=p.placement;},
sP=(h,a)=>{if(!D?.body)return;if(!pe?.isConnected){pe=D.getElementById('kizuki-float-pop')||D.body.appendChild(mk('aside','',{id:'kizuki-float-pop',role:'tooltip',[A+'hidden']:'true'}));evs(pe,{[P+'enter']:()=>{cT(cl);cl=null;},[P+'leave']:sC});}pe.innerHTML=h;sa(pe,A+'hidden','false');pP(a);tg(pe,'is-open',1);},
oP=a=>{if(!a?.isConnected)return;aa=a;const pk=da(a,'person-key')||da(a,'open-person'),tid=!pk&&da(a,'thread-id');if(!pk&&!tid){const ix=da(a,'cit-jump')||da(a,'cite-idx'),cd=ix&&qs(D,`.iask-ev-card[data-cit-idx="${ix.replace(/"/g,'')}"]`);return sP(card(da(a,'cite-title')||tx(cd,'.iask-ev-title,strong')||ga(a,'title')||'Source',da(a,'cite-kind')||tx(cd,'.iask-ev-kind')||'cite',0,da(a,'cite-snippet')||tx(cd,'.iask-ev-snippet,p')||'Source.'),a);}const url=pk?`/api/people/dossier?key=${enc(pk)}&limit=6`:`/api/agent-board/context?threadId=${enc(tid)}`;if(pc.has(url))return sP(pc.get(url),a);try{ab?.abort();}catch{}ab=G.AbortController?new G.AbortController():null;sP(card(pk||'#'+tid,'loading',0,'Loading...'),a);G.fetch?.(url,ab?{signal:ab.signal}:undefined).then(r=>r.ok?r.json():null).then(d=>{if(!d||aa!==a)return;const p=d.person||d,l=isA(d.mindLinks)?d.mindLinks.slice(0,4):[],rl=d.relatedThreads?.[0],h=pk?card(p.name||p.key||'Person',p.relationship_tier||p.profile_tier||'Contact',[p.org||p.role,p.message_count!=null&&p.message_count+' msgs',p.last_seen_label].filter(Boolean),p.preview||d.timeline?.[0]?.text,isA(p.channels)?p.channels.slice(0,4):[]):card('Thread #'+tid,d.signal?.signalKind||'thread',[d.channel||'board',l.length+' links'],rl?.preview||rl?.title||d.signal?.reason,l.map(x=>x.label||x.id));if(pc.size>=80)pc.delete(pc.keys().next().value);pc.set(url,h);sP(h,a);}).catch(()=>{});},
DL='.tr-list,.tr-moves-list,#today-actions-list',DI='.tr-card,.today-action-item,.today-action-card';
let le=null,kb=null;
const say=m=>{if(!D?.body)return;if(!le?.isConnected)le=D.body.appendChild(mk('div','sdl',{[A+'live']:'assertive',[A+'atomic']:'true'}));le.textContent='';sT(()=>{le.textContent=cln(m);},20);},
idOf=(e,i)=>da(e,'move-id')||da(e,'action-id')||da(e,'item-id')||e.id||'i'+i,
tOf=e=>trm(tx(e,'.tr-card-title,.today-action-title,h3,strong')||'item').slice(0,32),
sKey=l=>'kizuki:dnd-order:'+(l.id||'tr-moves'),kids=l=>[...l.children].filter(e=>e.matches?.(DI)),
sO=l=>{try{LS?.setItem(sKey(l),JSON.stringify(kids(l).map(idOf)));}catch{}},
mI=(l,it,s,i,ni)=>{l.insertBefore(it,ni<i?s[ni]:s[ni].nextSibling);det('tick');},
sG=(b,it,c,v)=>{sa(b,A+'pressed',v?'true':'false');tg(it,c,v);},
scD=()=>{D?.querySelectorAll(DL).forEach(l=>{let its=kids(l);if(its.length<2)return;if(!l.dataset.ord){try{const sv=JSON.parse(LS?.getItem(sKey(l))||'[]'),c=its.map(idOf),nx=applyOrd(c,sv);if(nx.join('|')!==c.join('|')){const m=new Map(its.map((e,i)=>[idOf(e,i),e]));nx.forEach(id=>m.get(id)&&l.appendChild(m.get(id)));its=kids(l);}}catch{}l.dataset.ord=1;}for(const it of its){tg(it,'sdi',1);if(qs(it,'.sfd-drag-handle'))continue;const b=mk('button','sfd-drag-handle',{type:'button',role:'button',[A+'roledescription']:'sortable',[A+'pressed']:'false',[A+'label']:'Reorder '+tOf(it)});b.innerHTML='<svg width=8 height=12 viewBox="0 0 8 12" fill=currentColor><path d="M1 1h2v2H1zm4 0h2v2H5zM1 5h2v2H1zm4 0h2v2H5zM1 9h2v2H1zm4 0h2v2H5z"/></svg>';(qs(it,'.tr-card-title-row')||it).prepend(b);}});};
let ecg=ecgSt(null);
const rE=st=>{ecg=st;const h=qs(D,'#rail-whoop .rail-whoop-top')||qs(D,'.whoop-pill');if(!h)return;let w=qs(h,'.sew');if(!w){w=mk('span','sew',{tabindex:0,role:'img'});const d=qs(h,'#rail-whoop-date'),tip=()=>{cT(cl);cl=null;aa=w;sP(card('Whoop',ecg.status,0,'',ecg.rows.map(x=>x.join(': '))),w);};d?h.insertBefore(w,d):h.appendChild(w);evs(w,{[P+'enter']:tip,focusin:tip,[P+'leave']:sC,focusout:sC});}w.dataset.status=st.status;w.dataset.tone=st.tone;sa(w,A+'label',st.summary);w.title=st.summary;w.innerHTML=`<svg class=ses width=36 height=14 viewBox="0 0 36 14"><path class=seb d="${st.path}"/><path class=sep d="${st.path}"/></svg>`;},
fE=()=>G.fetch?.('/api/today?includeNoise=false').then(r=>r.ok?r.json():null).then(d=>rE(ecgSt(d?.whoop||null))).catch(()=>rE(ecgSt(null))),
init=()=>{
if(!D||!W||D.__sfd)return;D.__sfd=1;
const armP=a=>{if(a&&a!==aa)cT(cl),cl=null,cT(dw),dw=sT(()=>oP(a),260);},dt=e=>e?.detail||{};
evs(D,{[P+'over']:e=>armP(clz(e,ENT)),[P+'out']:e=>{const a=clz(e,ENT),rt=e.relatedTarget;a&&!(rt&&(a.contains(rt)||pe?.contains(rt)))&&sC();}},{passive:1});
evs(D,{
focusin:e=>armP(clz(e,ENT)),focusout:e=>{!pe?.contains(e.relatedTarget)&&aa&&sC();},
keydown:e=>{const b=clz(e,'.sfd-drag-handle');if(!b)return e.key==='Escape'&&cP();const it=b.closest(DI),l=it?.closest(DL),k=e.key;if(!l)return;const s=kids(l),i=s.indexOf(it),ok=kb?.b===b;if(k===' '||k==='Enter'){stp(e);ok?(kb=null,sG(b,it,'is-kb',0),sO(l),det('stamp'),say(`Dropped ${tOf(it)} ${i+1}/${s.length}`)):(kb={b,pre:[...s]},sG(b,it,'is-kb',1),say(`Grabbed ${tOf(it)} ${i+1}/${s.length}`));}else if(ok&&(k==='ArrowUp'||k==='ArrowDown')){stp(e);const ni=clp(i+(k==='ArrowUp'?-1:1),0,s.length-1);if(ni!==i)mI(l,it,s,i,ni),b.focus(),say(`Moved ${tOf(it)} ${ni+1}/${s.length}`);}else if(ok&&k==='Escape'){stp(e);sG(b,it,'is-kb',0);kb.pre.forEach(n=>l.appendChild(n));kb=null;b.focus();say('Cancelled');}},
[P+'down']:e=>{const b=clz(e,'.sfd-drag-handle');if(!b||e.button)return;const it=b.closest(DI),l=it?.closest(DL);if(!l)return;stp(e);let sy=e.clientY;sG(b,it,'is-dr',1);drg(b,e.pointerId,ev=>{it.style.transform=`translate3d(0,${clp(ev.clientY-sy,-48,48)}px,0)`;const s=kids(l),i=s.indexOf(it);for(let k=0;k<s.length;k++){if(s[k]===it)continue;const rc=s[k].getBoundingClientRect(),md=rc.top+rc.height/2;if((k<i&&ev.clientY<md)||(k>i&&ev.clientY>md)){mI(l,it,s,i,k);sy=ev.clientY;break;}}},()=>{it.style.transform='';sG(b,it,'is-dr',0);sO(l);det('stamp');});}
});
on(W,'scroll',cP,{capture:1,passive:1});
evs(W,{resize:()=>{aa&&pe?.classList.contains('is-open')&&pP(aa);},'kizuki:live-delta':e=>{const d=dt(e);toast.onLiveDelta(d);isA(d.scopes)&&d.scopes.includes('today')&&fE();},'kizuki:decision-stamped':e=>{const d=dt(e);toast.push({title:d.retracted?'Retracted':'Stamped '+String(d.verdict||'ok').toUpperCase(),detail:d.threadId?'#'+d.threadId:'',tone:d.retracted?'warn':'ok'});},'kizuki:capture-saved':e=>{const d=dt(e);toast.push({title:d.title||'Captured',detail:d.detail||'',tone:'ok'});}});
scD();rE(ecg);fE();
let rf=0;G.MutationObserver&&D.body&&new G.MutationObserver(()=>{if(!rf)rf=rAF(()=>{rf=0;scD();});}).observe(D.body,{childList:1,subtree:1});
};
if(D)D.readyState==='loading'?on(D,'DOMContentLoaded',init,{once:1}):init();
return{toast,createToastDeck:mkDeck,computePopoverPosition:pos,reorderList:reord,applySavedOrder:applyOrd,buildEcgState:ecgSt,refreshWhoopEcg:fE,scanDndLists:scD,init};
});
