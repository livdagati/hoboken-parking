/* Hoboken Sweep: street sweeping map, parked-car lookup, calendar alerts. No server. */
const DAYNAMES=['Monday','Tuesday','Wednesday','Thursday','Friday'];
const DAYSHORT=['Mon','Tue','Wed','Thu','Fri'];
const DAYCOL=['#1f6bff','#12b76a','#ffb000','#ff5a1f','#a43cff'];
const PARK={res:{label:'Residents only',col:'#12b76a'},res4:{label:'4 hr + residents',col:'#1f6bff'},pay4:{label:'4 hr pay only',col:'#ff8a00'}};
const UNK='#8d949c';
const $=s=>document.querySelector(s);
const store={get(k,d){try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};

let state={zones:store.get('zones',{}),showClosures:store.get('showClosures',true),
  mode:'sweep', day:'all',
  dayOf:store.get('dayOf','08:00'), lead:store.get('lead',60), weekly:store.get('weekly',false),
  parked:store.get('parked',null), myPark:store.get('myPark',{})
};
let paint=null, geo=null, holidays={}, sharedPark={}, keys={}, layer=null, map, hilite=null, meMarker=null;

/* ---------- time helpers ---------- */
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const t12=h=>h===12?'noon':`${h%12||12}${h<12?'am':'pm'}`;
const range=(s,e)=>`${t12(s)}–${t12(e)}`.replace('noonam','noon');
const fmtTime=m=>{const h=Math.floor(m/60),mi=m%60;return `${h%12||12}:${pad(mi)} ${h<12?'am':'pm'}`};
const dayIdx=d=>(d.getDay()+6)%7; // Mon=0
const isHol=d=>holidays[ymd(d)];
function weekdayList(days){return days.length===5?'Monday to Friday':days.map(i=>DAYNAMES[i]).join(', ')}
function dateLabel(d){return d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})}

/* ---------- data ---------- */
async function load(){
  const custom=store.get('customGeo',null);
  const [g,h,p,zz]=await Promise.all([
    custom?Promise.resolve(custom):fetch('data/segments.geojson').then(r=>r.json()),
    fetch('data/holidays.json').then(r=>r.json()).catch(()=>({dates:{}})),
    fetch('data/parking.json').then(r=>r.json()).catch(()=>({})),
    fetch('data/zones.json').then(r=>r.json()).catch(()=>[])
  ]);
  geo=g; holidays=h.dates||{}; sharedPark=p; pmZones=zz||[];
  const last=Object.keys(holidays).sort().pop();
  $('#holNote').textContent=`City holidays known through ${last||'?'}. Cleaning is skipped on those days. Weather suspensions are announced on Nixle, so this app is a guide, not a guarantee.`;
  importFromHash();
  buildIndex(); draw();
}
function buildIndex(){
  keys={};
  geo.features.forEach(f=>{const k=f.properties.id+'|'+f.properties.side;(keys[k]=keys[k]||{p:f.properties,lines:[]}).lines.push(f.geometry.coordinates.map(c=>[c[1],c[0]]))});
}
const parkOf=k=>state.myPark[k]||sharedPark[k]||null;

/* ---------- map ---------- */
function initMap(){
  map=L.map('map',{zoomControl:true,attributionControl:true,maxZoom:19}).setView([40.7448,-74.0355],16);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,maxNativeZoom:18,tileSize:128,zoomOffset:1,
    attribution:'© OpenStreetMap contributors'}).addTo(map);
  map.on('click',()=>{ if(!state.parked) closeSheet(); });
  map.on('zoomend',()=>{ if(layer)layer.eachLayer(l=>l.setStyle&&l.setStyle({weight:hlWeight()})); drawLabels(); drawClosures(); });
  map.on('moveend',drawLabels);
}
function colorFor(p,k){
  if(state.mode==='park'){const t=parkOf(k);return t?PARK[t].col:UNK}
  return p.days.length===5?'#444':DAYCOL[p.days[0]];
}
function visible(p){
  if(state.day==='all')return true;
  const d=state.day==='today'?dayIdx(new Date()):state.day;
  return p.days.includes(d);
}
/* ---------- street-style labels on the lines (zoomed in) ---------- */
let labelItems=[], labelLayer=null, lastPt=null, carPin=null;
const sfx=h=>h<12?'am':'pm', h12=h=>h%12||12;
function compact(s,e){return sfx(s)===sfx(e)?`${h12(s)}–${h12(e)}${sfx(e)}`:`${h12(s)}${sfx(s)}–${h12(e)}${sfx(e)}`}
function lineText(p,k){
  if(state.mode==='park'){const t=parkOf(k);return t?{res:'Residents',res4:'Permit · 4 hr',pay4:'Paid · 4 hr'}[t]:''}
  return (p.days.length===5?'Mon–Fri':DAYSHORT[p.days[0]])+' '+compact(p.start,p.end);
}
function dark(hex){const n=parseInt(hex.slice(1),16);const f=.55;return `rgb(${Math.round((n>>16)*f)},${Math.round(((n>>8)&255)*f)},${Math.round((n&255)*f)})`}
function drawLabels(){
  if(labelLayer){labelLayer.remove();labelLayer=null}
  if(!map||map.getZoom()<17.5)return;
  labelLayer=L.layerGroup().addTo(map); const bounds=map.getBounds().pad(0.2);
  labelItems.forEach(it=>{
    if(!it.txt)return; const a=it.ll[0], b=it.ll[it.ll.length-1];
    if(map.distance(a,b)<28)return;
    const mid=[(a[0]+b[0])/2,(a[1]+b[1])/2]; if(!bounds.contains(mid))return;
    const pa=map.project(a,18), pb=map.project(b,18);
    let ang=Math.atan2(pb.y-pa.y,pb.x-pa.x)*180/Math.PI; if(ang>90)ang-=180; if(ang<-90)ang+=180;
    L.marker(mid,{interactive:false,keyboard:false,icon:L.divIcon({className:'ln',iconSize:[0,0],html:`<span style="transform:translate(-50%,-50%) rotate(${ang}deg);color:${dark(it.col.length===7?it.col:'#444444')}">${it.txt}</span>`})}).addTo(labelLayer);
  });
}
function hlWeight(){const z=map.getZoom();return z<14.5?1.5:z<15.5?2.2:z<16.5?3.6:z<17.5?6:z<18.5?8:11}
function draw(){
  if(layer)layer.remove(); layer=L.layerGroup().addTo(map); labelItems=[];
  Object.entries(keys).forEach(([k,o])=>{
    if(!visible(o.p))return;
    const col=colorFor(o.p,k);
    const txt=lineText(o.p,k);
    o.lines.forEach(ll=>{
      labelItems.push({ll,col,txt});
      const line=L.polyline(ll,{color:col,weight:hlWeight(),opacity:.5,lineCap:'butt',className:'hl'}).addTo(layer);
      line.on('click',e=>{L.DomEvent.stopPropagation(e); lastPt=[e.latlng.lat,e.latlng.lng];
        if(state.mode==='park'&&paint!==null){ if(paint==='clear')delete state.myPark[k]; else state.myPark[k]=paint; store.set('myPark',state.myPark); draw(); }
        else showSide(k)});
    });
  });
  drawLegend(); drawBanner(); drawPaintbar(); drawLabels();
}
function drawPaintbar(){
  const b=$('#paintbar'); b.hidden=state.mode!=='park'; if(b.hidden)return;
  const opts=[...Object.entries(PARK).map(([id,v])=>[id,v.label,v.col]),['clear','Erase','#8d949c'],[null,'Look only','#14222f']];
  b.innerHTML=opts.map(([id,l,c])=>`<button data-p="${id}" class="${paint===id?'on':''}" style="${paint===id?'background:'+c:''}">${l}</button>`).join('')+'<span class="hint">Pick a rule, then tap street sides</span>';
  b.onclick=e=>{const x=e.target.closest('button');if(!x)return;const v=x.dataset.p;paint=v==='null'?null:v;drawPaintbar()};
}
function drawLegend(){
  const el=$('#legend');
  if(state.mode==='park'){
    el.innerHTML=Object.values(PARK).map(v=>`<div><i style="background:${v.col}"></i>${v.label}</div>`).join('')+`<div><i style="background:${UNK}"></i>Not added yet</div>`;
  }else{
    el.innerHTML=DAYNAMES.map((n,i)=>`<div><i style="background:${DAYCOL[i]}"></i>${n}</div>`).join('')+`<div><i style="background:#444"></i>Every weekday</div>`;
  }
  el.innerHTML+=`<button class="lg" id="lgCl" style="opacity:${state.showClosures?1:.45}"><span class="clk"></span>No parking now</button><button class="lg" id="lgCl2" style="opacity:${state.showClosures?1:.45}"><span class="clk soon"></span>No parking soon</button>`;
  $('#lgCl2').onclick=$('#lgCl').onclick=()=>{state.showClosures=!state.showClosures;store.set('showClosures',state.showClosures);drawLegend();drawClosures()};
}
function drawBanner(){
  const b=$('#banner'); const now=new Date(); const h=isHol(now);
  let msg='';
  if(h)msg=`City holiday today (${h}): no street cleaning.`;
  else if(state.day==='today'&&dayIdx(now)>4)msg='No street cleaning on weekends.';
  b.hidden=!msg; b.textContent=msg;
}
function buildChips(){
  const chips=[['today','Today'],...DAYSHORT.map((n,i)=>[i,n]),['all','All']];
  $('#days').innerHTML=chips.map(([v,l])=>`<button class="chip" data-v="${v}">${l}</button>`).join('');
  const paint=()=>document.querySelectorAll('.chip').forEach(c=>{
    const v=c.dataset.v,on=String(state.day)===v;c.classList.toggle('on',on);
    c.style.background=on?(v==='today'||v==='all'?'#14222f':DAYCOL[+v]):'';});
  $('#days').onclick=e=>{const c=e.target.closest('.chip');if(!c)return;const v=c.dataset.v;state.day=(v==='today'||v==='all')?v:+v;paint();draw()};
  paint();
}

/* ---------- schedule logic ---------- */
function nextCleaning(p,from=new Date()){
  for(let i=0;i<21;i++){
    const d=new Date(from.getFullYear(),from.getMonth(),from.getDate()+i);
    const di=dayIdx(d); if(!p.days.includes(di))continue;
    const end=new Date(d);end.setHours(p.end,0,0,0);
    if(end<=from)continue;
    if(isHol(d))continue;
    const start=new Date(d);start.setHours(p.start,0,0,0);
    return {date:d,start,end};
  }
  return null;
}
function nextHolidaySkip(p,from=new Date()){ // a cleaning day that is skipped for a holiday soon
  for(let i=0;i<14;i++){
    const d=new Date(from.getFullYear(),from.getMonth(),from.getDate()+i);
    if(p.days.includes(dayIdx(d))&&isHol(d)){const end=new Date(d);end.setHours(p.end,0,0,0);if(end>from)return {date:d,name:isHol(d)}}
  }
  return null;
}
function alertTimes(n){
  const [h,m]=state.dayOf.split(':').map(Number);
  const a1=new Date(n.date);a1.setHours(h,m,0,0);
  const a2=new Date(n.start.getTime()-state.lead*60000);
  return {a1,a2};
}

/* ---------- sheets ---------- */
function closeSheet(){ $('#sheet').hidden=true; if(hilite){hilite.remove();hilite=null} }
function setSheet(html){ $('#sheetBody').innerHTML=html; $('#sheet').hidden=false; $('#sheet').scrollTop=0 }
function sideLabel(p){return `${p.street}, ${p.side} side`}
function highlight(k){
  if(hilite)hilite.remove(); hilite=L.layerGroup().addTo(map);
  keys[k].lines.forEach(ll=>L.polyline(ll,{color:'#fff',weight:12,opacity:.9}).addTo(hilite).bringToBack());
  keys[k].lines.forEach(ll=>L.polyline(ll,{color:'#14222f',weight:3,opacity:1}).addTo(hilite));
}
const PSIGN={res:['Residents only','Resident permit required.'],res4:['Permit parking','Everyone else: 4 hour limit.'],pay4:['Paid parking','Meter or ParkMobile. 4 hour limit.']};
const PM_URL='https://app.parkmobile.io/search/hoboken-nj-usa';
let pmZones=[];
function zoneFor(k,pt){
  const o=keys[k]; if(!o||!pmZones.length)return null;
  const P=pt?toXY(pt[0],pt[1]):null; let best=null;
  pmZones.forEach(([z,la,lo])=>{ const [x,y]=toXY(la,lo); const d=Math.min(...o.lines.map(l=>distToLine(x,y,l)));
    if(d>14)return; const score=P?Math.hypot(P[0]-x,P[1]-y):d; if(!best||score<best.s)best={z,s:score}; });
  return best&&best.z;
}
function pmPill(k,pt){
  if(parkOf(k)==='res')return '';
  const z=zoneFor(k,pt), ok=z&&/^47\d{3}$/.test(z);
  return `<div class="pmrow"><a class="pmpill" href="${ok?'https://app.parkmobile.io/zone/304'+z:PM_URL}" target="_blank" rel="noopener"><span class="pmdot">P</span>ParkMobile${ok?' · '+z:''} ↗</a></div>`;
}
function parkSection(k,editing,pt){
  const cur=parkOf(k);
  const sign=cur?PSIGN[cur]:['Not added yet','Check the sign on the street.'];
  const chips=Object.entries(PARK).map(([id,v])=>`<button data-t="${id}" class="${cur===id?'on':''}" style="${cur===id?'background:'+v.col:''}">${v.label}</button>`).join('')+`<button data-t="" class="${!cur?'on':''}" style="${!cur?'background:#8d949c':''}">Not sure</button>`;
  return `<div id="parkSec" data-k="${k}">
    <div class="plabel">Parking on this side</div>
    <div class="psign ${cur||'none'}"><span class="pbadge">P</span><span><span class="pt">${sign[0]}</span><span class="ps">${sign[1]}</span></span></div>
    ${editing?`<div class="plabel" style="margin-top:12px">What does the sign say?</div><div class="ptype">${chips}</div>`:'<button class="link" id="wrong">Not what the sign says?</button>'}</div>`;
}
function bindParkSec(){
  const el=$('#parkSec'); if(!el)return; const k=el.dataset.k;
  const w=$('#wrong'); if(w)w.onclick=()=>{el.outerHTML=parkSection(k,true,lastPt);bindParkSec()};
  const pt=el.querySelector('.ptype'); if(pt)pt.onclick=e=>{const b=e.target.closest('button');if(!b)return;const t=b.dataset.t;
    if(t)state.myPark[k]=t; else delete state.myPark[k];
    store.set('myPark',state.myPark); el.outerHTML=parkSection(k,false,lastPt); bindParkSec(); if(state.mode==='park')draw(); toast('Saved on this phone')};
}
function dayColor(p){return p.days.length===5?'#444':DAYCOL[p.days[0]]}
function head(p,tag){return `<div class="shead"><div>${tag?`<span class="tag">${tag}</span>`:''}<div class="big">${p.street}</div><div class="muted">${p.side} side · ${p.location}</div></div><button class="icon" id="closeS" aria-label="Close">✕</button></div>`}
function showSide(k,fromGPS){
  const o=keys[k]; if(!o)return; const p=o.p; highlight(k);
  const skip=nextHolidaySkip(p);
  setSheet(`
    ${head(p)}
    <div class="plabel">Street cleaning</div>
    <div class="clean"><span class="cbar" style="background:${dayColor(p)}"></span><div><div class="cday">${weekdayList(p.days)}</div><div class="ctime">${range(p.start,p.end)}</div></div></div>
    ${skip?`<div class="muted" style="margin-top:6px">No cleaning ${dateLabel(skip.date)} (${skip.name}).</div>`:''}
    ${closureNote(k)}
    ${parkSection(k,false,lastPt)}
    <button class="primary wide" id="parkHere">I’m parked here</button>
    ${pmPill(k,lastPt)}`);
  bindParkSec();
  $('#parkHere').onclick=()=>setParked(k);
  $('#closeS').onclick=closeSheet;
}

/* ---------- parked ---------- */
function snapTo(k,pt){
  const o=keys[k]; let best=null;
  const P=pt?toXY(pt[0],pt[1]):null;
  o.lines.forEach(l=>{ for(let i=0;i<l.length-1;i++){
    const a=toXY(...l[i]),b=toXY(...l[i+1]); const dx=b[0]-a[0],dy=b[1]-a[1],L2=dx*dx+dy*dy||1;
    let t=P?((P[0]-a[0])*dx+(P[1]-a[1])*dy)/L2:.5; t=Math.max(0,Math.min(1,t));
    const q=[a[0]+t*dx,a[1]+t*dy]; const d=P?Math.hypot(P[0]-q[0],P[1]-q[1]):-Math.sqrt(L2);
    if(!best||d<best.d)best={d,ll:[q[1]/KY,q[0]/KX]}; }});
  return best.ll;
}
function focusCar(){
  const pk=state.parked; if(!pk||!pk.ll||!map)return;
  map.setView(pk.ll,Math.max(map.getZoom(),17),{animate:false});
  const sh=$('#sheet'), top=sh.hidden?innerHeight:sh.getBoundingClientRect().top, hb=$('#top').offsetHeight;
  const target=(hb+top)/2, cur=map.getSize().y/2; map.panBy([0,Math.round(cur-target)],{animate:false});
}
function drawCarPin(){
  if(carPin){carPin.remove();carPin=null}
  const pk=state.parked; if(!pk||!keys[pk.k]||!pk.ll||!map)return;
  const svg=`<svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 43C17 43 31 27 31 16A14 14 0 0 0 3 16C3 27 17 43 17 43Z" fill="#14222f" stroke="#fff" stroke-width="2.5"/><g fill="#fff"><path d="M9.5 18.5l2-5.2c.3-.8 1-1.3 1.9-1.3h7.2c.9 0 1.6.5 1.9 1.3l2 5.2v5.2c0 .5-.4.8-.8.8h-1.6c-.5 0-.8-.3-.8-.8v-1h-9.6v1c0 .5-.4.8-.8.8h-1.6c-.5 0-.8-.3-.8-.8z"/></g><g fill="#14222f"><circle cx="12.6" cy="19.6" r="1.4"/><circle cx="21.4" cy="19.6" r="1.4"/><path d="M12.4 14.2l.6-1.4h8l.6 1.4z"/></g></svg>`;
  carPin=L.marker(pk.ll,{icon:L.divIcon({className:'carpin',html:svg,iconSize:[34,44],iconAnchor:[17,43]}),zIndexOffset:900,keyboard:false}).addTo(map);
  carPin.on('click',()=>showParked());
}
function setParked(k){
  state.parked={k,at:Date.now(),ll:snapTo(k,lastPt)}; store.set('parked',state.parked); drawCarPin(); showParked(); focusCar();
}
function showParked(){
  const pk=state.parked; if(!pk||!keys[pk.k]){state.parked=null;store.set('parked',null);return}
  const p=keys[pk.k].p; highlight(pk.k);
  const n=nextCleaning(p);
  let alerts='';
  if(n){const {a1,a2}=alertTimes(n);
    const lines=[]; if(a1<n.start)lines.push(a1);
    if(Math.abs(a2-a1)>60000)lines.push(a2);
    lines.sort((a,b)=>a-b);
    alerts=lines.map(d=>d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})).join(' and ');
  }
  setSheet(`
    ${head(p,'Your car')}
    <div class="plabel">Move by</div>
    ${n?`<div class="clean"><span class="cbar" style="background:${dayColor(p)}"></span><div><div class="cday">${dateLabel(n.date)}</div><div class="ctime">Cleaning ${range(p.start,p.end)}</div></div></div>
    <div class="muted" style="margin-top:6px">${parkOf(pk.k)?PSIGN[parkOf(pk.k)][0]+' · ':''}Reminders:  ${alerts||'none'}${state.weekly?' · repeats weekly':''}</div>`
    :'<div class="clean"><span class="cbar" style="background:#8d949c"></span><div><div class="cday">All clear</div><div class="ctime">No cleaning in the next 3 weeks</div></div></div>'}
    ${closureNote(pk.k)}
    <button class="primary wide" id="ics">Remind me</button>
    <div class="row between" style="margin-top:6px"><button class="link" id="chg">Change spot</button><button class="link" id="moved">I moved my car</button></div>
    ${pmPill(pk.k,pk.ll)}`);
  $('#ics').onclick=()=>openMenu(p,n);
  $('#moved').onclick=()=>{state.parked=null;store.set('parked',null);drawCarPin();closeSheet();toast('Cleared. Delete the calendar event if you added one.')};
  $('#chg').onclick=()=>locate();
  $('#closeS').onclick=closeSheet;
}

/* ---------- remind menu ---------- */
function reminderText(p,n){
  if(!n)return `Street cleaning: ${sideLabel(p)}, ${weekdayList(p.days)} ${range(p.start,p.end)}.`;
  return `Move my car! ${sideLabel(p)}: street cleaning ${dateLabel(n.date)}, ${range(p.start,p.end)}.`;
}
function openMenu(p,n){
  const m=$('#menu'); m.hidden=false;
  const close=()=>m.hidden=true;
  $('#closeMenu').onclick=close; m.onclick=e=>{if(e.target===m)close()};
  $('#optCal').onclick=()=>{close();downloadICS(p)};
  $('#optCopy').onclick=async()=>{close();try{await navigator.clipboard.writeText(reminderText(p,n));toast('Copied')}catch(e){toast('Couldn’t copy')}};
}

/* ---------- ics ---------- */
function icsDate(d){return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`}
function downloadICS(p){
  const n=nextCleaning(p); if(!n){toast('No cleaning in the next 3 weeks');return}
  const {a1,a2}=alertTimes(n);
  const alarms=[];
  const m1=Math.round((n.start-a1)/60000), m2=Math.round((n.start-a2)/60000);
  const alarm=(m,txt)=>`BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:${txt}\r\nTRIGGER:-PT${m}M\r\nEND:VALARM\r\n`;
  const what=`Move your car: ${sideLabel(p)}, cleaning ${range(p.start,p.end)}`;
  if(m1>0)alarms.push(alarm(m1,what));
  if(m2>0&&m2!==m1)alarms.push(alarm(m2,what));
  let rr='',ex='';
  if(state.weekly){
    rr=`RRULE:FREQ=WEEKLY;BYDAY=${p.days.map(i=>['MO','TU','WE','TH','FR'][i]).join(',')}\r\n`;
    const exd=Object.keys(holidays).filter(h=>h>ymd(n.date)).filter(h=>{const [y,m,d]=h.split('-').map(Number);return p.days.includes(dayIdx(new Date(y,m-1,d)))});
    if(exd.length)ex=`EXDATE:${exd.map(h=>h.replace(/-/g,'')+'T'+pad(p.start)+'0000').join(',')}\r\n`;
  }
  const uid=`${Date.now()}@hoboken-sweep`;
  const ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Hoboken Sweep//EN','CALSCALE:GREGORIAN','BEGIN:VEVENT',
    `UID:${uid}`,`DTSTAMP:${icsDate(new Date())}`,`DTSTART:${icsDate(n.start)}`,`DTEND:${icsDate(n.end)}`,
    `SUMMARY:Street cleaning: move car (${p.street} ${p.side})`,`DESCRIPTION:${what}. City holidays are skipped; weather suspensions come through Nixle.`,
    ].join('\r\n')+'\r\n'+rr+ex+alarms.join('')+'END:VEVENT\r\nEND:VCALENDAR\r\n';
  const blob=new Blob([ics],{type:'text/calendar'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='street-cleaning.ics'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),10000);
  return ics;
}

/* ---------- locate ---------- */
const KX=111320*Math.cos(40.744*Math.PI/180),KY=110540;
function toXY(lat,lon){return [lon*KX,lat*KY]}
function distToLine(px,py,ll){
  let best=1e9;
  for(let i=0;i<ll.length-1;i++){
    const [ax,ay]=toXY(...ll[i]),[bx,by]=toXY(...ll[i+1]);
    const dx=bx-ax,dy=by-ay,L2=dx*dx+dy*dy; let t=L2?((px-ax)*dx+(py-ay)*dy)/L2:0; t=Math.max(0,Math.min(1,t));
    best=Math.min(best,Math.hypot(px-(ax+t*dx),py-(ay+t*dy)));
  }
  return best;
}
function nearest(lat,lon){
  const [px,py]=toXY(lat,lon);
  const res=Object.entries(keys).map(([k,o])=>({k,p:o.p,d:Math.min(...o.lines.map(l=>distToLine(px,py,l)))}));
  res.sort((a,b)=>a.d-b.d);
  if(!res.length||res[0].d>80)return [];
  const top=res[0]; const out=[top];
  res.slice(1).forEach(r=>{ if(out.length<4&&r.d<top.d+25&&r.d<80)out.push(r)});
  return out;
}
function locate(){
  if(!navigator.geolocation){toast('Location isn’t available here. Tap a street on the map instead.');return}
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(pos=>{
    const {latitude:lat,longitude:lon,accuracy}=pos.coords;
    map.setView([lat,lon],18);
    showMe(lat,lon,accuracy,false); lastPt=[lat,lon];
    showCandidates(nearest(lat,lon),accuracy);
  },()=>toast('Couldn’t get your location. Tap your street on the map instead.'),{enableHighAccuracy:true,timeout:15000,maximumAge:10000});
}
function showCandidates(list,acc){
  if(!list.length){setSheet(`<div class="big">No sweeping street nearby</div><p class="muted">Tap a street side on the map to check it.</p><div class="btns"><button class="ghost" id="closeS">Close</button></div>`);$('#closeS').onclick=closeSheet;return}
  setSheet(`<div class="big">Which side are you on?</div><div class="muted">${acc>25?'Location is rough here, so double-check. ':''}Tap your side of the street.</div>
    ${list.map(r=>`<button class="card pick" data-k="${r.k}"><b>${sideLabel(r.p)}</b><div class="muted">${weekdayList(r.p.days)}, ${range(r.p.start,r.p.end)} · about ${Math.round(r.d)} m away</div></button>`).join('')}
    <div class="btns"><button class="ghost" id="closeS">Cancel</button></div>`);
  document.querySelectorAll('.pick').forEach(b=>{b.onclick=()=>setParked(b.dataset.k);b.onmouseenter=()=>highlight(b.dataset.k)});
  highlight(list[0].k); $('#closeS').onclick=closeSheet;
}

/* ---------- live location dot ---------- */
let watchId=null, meAcc=null, first=true;
function showMe(lat,lon,acc,center){
  if(meMarker)meMarker.remove(); if(meAcc)meAcc.remove();
  meAcc=L.circle([lat,lon],{radius:acc,color:'#2a6fdb',weight:1,fillOpacity:.08,interactive:false}).addTo(map);
  meMarker=L.marker([lat,lon],{icon:L.divIcon({className:'',html:'<div class="me"></div>',iconSize:[20,20],iconAnchor:[10,10]}),interactive:false,keyboard:false}).addTo(map);
  if(center)map.setView([lat,lon],Math.max(map.getZoom(),17));
}
function toggleMe(){
  const b=$('#meBtn');
  if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;b.classList.remove('on');if(meMarker){meMarker.remove();meAcc.remove();meMarker=meAcc=null}return}
  if(!navigator.geolocation){toast('Location isn’t available here');return}
  first=true; b.classList.add('on');
  watchId=navigator.geolocation.watchPosition(p=>{showMe(p.coords.latitude,p.coords.longitude,p.coords.accuracy,first);first=false},
    ()=>{toast('Couldn’t get your location. Check Location is allowed for this site.');navigator.geolocation.clearWatch(watchId);watchId=null;b.classList.remove('on')},
    {enableHighAccuracy:true,maximumAge:5000,timeout:20000});
}

/* ---------- settings, sharing, custom data ---------- */
function toast(m){const t=$('#toast');t.textContent=m;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,3200)}
function initSettings(){
  $('#setDayOf').value=state.dayOf; $('#setLead').value=String(state.lead); $('#setWeekly').checked=state.weekly;
  $('#settingsBtn').onclick=()=>$('#settings').hidden=false;
  $('#closeSettings').onclick=()=>{$('#settings').hidden=true; if(state.parked)showParked()};
  $('#settings').onclick=e=>{if(e.target.id==='settings')$('#closeSettings').click()};
  $('#setDayOf').onchange=e=>{state.dayOf=e.target.value;store.set('dayOf',state.dayOf)};
  $('#setLead').onchange=e=>{state.lead=+e.target.value;store.set('lead',state.lead)};
  $('#setWeekly').onchange=e=>{state.weekly=e.target.checked;store.set('weekly',state.weekly)};
  $('#fileIn').onchange=async e=>{
    try{const j=JSON.parse(await e.target.files[0].text()); if(!j.features)throw 0; store.set('customGeo',j); geo=j; buildIndex(); draw(); toast('Loaded your schedule file')}
    catch(err){toast('That file isn’t a schedule.json I can read')}
  };
  $('#resetData').onclick=()=>{store.set('customGeo',null);load();toast('Using the built-in schedule')};
  $('#shareParking').onclick=async()=>{
    const data=btoa(unescape(encodeURIComponent(JSON.stringify({v:2,p:state.myPark,z:state.zones}))));
    const url=location.origin+location.pathname+'#p='+data;
    try{ if(navigator.share)await navigator.share({title:'Hoboken Sweep parking notes',url}); else {await navigator.clipboard.writeText(url);toast('Link copied')} }catch(e){}
  };
  $('#clearParking').onclick=()=>{state.myPark={};store.set('myPark',{});draw();$('#parkMsg').textContent='Cleared.'};
  document.querySelectorAll('#mode button').forEach(b=>b.onclick=()=>{
    state.mode=b.dataset.mode; document.querySelectorAll('#mode button').forEach(x=>x.classList.toggle('on',x===b)); draw();
  });
  $('#locateBtn').onclick=locate; $('#meBtn').onclick=toggleMe;
}
function importFromHash(){
  const m=location.hash.match(/#p=(.+)$/); if(!m)return;
  try{
    const j=JSON.parse(decodeURIComponent(escape(atob(m[1]))));
    const pj=j.v===2?(j.p||{}):j, zj=j.v===2?(j.z||{}):{};
    const n=Object.keys(pj).length+Object.keys(zj).length;
    if(n&&confirm(`Add ${n} parking notes from this link?`)){Object.assign(state.myPark,pj);Object.assign(state.zones,zj);store.set('myPark',state.myPark);store.set('zones',state.zones);toast('Parking notes added')}
  }catch(e){}
  history.replaceState(null,'',location.pathname);
}

/* ---------- live temporary no-parking signs (City of Hoboken Parking Utility) ---------- */
const HPU='https://api-hpuvp.hobokennj.gov/api/v1/parking';
let closures=store.get('closures',[]), closureLayer=null;
function parseDT(d,t){const [m,da,y]=d.split('/').map(Number);const [h,mi]=t.split(':').map(Number);return new Date(y,m-1,da,h,mi)}
function cleanAddr(a){
  const m=a.match(/^0*(\d+)-0*(\d+)\s+(.*)$/); if(!m)return a;
  const street=m[3].toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()).replace(/\b(\d+)(St|Nd|Rd|Th)\b/g,(x,n,s2)=>n+s2.toLowerCase());
  return (m[1]===m[2]?m[1]:m[1]+'–'+m[2])+' '+street;
}
function fmtWhen(d){return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+', '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}).replace(':00','').toLowerCase().replace(' ','')}
const REASON={CONSTRUCTION:'Construction',EVENT:'Event',MOVING:'Moving truck',DELIVERY:'Delivery',FILMSHOOT:'Film shoot'};
async function fetchClosures(){
  try{
    const [a,b]=await Promise.all([fetch(HPU,{cache:'no-store'}).then(r=>r.json()),fetch(HPU+'/future',{cache:'no-store'}).then(r=>r.json())]);
    const seen=new Set(), out=[];
    [...(a.data||[]),...(b.data||[])].forEach(x=>{ if(seen.has(x.id))return; seen.add(x.id);
      out.push({id:x.id,addr:cleanAddr(x.address),reason:REASON[x.reason]||x.reason,lat:x.latitude,lon:x.longitude,s:parseDT(x.start_date,x.start_time).getTime(),e:parseDT(x.stop_date,x.end_time).getTime()}) });
    closures=out; store.set('closures',out);
  }catch(err){ /* offline or blocked: keep the last copy */ }
  drawClosures();
}
function closureState(c,now=Date.now()){ if(c.e-c.s>14*864e5)return null; if(c.e<=now)return null; if(c.s<=now)return 'now'; if(c.s-now<=3*864e5)return 'soon'; return null }
function drawClosures(){
  if(!map)return; if(closureLayer){closureLayer.remove();closureLayer=null}
  if(!state.showClosures)return; const z=map.getZoom(), small=z<16;
  closureLayer=L.layerGroup().addTo(map);
  const groups={};
  closures.forEach(c=>{const st=closureState(c); if(!st||!c.lat)return; if(st==='soon'&&z<17)return; const gl=small?0.0016:0.0005, gn=small?0.002:0.0006; const k=Math.round(c.lat/gl)+','+Math.round(c.lon/gn); (groups[k]=groups[k]||[]).push({...c,st})});
  Object.values(groups).forEach(g=>{
    const now=g.some(c=>c.st==='now'); const c0=g[0];
    const html=g.map(c=>`<div class="cp"><b>${c.addr}</b><br>${c.reason} · ${c.st==='now'?'until '+fmtWhen(new Date(c.e)):'starts '+fmtWhen(new Date(c.s))}</div>`).join('');
    L.marker([c0.lat,c0.lon],{icon:L.divIcon({className:'',iconSize:small?[10,10]:[18,18],iconAnchor:small?[5,5]:[9,9],html:`<div class="cl ${now?'':'soon'} ${small?'dotsm':''}">${g.length>1&&!small?'<i>'+g.length+'</i>':''}</div>`}),zIndexOffset:500}).bindPopup(`<div class="cph">No parking${now?'':' soon'}</div>${html}<div class="cpn">From the City of Hoboken. Check the posted sign.</div>`).addTo(closureLayer);
  });
}
function closuresNear(k,meters=60){
  const o=keys[k]; if(!o)return []; const out=[];
  closures.forEach(c=>{const st=closureState(c); if(!st||!c.lat)return; const [px,py]=toXY(c.lat,c.lon); if(Math.min(...o.lines.map(l=>distToLine(px,py,l)))<=meters)out.push({...c,st})});
  return out;
}
function closureNote(k){
  const l=closuresNear(k); if(!l.length)return '';
  return `<div class="warn"><b>Temporary no parking nearby</b>${l.slice(0,3).map(c=>`<div>${c.addr}: ${c.reason}, ${c.st==='now'?'until '+fmtWhen(new Date(c.e)):'starts '+fmtWhen(new Date(c.s))}</div>`).join('')}</div>`;
}

/* ---------- start ---------- */
window.addEventListener('DOMContentLoaded',async()=>{
  initMap(); buildChips(); initSettings(); await load(); drawClosures(); fetchClosures(); setInterval(fetchClosures,5*60*1000); document.addEventListener('visibilitychange',()=>{if(!document.hidden)fetchClosures()});
  if(state.parked){drawCarPin();showParked();focusCar();}
  if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
});
window.__test={get state(){return state},keys:()=>keys,nextCleaning,downloadICS,nearest,setParked};
