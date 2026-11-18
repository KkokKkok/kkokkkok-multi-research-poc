// Zone map: the 100m GPS zones as circles, each photo as a dot. Click a zone or a dot to see the
// photos and their clues. Data comes from /api/zones (private-data/zones.json, this machine only).
const COLORS=['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#008080','#f032e6','#9a6324','#800000','#808000','#000075','#469990','#aa6e28','#dc7633','#5d6d7e','#1e8449'];
const RISK={high:'높음',medium:'중간',low:'낮음'};
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const riskCell=clue=>clue.risk?`<td class="risk ${clue.risk}">${RISK[clue.risk]}</td>`:`<td class="risk none">${clue.tier?clue.tier+'등급':'-'}</td>`;
function counts(photos){
  const clues=photos.flatMap(photo=>photo.clues),of=risk=>clues.filter(clue=>clue.risk===risk).length;
  return {clues:clues.length,high:of('high'),medium:of('medium'),low:of('low'),judged:photos.filter(photo=>photo.judged).length};
}

const map=L.map('map');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
const zonesElement=document.getElementById('zones'),detailElement=document.getElementById('detail');
const markers=new Map();
let opened=false;

// The places a map search found for a combination: the real zone in red, the others in purple.
const candidateLayer=L.layerGroup().addTo(map);
const HERE='#c62828',ELSEWHERE='#6d28d9';
const getJson=path=>fetch(path).then(response=>response.json());
const candidateHtml=(combo,candidate)=>`<b>${candidate.isTrue?'이 구역 (실제 촬영 장소)':'같은 패턴이 있는 다른 곳'}</b><br>${candidate.places.map(place=>`${escapeHtml(place.name)}${place.near.map(near=>`<br>└ ${escapeHtml(near.name)} · ${near.distanceM}m`).join('')}`).join('<br>')}`;
function drawCandidates(target,check,withParts=false){
  const points=[];
  for(const combo of check?.combinations||[])for(const candidate of combo.candidates){
    const color=candidate.isTrue?HERE:ELSEWHERE;
    L.circle([candidate.lat,candidate.lon],{radius:check.toleranceM,color,weight:candidate.isTrue?3:2,fillOpacity:0.15}).addTo(target).bindPopup(candidateHtml(combo,candidate));
    L.circleMarker([candidate.lat,candidate.lon],{radius:candidate.isTrue?8:6,color:'#fff',weight:2,fillColor:color,fillOpacity:1}).addTo(target).bindPopup(candidateHtml(combo,candidate)).bindTooltip(candidate.places.map(place=>place.name).join(', '));
    if(withParts)for(const place of candidate.places)for(const near of place.near)L.circleMarker([near.lat,near.lon],{radius:3,color,weight:1,fillColor:'#fff',fillOpacity:1}).addTo(target).bindTooltip(near.name);
    points.push([candidate.lat,candidate.lon]);
  }
  return points;
}
function showList(){detailElement.hidden=true;zonesElement.hidden=false;candidateLayer.clearLayers();}
function showZone(zone,runId=null){
  const total=counts(zone.photos),color=COLORS[zone.number%COLORS.length];
  opened=true;
  zonesElement.hidden=true;detailElement.hidden=false;
  detailElement.innerHTML=`<button class="back">← 구역 목록</button>
    <h2><span class="dot" style="display:inline-block;background:${color}"></span> ${zone.id} · ${escapeHtml(zone.folder)}</h2>
    <p class="counts">사진 ${zone.photos.length}장 · 가장 먼 두 장 ${zone.maxPairM}m · 단서 ${total.clues}개<br>높음 ${total.high} / 중간 ${total.medium} / 낮음 ${total.low} (규칙 판정된 사진 ${total.judged}/${zone.photos.length})</p>
    <div id="analysis"></div>
    <div class="photos">${zone.photos.map(photo=>`<button data-run="${photo.runId}"><img loading="lazy" src="/photo/${photo.runId}" alt=""><small>${photo.index}번</small></button>`).join('')}</div>
    <div id="photo"></div>`;
  detailElement.querySelector('.back').onclick=showList;
  for(const button of detailElement.querySelectorAll('.photos button'))button.onclick=()=>showPhoto(zone,button.dataset.run);
  showPhoto(zone,runId||zone.photos[0].runId);
  document.getElementById('side').scrollTop=0;
  candidateLayer.clearLayers();
  Promise.all([getJson(`/api/analysis/${zone.id}`),getJson(`/api/map-check/${zone.id}`)]).then(([result,check])=>showAnalysis(zone,result,check));
}
const VERDICT={raised:'지도로 세니 더 좁음',lowered:'지도로 세니 더 넓음',kept:'지도로 세도 같음',missed:'검색이 실제 장소를 놓침',unverifiable:'지도로 셀 수 없음'};
const featureLine=feature=>feature.role==='area'?`<code>${escapeHtml(feature.areaName)}</code> 안에서`:feature.role==='place'?`${escapeHtml(feature.label)}${feature.unsearched?' <small>(모양은 검색 불가)</small>':''}`:'<small>검색 불가</small>';
// The cumulative analysis of the zone: what its photos give away alone, and what they add together.
const UNIT={point:'지점 하나',few:'몇 곳 / 동네',city:'도시·구',country:'국가·광역'};
const UNIT_RISK={point:'high',few:'medium',city:'low',country:'low'};
const unitTag=unit=>`<span class="risk ${UNIT_RISK[unit]}">${RISK[UNIT_RISK[unit]]}</span> (${UNIT[unit]})`;
function showAnalysis(zone,result,check=null){
  const element=document.getElementById('analysis');
  if(!element||!detailElement.querySelector('h2')?.textContent.includes(zone.id))return;
  if(!result){element.innerHTML='<div class="box"><b>누적 분석</b><p>아직 실행하지 않았습니다.</p></div>';return;}
  const evidence=new Map(result.evidence.map(item=>[item.id,item])),several=result.evidence.filter(item=>item.photos.length>1);
  const name=item=>item.isText?item.texts.map(text=>`<code>${escapeHtml(text)}</code>`).join(' '):escapeHtml(item.key);
  element.innerHTML=`<div class="box ${result.raised?'raised':''}">
    <b>누적 분석 · ${unitTag(check?.combinations.length?check.zoneUnitAfter:result.zoneUnit)}</b>
    <p class="statement">${escapeHtml(result.statement)}</p>
    ${check?.combinations.length?`<div class="mapcheck"><b>지도 확인 (카카오 장소 검색)</b><p class="statement">${escapeHtml(check.statement)}</p>
      ${check.combinations.map(combo=>`<div class="combo">${combo.features.map(featureLine).join(' + ')} · 서로 ${combo.toleranceM}m 안<br>
        ${combo.count===null?'':`<b>${combo.count}곳</b>${combo.upperBound?' 이하':''} · `}${UNIT[combo.unitBefore]} → <span class="risk ${UNIT_RISK[combo.unitAfter]}">${UNIT[combo.unitAfter]}</span> · ${VERDICT[combo.verdict]}<br><span class="why">${escapeHtml(combo.note)}</span></div>`).join('')}
      <p class="legend"><i style="background:${HERE}"></i>이 구역 <i style="background:${ELSEWHERE}"></i>같은 패턴이 있는 다른 곳</p>
      <button class="see-candidates">지도에서 후보 전부 보기</button></div>`:''}
    <button class="open-proof">위험이 정해진 과정 보기</button>
    <table>
      <tr><th>가장 좁은 단독 단서</th><td>${unitTag(result.clueUnit)}</td></tr>
      <tr><th>가장 드러난 단독 사진</th><td>${unitTag(result.photoUnit)}</td></tr>
      <tr><th>단독 분석에서 이미 높음이라 뺀 단서</th><td>${result.photos.map(photo=>`${photo.index}번 ${photo.highClues+photo.inHighCombination}개`).join(' · ')}</td></tr>
      <tr><th>빼고 남은 것의 사진별 위험</th><td>${result.photos.map(photo=>`${photo.index}번 ${RISK[photo.risk]}${photo.combinations.length?' (조합)':''}`).join(' · ')}</td></tr>
      <tr><th>증거</th><td>모은 것 ${result.counts.pool}개 → 고유 ${result.counts.unique}개 (여러 사진에 나온 것 ${several.length}개)</td></tr>
    </table>
    ${result.combinations.length?`<p class="sub">사진을 함께 읽을 때 생기는 조합</p>${result.combinations.map(combo=>`<div class="combo"><span class="risk ${combo.risk}">${RISK[combo.risk]}</span> <code>${combo.type}</code> 사진 ${combo.photos.join('·')}<br>${combo.evidenceIds.map(id=>name(evidence.get(id))).join(' + ')}<br><span class="why">${escapeHtml(combo.reason)}</span></div>`).join('')}`:''}
    ${result.rejected.length?`<p class="sub">조건에 맞지 않아 뺀 조합 ${result.rejected.length}개</p>`:''}
    <p class="sub">구역 판정: ${result.model?.transport==='handoff'||!result.model?'대역(프롬프트만 본 에이전트)':`${escapeHtml(result.model.model)} · effort ${escapeHtml(result.model.effort)}`}</p>
    <details><summary>여러 사진에 나와 한 번만 센 증거 ${several.length}개</summary><table>${several.map(item=>`<tr><td>${name(item)}</td><td>사진 ${item.photos.join('·')}</td><td>${UNIT[item.unit]}${item.uncertain?' · 같은 물체인지 불확실':''}</td></tr>`).join('')}</table></details>
  </div>`;
  element.querySelector('.open-proof').onclick=()=>showProof(zone,result,check);
  candidateLayer.clearLayers();
  const points=drawCandidates(candidateLayer,check);
  const see=element.querySelector('.see-candidates');
  if(see)see.onclick=()=>{if(points.length)map.flyToBounds(points,{padding:[40,40],duration:0.6});};
}

// ---------- Proof: how the zone's risk came about, step by step, with the photos ----------
// A photo with the given regions outlined. Coordinates are fractions of the image, so the overlay
// is an SVG stretched over it.
function shot(runId,regions,caption,tone){
  const shapes=regions.map(region=>region.polygon
    ?`<polygon points="${region.polygon.map(point=>point.join(',')).join(' ')}"/>`
    :`<rect x="${region.bbox[0]}" y="${region.bbox[1]}" width="${region.bbox[2]-region.bbox[0]}" height="${region.bbox[3]-region.bbox[1]}"/>`).join('');
  return `<figure class="shot ${tone}"><div><img loading="lazy" src="/photo/${runId}" alt=""><svg viewBox="0 0 1 1" preserveAspectRatio="none">${shapes}</svg></div><figcaption>${caption}${regions.length?'':' · 표시할 영역 없음'}</figcaption></figure>`;
}
const ORDER=['country','city','few','point'];
// The four units as a scale, wide to narrow, with marks on the ones named in `marks` ({unit:[label]}).
function ladder(marks){
  return `<div class="ladder">${ORDER.map(unit=>`<div class="step ${UNIT_RISK[unit]} ${marks[unit]?'on':''}"><b>${UNIT[unit]}</b><small>${RISK[UNIT_RISK[unit]]}</small>${(marks[unit]||[]).map(label=>`<span class="mark">${label}</span>`).join('')}</div>`).join('<i>→</i>')}</div>`;
}
const WHY={alone:'혼자서 지점 하나',raised:'검색·주소 추정으로 위치가 확인됨',combination:'사진 한 장 안의 조합으로 지점 하나',text:'이미 뺀 글자를 담고 있음',object:'이미 뺀 것과 같은 물체'};
const sameAsNote=clue=>clue.why==='text'?`<br><small>사진 ${clue.sameAs.photo}에서 뺀 <code>${escapeHtml(clue.sameAs.text)}</code></small>`:clue.why==='object'?`<br><small>사진 ${clue.sameAs.photo}에서 뺀 것 (사진 비교로 확인)</small>`:'';
function showProof(zone,result,check=null){
  const element=document.getElementById('proof'),evidence=new Map(result.evidence.map(item=>[item.id,item]));
  const label=item=>item.isText?item.texts.map(text=>`<code>${escapeHtml(text)}</code>`).join(' '):`<code>${escapeHtml(item.key)}</code>`;
  const taken=result.photos.filter(photo=>photo.taken.length);
  const left=result.evidence.filter(item=>item.unit!=='country'&&item.class!=='regional');
  const marks={};
  const mark=(unit,text)=>(marks[unit]??=[]).push(text);
  mark(result.clueUnit,'가장 좁은 단독 단서');mark(result.photoUnit,'가장 드러난 단독 사진');
  const best=result.combinations.reduce((a,b)=>a===null||ORDER.indexOf(b.unit)>ORDER.indexOf(a.unit)?b:a,null);
  const checked=check?.combinations.length?check:null;
  if(best)mark(best.unit,checked?'사진을 함께 읽으면 (모델 추정)':'<strong>사진을 함께 읽으면</strong>');
  if(checked)for(const combo of checked.combinations)if(combo.count!==null)mark(combo.unitAfter,`<strong>지도로 세면 ${combo.count}곳${combo.upperBound?' 이하':''}</strong>`);
  element.innerHTML=`<div class="sheet">
    <button class="close">닫기 ✕</button>
    <h1>${zone.id} · ${escapeHtml(zone.folder)} — 위험이 정해진 과정</h1>
    <p class="lead ${result.raised?'raised':''}">${escapeHtml(result.statement)}</p>
    ${ladder(marks)}

    <h2>1. 단독 분석이 이미 잡은 단서를 뺍니다</h2>
    <p>사진 한 장만 봐도 위치가 드러나는 단서입니다. 단독 분석에서 이미 높음으로 표시되므로, 누적분석에서는 빼고 시작합니다. 같은 글자나 같은 물체가 다른 단서·다른 사진에 다시 나오면 그것도 함께 뺍니다.${taken.length?'':'이 구역에는 해당하는 단서가 없습니다.'}</p>
    ${taken.map(photo=>`<div class="row">
      ${shot(photo.runId,photo.taken.flatMap(clue=>clue.regions),`사진 ${photo.index} · 뺀 단서 ${photo.taken.length}개`,'out')}
      <table><tr><th>단서</th><th>뺀 이유</th><th>내용</th></tr>${photo.taken.map(clue=>`<tr><td>${clue.number}</td><td>${WHY[clue.why]}${sameAsNote(clue)}${clue.combinations.length?`<br><small>${clue.combinations.map(id=>{const combo=photo.highCombinations.find(item=>item.id===id);return `조합 ${combo.type}: 단서 ${combo.clueIds.map(clueId=>clueId.replace('clue-','')).join(' + ')}`;}).join('<br>')}</small>`:''}</td><td>${clue.texts.map(text=>`<code>${escapeHtml(text)}</code>`).join(' ')} ${escapeHtml(clue.basis)}</td></tr>`).join('')}</table>
    </div>`).join('')}

    <h2>2. 남은 단서를 사진 한 장씩 읽으면</h2>
    <p>뺀 뒤에 남은 중간·낮음 단서만으로 각 사진이 좁혀지는 범위입니다. 여기까지가 단독 분석의 한계입니다.</p>
    <table class="wide"><tr><th>사진</th><th>남은 단서로 좁혀지는 범위</th><th>이 사진의 남은 단서 (나라 전체에 해당하는 것은 제외)</th></tr>
    ${result.photos.map(photo=>`<tr><td>${photo.index}번</td><td>${unitTag(photo.unit)}${photo.combinations.length?' · 사진 안 조합 포함':''}</td><td>${left.filter(item=>item.photos.includes(photo.index)).map(item=>`${label(item)} <small>${UNIT[item.unit]}</small>`).join(' · ')||'없음'}</td></tr>`).join('')}</table>
    <p>증거 ${result.counts.pool}개 중 같은 것을 한 번씩만 세면 ${result.counts.unique}개입니다. 여러 사진에 나온 ${result.counts.seenInSeveralPhotos}개는 여러 번 세지 않았습니다.</p>

    <h2>3. 사진을 함께 읽으면</h2>
    ${result.combinations.length?`<p>서로 다른 사진의 단서가 100m 안에 함께 있다는 사실이 범위를 줄입니다. 아래 조합은 어느 사진 한 장에도 다 들어 있지 않습니다.</p>`:'<p>서로 다른 사진의 단서를 합쳐도 새로 좁혀지는 조합이 없습니다.</p>'}
    ${result.combinations.map((combo,number)=>`<div class="combo-card">
      <h3>조합 ${number+1} <code>${combo.type}</code></h3>
      <div class="members">${combo.evidenceIds.map(id=>{const item=evidence.get(id);return `<div class="member">
        <div class="shots">${item.members.filter(member=>member.regions.length).concat(item.members.filter(member=>!member.regions.length)).slice(0,2).map(member=>shot(member.runId,member.regions,`사진 ${member.photo}`,'in')).join('')}</div>
        <p><b>${label(item)}</b> · 사진 ${item.photos.join('·')}</p>
        <p>단독: ${unitTag(item.unit)}</p>
        <p class="why">${escapeHtml(item.members[0].basis[0]||'')}</p>
      </div>`;}).join('<div class="plus">+</div>')}
      <div class="plus">→</div>
      <div class="outcome ${combo.risk}"><p>함께 읽으면</p><p class="big">${unitTag(combo.unit)}</p><p class="why">${escapeHtml(combo.reason)}</p></div></div>
    </div>`).join('')}

    ${checked?`<h2>4. 지도로 세어 봅니다</h2>
    <p>3의 "몇 곳"은 모델의 추정입니다. 조합의 단서를 지도 검색 조건으로 바꿔, 그 조건이 서로 ${checked.toleranceM}m 안에 모여 있는 곳을 카카오 장소 검색으로 전부 찾았습니다. 1곳이면 지점 하나(높음), 2~${checked.fewMax}곳이면 몇 곳(중간), 그보다 많으면 도시·구(낮음)입니다.</p>
    ${checked.combinations.map((combo,number)=>`<div class="combo-card">
      <h3>조합 ${number+1}의 지도 확인 · ${VERDICT[combo.verdict]}</h3>
      <table class="wide"><tr><th>단서</th><th>지도에서 찾은 조건</th><th>지도로 찾지 못한 부분</th></tr>${combo.features.map(feature=>`<tr><td>${label(evidence.get(feature.evidenceId))} · 사진 ${feature.photos.join('·')}</td><td>${feature.role==='area'?`지역: ${escapeHtml(feature.areaName)}`:feature.role==='place'?`${escapeHtml(feature.label)} <small>(${escapeHtml([feature.categoryGroup,feature.categoryGroup?null:feature.keyword,...feature.categoryIncludes].filter(Boolean).join(' · '))})</small>`:'없음'}</td><td>${escapeHtml(feature.unsearched||'')}</td></tr>`).join('')}</table>
      <p class="lead ${combo.verdict==='raised'?'raised':''}">${escapeHtml(combo.note)}</p>
      ${combo.candidates.length?`<p class="legend"><i style="background:${HERE}"></i>이 구역: 이 패턴은 여기에 있습니다 <i style="background:${ELSEWHERE}"></i>다른 곳에도 같은 패턴이 있습니다 (원 = ${combo.toleranceM}m)</p>
      <div class="proof-map" data-combo="${number}"></div>
      <p class="why">${escapeHtml(combo.anchor.label)} ${combo.anchor.total}곳을 전부 찾아 하나씩 주변을 확인했습니다. 거리 기준을 바꾸면: ${Object.entries(combo.countsByTolerance).map(([limit,count])=>`${limit}m ${count}곳`).join(' · ')}</p>
      <details><summary>후보 ${combo.count}곳 목록</summary><table>${combo.candidates.map((candidate,index)=>`<tr><td>${index+1}</td><td>${candidate.isTrue?'<b class="risk high">이 구역</b>':'다른 곳'}</td><td>${candidate.places.map(place=>`${escapeHtml(place.name)}${place.near.map(near=>` + ${escapeHtml(near.name)} (${near.distanceM}m)`).join('')}`).join('<br>')}</td></tr>`).join('')}</table></details>`:''}
    </div>`).join('')}`:''}

    <h2>${checked?5:4}. 결론</h2>
    ${ladder(marks)}
    <p class="lead ${result.raised?'raised':''}">${escapeHtml(result.statement)}</p>
    ${checked?`<p class="lead ${checked.raisedAfter?'raised':''}">${escapeHtml(checked.statement)}</p>`:''}
    <p class="foot">조합은 ${result.model?.transport==='handoff'?'대역':escapeHtml(result.model.model)}이 단서 글만 보고 판정했습니다${checked?'. 지도 확인은 장소의 종류와 지역 이름만 셀 수 있고 모양·분위기는 셀 수 없어, 센 개수는 실제로 맞는 곳의 상한입니다':'. 실제 지도 검색으로 확인한 것은 아닙니다'}. 구성 단서보다 좁아지지 않는 조합, 한 사진 안에서 다 보이는 조합은 코드가 걸러 냅니다${result.rejected.length?` (걸러 낸 조합 ${result.rejected.length}개)`:''}.</p>
  </div>`;
  element.hidden=false;element.scrollTop=0;
  for(const holder of element.querySelectorAll('.proof-map')){
    const combo=checked.combinations[Number(holder.dataset.combo)],small=L.map(holder,{scrollWheelZoom:false});
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(small);
    small.fitBounds(drawCandidates(small,{...checked,combinations:[combo]},true),{padding:[30,30],maxZoom:16});
  }
  element.querySelector('.close').onclick=()=>{element.hidden=true;};
}
document.addEventListener('keydown',event=>{if(event.key==='Escape')document.getElementById('proof').hidden=true;});
function showPhoto(zone,runId){
  const photo=zone.photos.find(item=>item.runId===runId);
  for(const button of detailElement.querySelectorAll('.photos button'))button.classList.toggle('on',button.dataset.run===runId);
  for(const [id,marker] of markers)marker.setStyle({weight:id===runId?4:1.5}).setRadius(id===runId?9:6);
  document.getElementById('photo').innerHTML=`<h2>${escapeHtml(photo.label)}</h2>
    ${photo.judged?'':'<p class="note">이 사진은 규칙 판정이 없어 범주 등급(A·B·C)으로 표시합니다.</p>'}
    <img class="big" src="/photo/${photo.runId}" alt="">
    <table><tr><th>#</th><th>분류</th><th>위험</th><th>글자 · 판정 근거</th></tr>
    ${photo.clues.map(clue=>`<tr><td>${clue.number}</td><td>${escapeHtml(clue.taxonomy)}</td>${riskCell(clue)}<td>${clue.texts.map(text=>`<code>${escapeHtml(text)}</code>`).join(' ')} ${escapeHtml(clue.basis||'')}</td></tr>`).join('')}</table>`;
}

fetch('/api/zones').then(response=>response.json()).then(data=>{
  if(!data.zones){
    document.getElementById('summary').textContent='zones.json이 없습니다. `npm run zones`를 먼저 실행하세요.';
    map.setView([37.55,126.98],11);
    return;
  }
  const bounds=[];
  data.zones.forEach((zone,number)=>{
    zone.number=number;
    const color=COLORS[number%COLORS.length],total=counts(zone.photos);
    L.circle([zone.center.lat,zone.center.lon],{radius:Math.max(zone.radiusM+8,15),color,weight:2,fillOpacity:0.12}).addTo(map).on('click',()=>showZone(zone));
    L.marker([zone.center.lat,zone.center.lon],{icon:L.divIcon({className:'label',html:zone.id,iconSize:[36,16],iconAnchor:[18,26]}),interactive:false}).addTo(map);
    for(const photo of zone.photos){
      const marker=L.circleMarker([photo.lat,photo.lon],{radius:6,color:'#fff',weight:1.5,fillColor:color,fillOpacity:1}).addTo(map).bindTooltip(`${zone.id} · ${photo.label}`);
      marker.on('click',()=>showZone(zone,photo.runId));
      markers.set(photo.runId,marker);
      bounds.push([photo.lat,photo.lon]);
    }
    const button=document.createElement('button');
    button.className='zone';
    button.innerHTML=`<span class="dot" style="background:${color}"></span><div><b>${zone.id} · ${escapeHtml(zone.folder)} ${zone.photos.map(photo=>photo.index).join('·')}</b><span>사진 ${zone.photos.length}장 · ${zone.maxPairM}m · 단서 ${total.clues}개 · 높음 ${total.high} / 중간 ${total.medium} / 낮음 ${total.low}${total.judged<zone.photos.length?` · 판정 ${total.judged}/${zone.photos.length}`:''}</span></div>`;
    button.onclick=()=>{
      map.flyToBounds(L.latLng(zone.center.lat,zone.center.lon).toBounds(Math.max(260,zone.radiusM*5)),{duration:0.6});
      showZone(zone);
    };
    zonesElement.append(button);
    // The zone's cumulative result on its row: the risk, and a mark when reading the photos together raised it.
    fetch(`/api/analysis/${zone.id}`).then(response=>response.json()).then(result=>{
      if(!result)return;
      const line=document.createElement('span');
      line.innerHTML=`누적 <span class="risk ${result.zoneRisk}">${RISK[result.zoneRisk]}</span> (${UNIT[result.zoneUnit]})${result.raised?' · <span class="risk high">단독보다 위험해짐</span>':''}`;
      button.querySelector('div').append(document.createElement('br'),line);
      getJson(`/api/map-check/${zone.id}`).then(check=>{
        const counted=(check?.combinations||[]).filter(combo=>combo.count!==null);
        if(counted.length)line.innerHTML+=` · 지도 확인 ${counted.map(combo=>`${combo.count}곳`).join(', ')}${check.raisedAfter?' · <span class="risk high">지도로도 더 위험</span>':''}`;
      });
    });
  });
  for(const photo of data.singles){
    L.circleMarker([photo.lat,photo.lon],{radius:5,color:'#fff',weight:1.5,fillColor:'#9ca3af',fillOpacity:1}).addTo(map).bindTooltip(`묶음 없음 · ${photo.label}`);
    bounds.push([photo.lat,photo.lon]);
  }
  document.getElementById('summary').textContent=`EXIF 위치 ${data.radiusM}m 묶음 ${data.zones.length}개 · 사진 ${data.zones.reduce((sum,zone)=>sum+zone.photos.length,0)}장 · 묶음 없는 사진 ${data.singles.length}장(회색)`;
  // The whole set stays in view until a zone is opened. Refitted on resize because the map may be
  // laid out with no size yet when the data arrives (a hidden pane), which fits to the deepest zoom.
  const fit=()=>{map.invalidateSize();if(!opened)map.fitBounds(bounds,{padding:[30,30]});};
  fit();
  new ResizeObserver(fit).observe(document.getElementById('map'));
});
