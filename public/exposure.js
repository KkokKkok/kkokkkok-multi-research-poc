// Exposure score viewer: one person (photo folder) at a time. Data: /api/exposure
// (private-data/exposure/*.json, scripts/score-exposure.mjs). The map shows the estimated registered
// place with the distance bands of w, and each group coloured by its L.
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const UNIT={1:['지점 하나','u1','#c62828'],0.6:['몇 곳','u06','#b26a00'],0.2:['도시·구','u02','#6b7280'],0:['단서 없음','u0','#c9ccd1']};
const unitOf=L=>UNIT[L]??UNIT[0];
const pill=L=>`<span class="u ${unitOf(L)[1]}">${unitOf(L)[0]}</span>`;
const UK={point:'지점 하나',few:'몇 곳',city:'도시·구',country:'국가'};
const GRADE={high:'높음',caution:'주의',low:'낮음'};
const gradeOf=S=>S>=70?'high':S>=40?'caution':'low';
const BANDS=[[500,'500m'],[1000,'1km'],[3000,'3km']];

const map=L.map('map');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
const layer=L.layerGroup().addTo(map);
const peopleElement=document.getElementById('people'),personElement=document.getElementById('person');
let people=[],current=null,selected=null,markers=new Map();

// The virtual attacker (lib/attacker.mjs): where the places given away lead without the registered
// place, in three states. The row of the state on screen is marked.
const VERDICT_CLASS={found:'grade-high',near:'grade-caution',area:'grade-low',none:'grade-low'};
const metresKo=value=>value===null?'—':value>=1000?`${Math.round(value/100)/10}km`:`${value}m`;
function attackerSection(person){
  const seen=person.attacker;
  if(!seen)return '';
  const states=[['all','원래 사진',seen.original],['noHigh','높음 단서가 없을 때',seen.noHigh],['edited','한 장씩 편집한 뒤',seen.edited]];
  const now=mode==='all'?seen.original:seen.noHigh,names=new Map(person.groups.map(group=>[group.id,group.name]));
  return `<h2>가상 공격자 <span class="small muted">— 등록 장소를 모르는 채, 드러난 장소만으로 거꾸로 찾기</span></h2>
    <div class="note ${now.verdict.key==='found'||now.verdict.key==='near'?'attack':'calm'}"><b class="${VERDICT_CLASS[now.verdict.key]}">${now.verdict.ko}</b> · ${now.lines.map(escapeHtml).join(' ')}</div>
    <table class="attack" style="margin-top:8px">
      <tr><th>상태</th><th>판정</th><th>뒤져야 하는 범위</th><th>근거 (등록 장소 / 최고)</th><th>가장 가까운 후보</th></tr>
      ${states.map(([key,label,state])=>`<tr class="${key===mode?'on':''}"><td>${label}</td><td><b class="${VERDICT_CLASS[state.verdict.key]}">${state.verdict.ko}</b></td>
        <td>${state.searchRadiusM===null?'<span class="muted">닿지 못함</span>':`반경 ${metresKo(state.searchRadiusM)} <span class="muted">(${state.searchAreaKm2}km²)</span>`}</td>
        <td>${state.support} / ${state.peak}</td>
        <td>${state.candidate?`${state.candidate.rank}순위 · ${metresKo(state.candidate.distanceM)}`:'<span class="muted">후보 없음</span>'}</td></tr>`).join('')}
    </table>
    ${seen.influence.length?`<p class="small" style="margin:8px 0 0">가리면 범위가 가장 넓어지는 곳: ${seen.influence.slice(0,3).map(item=>`<b>${escapeHtml(item.groupId)}</b> ${escapeHtml(names.get(item.groupId)??'')} <span class="muted">(→ ${item.searchRadiusM===null?'닿지 못함':`반경 ${metresKo(item.searchRadiusM)}`})</span>`).join(', ')}</p>`:''}
    <p class="small muted" style="margin:6px 0 0">드러난 장소마다 "이 근처에 거점이 있다"는 근거를 주변에 깔고(지점 하나는 그 자리, 몇 곳은 500m, 도시·구는 2.5km 흐리게), 근거가 높은 곳부터 뒤질 때 등록 장소에 닿기까지의 넓이입니다. 좁을수록 위험해요. 지도의 초록 원이 공격자의 후보입니다.${person.place.source==='folder-estimate'?' 지금은 등록 장소도 같은 사진으로 추정한 것이라 실제보다 잘 맞게 나옵니다.':''}</p>`;
}

// The score after each protective edit, as a small line chart. A triangle marks a step that comes
// with a warning: covering the photos' own clues is not enough once the photos are read together.
function editChart(person){
  const points=[person.S,...person.edits.map(edit=>edit.SAfter)],warned=[false,...person.edits.map(edit=>Boolean(edit.warning||edit.crossNeeded))];
  const width=600,height=170,left=34,right=12,top=12,bottom=26,x=index=>left+(points.length===1?0:index*(width-left-right)/(points.length-1)),y=S=>top+(100-S)*(height-top-bottom)/100;
  const grid=[0,40,70,100].map(S=>`<line x1="${left}" x2="${width-right}" y1="${y(S)}" y2="${y(S)}" stroke="${S===40||S===70?'#e3c9a8':'#eceef1'}" ${S===40||S===70?'stroke-dasharray="3 3"':''}/><text x="${left-6}" y="${y(S)+4}" font-size="11" text-anchor="end" fill="#6b7280">${S}</text>`).join('');
  const line=`<polyline fill="none" stroke="#5b4fc7" stroke-width="2" points="${points.map((S,index)=>`${x(index)},${y(S)}`).join(' ')}"/>`;
  const dots=points.map((S,index)=>warned[index]
    ?`<path d="M${x(index)} ${y(S)-7} L${x(index)+7} ${y(S)+5} L${x(index)-7} ${y(S)+5}Z" fill="#c2410c"><title>${index}단계: 점수 ${S} · 사진 간 조합 경고</title></path>`
    :`<circle cx="${x(index)}" cy="${y(S)}" r="3.5" fill="#5b4fc7"><title>${index?`${index}단계`:'원본'}: 점수 ${S}</title></circle>`).join('');
  const labels=points.map((_,index)=>`<text x="${x(index)}" y="${height-8}" font-size="11" text-anchor="middle" fill="#6b7280">${index?index:'원본'}</text>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="보호 편집 단계별 점수">${grid}${line}${dots}${labels}<text x="${width-right}" y="${y(70)-4}" font-size="11" text-anchor="end" fill="#b26a00">높음 70</text><text x="${width-right}" y="${y(40)-4}" font-size="11" text-anchor="end" fill="#b26a00">주의 40</text></svg>`;
}

// What is shown: the photos as they are, or once every clue that is high alone is gone (noHigh).
let mode='all';
const view=person=>{
  if(mode==='all')return {S:person.S,grade:person.grade.key,A:person.A,B:person.B,m:person.m,sentences:person.sentences,edits:person.edits,
    groups:person.groups.map(group=>({...group,Lnow:group.L,LCrossNow:group.LCross,decidingNow:group.deciding}))};
  const bare=person.noHigh,byId=new Map(bare.groups.map(group=>[group.id,group]));
  return {S:bare.S,grade:bare.grade,A:bare.A,B:bare.B,m:bare.m,sentences:bare.sentences,edits:bare.edits,cross:bare.cross,removed:bare.removed,
    groups:person.groups.map(group=>{const now=byId.get(group.id);return {...group,k:now.k,a:now.a,share:now.share,Lnow:now.L,LCrossNow:now.LCross,decidingNow:now.deciding};})};
};

function showPerson(person){
  current=person;selected=null;
  peopleElement.querySelectorAll('button').forEach(button=>button.classList.toggle('on',button.dataset.person===person.person));
  const now=view(person),residual=person.residual,card=(cls,label,value,sub)=>`<div class="card ${cls}"><span>${label}</span><b>${value}</b><span>${sub}</span></div>`;
  const reopened=mode==='all'
    ?(residual.reopened.length
      ?residual.reopened.map(group=>`<div class="note"><b>${escapeHtml(group.groupId)} ${escapeHtml(group.name)}</b>: 사진 한 장씩 보고 편집하면 ${unitOf(group.ownL)[0]}까지 내려가지만, ${group.by.map(item=>`사진 ${item.photos.join('·')}을(를) 함께 보면 ${escapeHtml(item.label)}`).join(', ')}(으)로 다시 ${unitOf(group.L)[0]}가 돼요.</div>`).join('')
      :`<div class="note calm">사진 한 장씩 보고 편집한 뒤, 사진 간 조합으로 다시 드러나는 그룹은 없어요.</div>`)
    :(()=>{
      const still=now.groups.filter(group=>group.Lnow>=1),fell=now.groups.filter(group=>group.L>group.Lnow);
      return `<div class="note calm">혼자서 지점 하나인 단서 ${now.removed}개를 모두 뺐어요. ${fell.length}개 그룹은 내려갔고, ${still.length}개 그룹은 여전히 지점 하나예요. 남은 그룹은 대부분 <b>한 사진 안의 중간·낮음 단서 조합</b>(체인 이름 여러 개, 일부만 읽힌 글자 + 건물 외관 등)으로 지점 하나가 돼요.${now.cross.S>now.S?` 사진을 합쳐 보면 ${now.cross.S}점으로 올라가요.`:' 사진 간 조합을 더해도 점수는 그대로예요.'}</div>`;
    })();
  const stuck=residual.left.filter(group=>!residual.reopened.some(item=>item.groupId===group.groupId));
  const groups=now.groups.filter(group=>group.L>0||group.w>0);
  personElement.innerHTML=`
    <div id="modes" style="display:flex;gap:6px;margin:10px 0 0">
      <button data-mode="all" class="${mode==='all'?'on':''}">원래 사진</button>
      <button data-mode="noHigh" class="${mode==='noHigh'?'on':''}">높음 단서가 없을 때</button>
    </div>
    <div class="cards">
      ${card('rule',mode==='all'?'점수 S':'점수 S (높음 없음)',`<span class="grade-${now.grade}">${now.S}</span>`,GRADE[now.grade])}
      ${card('rule','반복 A',now.A.toFixed(2),'같은 곳 여러 날')}
      ${card('rule','생활권 B',now.B.toFixed(2),`m = ${now.m}`)}
      ${mode==='all'
        ?card('','한 장씩 편집 뒤',`<span class="grade-${residual.grade}">${residual.S}</span>`,`${residual.steps}단계 적용`)+card('cross','사진 합쳐 보면',`<span class="grade-${residual.gradeCross}">${residual.SCross}</span>`,residual.SCross>residual.S?`+${residual.SCross-residual.S} 다시 오름`:'변화 없음')
        :card('','원래 사진',`<span class="grade-${person.grade.key}">${person.S}</span>`,now.S<person.S?`−${person.S-now.S}`:'변화 없음')+card('cross','사진 합쳐 보면',`<span class="grade-${now.cross.grade}">${now.cross.S}</span>`,now.cross.S>now.S?`+${now.cross.S-now.S} 다시 오름`:'변화 없음')}
    </div>
    ${reopened}
    ${mode==='all'&&stuck.length?`<p class="small muted" style="margin-top:8px">편집 뒤에도 남는 곳 ${stuck.length}곳: ${stuck.map(group=>`${escapeHtml(group.groupId)}(${unitOf(group.L)[0]}${group.uncoverable?', 가릴 수 없는 단서':''})`).join(', ')}</p>`:''}

    ${attackerSection(person)}

    <h2>근거 문장</h2>
    <ul class="sent">${now.sentences.map(line=>`<li>${escapeHtml(line.text)}</li>`).join('')}</ul>

    <h2>그룹(장소)별 <span class="small muted">— 줄을 누르면 사진과 지도 위치가 나와요</span></h2>
    <table>
      <tr><th>그룹</th><th>사진</th>${mode==='all'?'<th>L</th>':'<th>원래 L</th><th>높음 없음</th><th>합치면</th>'}<th>k (날)</th><th>거리</th><th>L·R·w</th><th>L·w</th><th>사진 간 조합 (기존 분석)</th></tr>
      ${groups.map(group=>`<tr class="group" data-group="${escapeHtml(group.id)}">
        <td><span class="muted">${escapeHtml(group.id)}</span> ${escapeHtml(group.name)}</td><td>${group.photos}</td>${mode==='all'?`<td>${pill(group.L)}</td>`:`<td>${pill(group.L)}</td><td>${pill(group.Lnow)}</td><td>${group.LCrossNow>group.Lnow?pill(group.LCrossNow):'<span class="muted">=</span>'}</td>`}<td>${group.k}</td>
        <td>${group.band??'<span class="muted">3km 밖</span>'}</td><td>${group.a}</td><td>${group.share}</td>
        <td>${group.cross.length?group.cross.map(item=>`<span class="chip ${item.unitSource==='map'?'map':''}" title="${escapeHtml(item.members.join(' + '))} · ${escapeHtml(item.reason??'')}">${escapeHtml(item.type)} ${UK[item.unit]}${item.unitSource==='map'?' · 지도':''}${item.capped?` <s>${UK[item.unitByModel]}</s>`:''}</span>`).join(''):'<span class="muted">—</span>'}</td></tr>
        <tr class="detail" data-detail="${escapeHtml(group.id)}" hidden><td colspan="${mode==='all'?8:10}">
          <div class="small"><b>결정 단서${mode==='all'?'':' (높음 단서 뺀 뒤)'}</b>: ${group.decidingNow.length?group.decidingNow.slice(0,4).map(escapeHtml).join(' / '):'없음'}${group.decidingNow.length>4?` 외 ${group.decidingNow.length-4}개`:''}</div>
          <div class="photos">${group.photoList.map(photo=>`<figure><img loading="lazy" src="/photo/${photo.runId}" alt="사진 ${photo.index}"><figcaption>사진 ${photo.index} · ${photo.day??''} · ${unitOf(photo.s)[0]}</figcaption></figure>`).join('')}</div>
        </td></tr>`).join('')}
    </table>
    <p class="small muted">실선 칩은 지도에서 개수를 센 조합, 점선 칩은 모델 판정만 있는 조합입니다. 규칙표 유형 밖(other) 조합은 검증 전까지 한 단계만 좁히고 지점 하나로는 세지 않아요(줄 그은 값이 모델 판정). 사진 간 조합은 점수에 넣지 않고 아래 편집 경고에만 씁니다.</p>

    <h2>보호 편집 제안 <span class="small muted">— ${mode==='all'?'':'높음 단서를 뺀 상태에서 '}점수가 가장 많이 내려가는 순서</span></h2>
    ${editChart(now)}
    <ol class="edits">${now.edits.map(edit=>{
      const [main,...rest]=edit.text.split(/(?= 다만 | 사진마다 보이는 단서만)/);
      return `<li>${escapeHtml(main)}${rest.length?`<span class="warn">▲ ${escapeHtml(rest.join('').trim())}</span>`:''}</li>`;
    }).join('')}</ol>
    ${now.edits.length?'':'<p class="muted">점수를 낮추는 편집이 없어요.</p>'}
    <p class="small muted">제외: 위치 단서 없는 사진 ${person.excluded.noClue}장, 위치 정보 없는 사진 ${person.excluded.noGps}장. 등록 장소는 ${person.place.source==='folder-estimate'?'폴더 사진으로 임시 추정한 위치':'데이터베이스'}입니다.</p>`;
  personElement.querySelectorAll('tr.group').forEach(row=>row.addEventListener('click',()=>selectGroup(row.dataset.group,true)));
  personElement.querySelectorAll('#modes button').forEach(button=>button.addEventListener('click',()=>{mode=button.dataset.mode;showPerson(person);}));
  drawMap(person,now);
}

function drawMap(person,now){
  layer.clearLayers();markers=new Map();
  const place=[person.place.lat,person.place.lon],points=[place];
  for(const [radius,label] of BANDS)L.circle(place,{radius,color:'#5b4fc7',weight:1,dashArray:'4 4',fill:false}).addTo(layer).bindTooltip(`등록 장소에서 ${label} (w ${radius===500?1:radius===1000?0.8:0.5})`,{sticky:true});
  L.circleMarker(place,{radius:9,color:'#fff',weight:2,fillColor:'#5b4fc7',fillOpacity:1}).addTo(layer).bindTooltip(`등록 장소: ${person.place.name} (${person.place.source==='folder-estimate'?'임시 추정':'DB'})`,{permanent:false});
  for(const group of now.groups){
    if(!group.centre)continue;
    const reopened=mode==='all'?person.residual.reopened.some(item=>item.groupId===group.id):group.LCrossNow>group.Lnow;
    const marker=L.circleMarker([group.centre.lat,group.centre.lon],{radius:5+Math.min(group.photos,9),color:reopened?'#c2410c':'#fff',weight:reopened?3:1.5,fillColor:unitOf(group.Lnow)[2],fillOpacity:0.85}).addTo(layer)
      .bindTooltip(`${group.id} ${group.name} · ${unitOf(group.Lnow)[0]} · ${group.k}일${reopened?' · 사진 합치면 다시 드러남':''}`);
    marker.on('click',()=>selectGroup(group.id,false));
    markers.set(group.id,marker);points.push([group.centre.lat,group.centre.lon]);
  }
  // The attacker's candidates in the state on screen: the best supported region, as a circle of its area.
  const seen=person.attacker&&(mode==='all'?person.attacker.original:person.attacker.noHigh);
  for(const candidate of seen?.candidates??[]){
    const tip=`공격자 후보 ${candidate.rank}순위 · 근거 ${candidate.support}${candidate.nearest?` · 등록 장소에서 ${metresKo(candidate.nearest.distanceM)}`:''}${candidate.unregistered?' · 등록하지 않은 거점':''}`;
    L.circle([candidate.lat,candidate.lon],{radius:Math.max(candidate.radiusM,40),color:'#0f766e',weight:2,dashArray:'6 4',fillColor:'#0f766e',fillOpacity:0.12}).addTo(layer).bindTooltip(tip,{sticky:true});
    L.circleMarker([candidate.lat,candidate.lon],{radius:4,color:'#fff',weight:1.5,fillColor:'#0f766e',fillOpacity:1}).addTo(layer).bindTooltip(tip);
    points.push([candidate.lat,candidate.lon]);
  }
  map.fitBounds(points,{padding:[40,40],maxZoom:16});
}

function selectGroup(id,fromTable){
  selected=selected===id&&fromTable?null:id;
  personElement.querySelectorAll('tr.group').forEach(row=>row.classList.toggle('on',row.dataset.group===selected));
  personElement.querySelectorAll('tr.detail').forEach(row=>{row.hidden=row.dataset.detail!==selected;});
  const marker=markers.get(selected);
  if(marker){map.panTo(marker.getLatLng());marker.openTooltip();}
  if(!fromTable&&selected)personElement.querySelector(`tr.group[data-group="${CSS.escape(selected)}"]`)?.scrollIntoView({block:'center',behavior:'smooth'});
}

fetch('/api/exposure').then(response=>response.json()).then(results=>{
  people=results.sort((a,b)=>a.person.localeCompare(b.person,'ko'));
  if(!people.length){personElement.innerHTML='<p class="muted">점수가 아직 없어요. <code>npm run places</code>, <code>npm run score</code>를 먼저 실행하세요.</p>';return;}
  document.getElementById('source').textContent=`사람 ${people.length}명 · 등록 장소: ${people[0].place.source==='folder-estimate'?'폴더 사진으로 임시 추정':'데이터베이스'}`;
  peopleElement.innerHTML=people.map(person=>`<button data-person="${escapeHtml(person.person)}">${escapeHtml(person.person)} <span class="grade-${person.grade.key}">${person.S}</span></button>`).join('');
  peopleElement.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>showPerson(people.find(person=>person.person===button.dataset.person))));
  const start=new URLSearchParams(location.search).get('person');
  showPerson(people.find(person=>person.person===start)??people.find(person=>person.residual.reopened.length)??people[0]);
});
