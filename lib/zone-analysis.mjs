// Cumulative analysis of one zone (the photos within 100m of each other). NOT part of the paper.
// A photo's own analysis (the lab's rule sheet) says what each clue gives away alone. This asks what
// is left once the high clues are taken out: do the medium and low clues of several photos of the
// zone give the place away together?
//   1. pool        every photo's evidence records that come from a clue the photo's own analysis
//                  does not already mark as high, alone or in a combination (handledClues);
//   2. unique      the same evidence in several photos is counted once (uniqueEvidence);
//   3. judgement   a model lists the combinations across photos (zonePrompt), from text only;
//   4. checks      the sheet's fixed conditions are enforced here, not left to the model (checkAnswer);
//   5. comparison  against the narrowest single clue and the most exposed single photo (summarize).
// The attacker is assumed to know that the photos are of one zone (owner's decision, 2026-11-18).

// Narrow to wide, as in the lab's RULE_UNITS.
export const UNITS={point:{ko:'지점 하나',risk:'high'},few:{ko:'몇 곳 / 동네',risk:'medium'},city:{ko:'도시·구',risk:'low'},country:{ko:'국가·광역',risk:'low'}};
const ORDER=Object.keys(UNITS);
export const rank=unit=>ORDER.indexOf(unit);
export const narrowest=units=>units.reduce((best,unit)=>best===null||rank(unit)<rank(best)?unit:best,null);
export const RISK_KO={high:'높음',medium:'중간',low:'낮음'};
const COMBINATION_TYPE=/^(A[1-8]|B[1-4]|C[1-3]|D[12]|other)$/;

// photos: [{label,index,runId,run}] in zone order. judge(run) => clue => {class,unit,risk} is the lab's
// ruleFor (the sheet's reading with the raise of a clue that an address guess or a search confirmed).
// Returns [{runId,index,evidence,unit,class,clues:[{id,detail}]}]: one entry per evidence record that
// has a source clue below high.
// The unit is the clue's, and a clue is coarser than its evidence: one clue that lists six signs is
// `few` as a whole, and "the signs are in Hangul" is one of the records made from it. So:
//   an evidence made from several clues takes the WIDEST of their units: what the clues share is no
//   narrower than the widest of them;
//   what is about the whole country by definition (script, season, weather, time of day) is country.
// An evidence from a single clue keeps that clue's unit, which can still be too narrow ("Wi-Fi" read
// off a shop front that is `few` for its name). The judgement prompt says so and tells the model to
// treat a generic word as fitting everywhere.
// What a photo's own analysis already marks as high, and so is taken out before the zone is read:
//   a clue that is high alone (a point by the sheet, or raised by a search or an address guess);
//   every member of a combination that reaches a point within that one photo (owner's decision,
//   2026-11-18): each member is low alone, but the photo is already reported for them.
// What is left is what reading the photos one at a time does not catch.
// rule: clue => judgement (the lab's ruleFor(run)); combinations: the photo's own (allCombinations(run)).
export function handledClues(run,rule,combinations){
  const ids=new Set(run.clues.filter(clue=>rule(clue).risk==='high').map(clue=>clue.id));
  for(const combo of combinations)if(combo.unit==='point')for(const id of combo.clueIds)ids.add(id);
  return ids;
}
const COUNTRY_WIDE=/^scene\|(language|season|weather|time)(\||$)/;
// handled(run) => Set of clue ids the photo's own analysis already answers for (handledClues below).
// A text that a handled clue holds is out for the whole zone, whichever clue or photo it is read in
// again: the name of a shop that is high in one photo was also written into the sentence about the
// building in the same photo, and read off a bag in the next. It is the same evidence, and the photo's
// own analysis already answers for it. (Evidence without text is not matched this way: its kind alone
// does not say it is the same object.) handledTexts() lists those texts.
// And a clue that holds such a text is out as a whole, with what else was written from it: the
// sentence about the letters on a wall gave a text record and an appearance record, and the
// appearance record still says what the letters are. So the handled set grows until nothing changes:
// handled clues give texts, texts mark the clues that hold them, those clues give their texts.
//   base(run)                => Set of clue ids (handledClues)
//   matches(known,candidate) => whether `candidate` is the handled text `known` read again
// Returns {of: run => Set of clue ids, why: Map `${runId}|${clueId}` => {text,photo}} where `why` says,
// for a clue added here, which handled text it holds and the photo that text was handled in.
const isText=evidence=>evidence.aspect==='text'||evidence.aspect==='logo';
export function zoneHandled(photos,base,matches){
  const sets=new Map(photos.map(photo=>[photo.runId,new Set(base(photo.run))])),why=new Map(),texts=[];
  const collect=()=>{
    for(const photo of photos)for(const evidence of photo.run.evidence||[]){
      if(isText(evidence)&&evidence.text&&evidence.clueIds.some(id=>sets.get(photo.runId).has(id))&&!texts.some(known=>known.text===evidence.text))texts.push({text:evidence.text,photo:photo.index});
    }
  };
  for(let changed=true;changed;){
    changed=false;collect();
    for(const photo of photos)for(const evidence of photo.run.evidence||[]){
      if(!isText(evidence)||!evidence.text)continue;
      const known=texts.find(item=>matches(item.text,evidence.text));
      if(!known)continue;
      for(const id of evidence.clueIds)if(!sets.get(photo.runId).has(id)){sets.get(photo.runId).add(id);why.set(`${photo.runId}|${id}`,known);changed=true;}
    }
  }
  return {of:run=>sets.get(run.id),why,texts};
}
export function poolOf(photos,judge,handled){
  return photos.flatMap(photo=>{
    const rule=judge(photo.run),byId=new Map(photo.run.clues.map(clue=>[clue.id,clue])),out=handled(photo.run);
    return (photo.run.evidence||[]).flatMap(evidence=>{
      const sources=evidence.clueIds.map(id=>byId.get(id)).filter(clue=>clue&&!out.has(clue.id));
      if(!sources.length)return [];
      const widest=sources.reduce((a,b)=>rank(rule(b).unit)>rank(rule(a).unit)?b:a);
      const [unit,cls]=COUNTRY_WIDE.test(evidence.key)?['country','regional']:[rule(widest).unit,rule(widest).class];
      return [{runId:photo.runId,index:photo.index,evidence,unit,class:cls,clues:sources.map(clue=>({id:clue.id,detail:clue.detail}))}];
    });
  });
}

// Whether two photos show the same object, from the lab's stored photo comparisons (placeChecks):
// 'same', 'different', 'unsure', or null when the pair was never compared.
// own: {pairKey: verdict}, the comparisons asked for the zone itself (scripts/analyze-zone.mjs); they
// come first, the lab's fill in what was already asked for its 10m places.
export const pairKey=(a,b)=>[`${a.runId}|${a.evidence.id}`,`${b.runId}|${b.evidence.id}`].sort().join('~');
export function verdictLookup(photos,own={}){
  const verdicts=new Map(),key=(a,b)=>[a,b].sort().join('~');
  for(const photo of photos)for(const check of photo.run.placeChecks?.checks||[]){
    const reference=photos.find(other=>other.runId===check.refRunId);
    for(const other of reference?.run.evidence||[])if(other.placeClueId===check.clueId)verdicts.set(key(`${photo.runId}|${check.evidenceId}`,`${reference.runId}|${other.id}`),check.verdict);
  }
  return (a,b)=>own[pairKey(a,b)]??verdicts.get(pairKey(a,b))??null;
}

// The pool with each evidence once. When two entries are the same evidence:
//   text, logo        the strings are the same reading (the lab's sameText);
//   scene|...         the kind alone: a season or a language is about the whole zone;
//   low + low         the kind alone: a road surface seen twice is one clue;
//   medium involved   the kind is not enough, the photos must show the same object. 'same' joins;
//                     'unsure' joins too and is marked `uncertain` (counting it again would raise
//                     the zone's risk on no evidence); 'different' or never compared stays apart,
//                     the latter marked `unchecked`. The comparison is with the photo that showed
//                     the evidence first (the group's reference), as in the lab.
// Returns {unique:[{id:'E1',key,isText,texts,unit,class,photos:[index],members:[pool entry],uncertain,unchecked}],
// needs:[{entry,reference}]}: `needs` lists the comparisons no verdict was found for. Ask them, pass
// the verdicts in, and call again: a verdict can open a further comparison.
export function uniqueEvidence(pool,{sameText,verdictOf}){
  const groups=[],needs=[];
  for(const entry of pool){
    const {evidence}=entry,isText=evidence.aspect==='text'||evidence.aspect==='logo';
    let unchecked=false,uncertain=false;
    const group=groups.find(known=>{
      if(known.isText!==isText)return false;
      if(isText)return known.texts.some(text=>sameText(text,evidence.text));
      if(known.key!==evidence.key)return false;
      if(evidence.key.startsWith('scene|')||(UNITS[known.unit].risk==='low'&&UNITS[entry.unit].risk==='low'))return true;
      if(known.members.some(member=>member.runId===entry.runId))return false;
      const verdict=verdictOf(entry,known.members[0]);
      if(verdict==='same')return true;
      if(verdict==='different')return false;
      if(verdict==='unsure'){uncertain=true;return true;}
      needs.push({entry,reference:known.members[0]});unchecked=true;return false;
    });
    if(group){
      group.members.push(entry);
      if(isText&&!group.texts.includes(evidence.text))group.texts.push(evidence.text);
      if(!group.photos.includes(entry.index))group.photos.push(entry.index);
      if(rank(entry.unit)<rank(group.unit)){group.unit=entry.unit;group.class=entry.class;}
      group.uncertain||=uncertain;
    }else groups.push({key:evidence.key,isText,texts:isText?[evidence.text]:[],unit:entry.unit,class:entry.class,photos:[entry.index],members:[entry],uncertain:false,unchecked});
  }
  return {unique:groups.map((group,number)=>({id:`E${number+1}`,...group})),needs};
}

// What the model is shown of one evidence: no run id, no file name, nothing but the clue texts.
const shown=item=>({id:item.id,kind:item.key,...(item.isText?{texts:item.texts}:{}),class:item.class,unit:item.unit,photos:item.photos,
  descriptions:[...new Set(item.members.flatMap(member=>member.clues.map(clue=>clue.detail)))].slice(0,4)});

export const ZONE_TEMPLATE=`You judge how far the clues of several photographs narrow down a place when they are put together. All the photographs below were taken within 100 metres of each other, and whoever reads them knows that. You do not see the photographs. Never name or guess the actual place: judge only how many places fit.

Each clue below was already judged alone. Clues that point to one place by themselves have been removed, and so have clues that already point to one place together within a single photograph. Every clue here fits a few places at best. The same clue seen in several photographs is listed once, with the photographs it was seen in.

A clue's "unit" and "class" are those of the sentence it was taken from ("descriptions"). One sentence often lists several things, so read the clue's own "kind" and "texts" to see which part of the sentence it is: a generic word taken from a sentence about a shop front is not as narrow as the shop's name.

## Units
- point: narrows to one spot (one building, one shop, one specific place)
- few: a few candidate places, or one neighbourhood
- city: many places within one city or district fit
- country: a whole country or wide region fits

## Combinations
List a combination only when ALL of these hold:
1. Every member is a clue in the list below, and no single photograph shows all the members: the combination exists only because the photographs are read together.
2. Together they narrow to a unit clearly narrower than the narrowest member alone.
3. You can say why having them within 100 metres of each other matters (the overlap of two sets of places, or a spatial relation).
4. It has the fewest members that reach its unit: leaving any member out would give a wider unit.

Types (members → combined unit):
A. Overlap of the sets of places each clue points to
- A1 전국 체인 2개가 함께 있음 → few
- A2 전국 체인 3개 이상이 함께 있음 → point
- A3 체인 + 흔한 이름의 고유 상호 → point
- A4 체인 + 일부만 읽힌 고유명 → point
- A5 체인 + 버스 노선 번호 → few
- A6 버스 노선 번호 2개 이상 → few (point when three or more routes)
- A7 도로명(번호 없음) + 체인 → point
- A8 소규모 체인 + 특징적 외관 → point
B. Spatial layout: the relative position of clues narrows where the camera stood
- B1 멀리 보이는 랜드마크 2개 이상의 각도·거리 → point
- B2 멀리 보이는 랜드마크 + 앞쪽 특징적 건물 → point
- B3 멀리 보이는 랜드마크 + 높은 층 시점 → few
- B4 특징적 산·강 윤곽 + 앞쪽 건물 배치 → point
C. View plus surroundings
- C1 창밖 전국 체인 간판 + 특징 없는 스카이라인 → few
- C2 창밖 체인 간판 + 높은 층 시점 → few
- C3 창밖 체인 간판 2개 이상 + 높은 층 시점 → point
D. Nature plus man-made
- D1 특이한 지형 + 특징적 건물 → point
- D2 특이한 지형 + 전국 체인 → point
Use type "other" for a combination that meets the four conditions but matches no row.

Do NOT list a combination when:
- a member is of class regional (the other clue already assumes that region);
- the members describe the same object (a sign's text and the same sign's appearance, the same sign read in two photographs);
- the members are wide and unrelated, so together they are still city level (예: 일반 식생 + 체인, 표준형 아파트 외관 + 계절);
- a generic word is all that was read ("학원", "WIFI", a time, a price): it fits everywhere.
If the evidence is ambiguous, choose the next wider unit. An empty list is a valid answer.

Clues:
<<CLUES>>

Answer with only this JSON. "reason" is one Korean sentence saying why the members matter together, without naming a place.
\`\`\`json
{"combinations": [{"type": "A1", "evidenceIds": ["E3", "E9"], "unit": "few", "reason": "카페 체인과 편의점 체인이 100m 안에 함께 있는 곳은 몇 곳으로 줄어듦"}]}
\`\`\`
`;
// Country-level evidence (a script, a season, a road-marking style) is every other clue's premise and
// can join no combination, so it is not shown.
export const judged=unique=>unique.filter(item=>item.unit!=='country'&&item.class!=='regional');
export const zonePrompt=unique=>ZONE_TEMPLATE.replace('<<CLUES>>',()=>JSON.stringify(judged(unique).map(shown),null,2));

// The model's answer. A malformed answer is an error. A combination that breaks a condition is left
// out and listed under `rejected` with the reason.
export function checkAnswer(answer,unique){
  const match=String(answer).match(/\{[\s\S]*\}/);
  if(!match)throw new Error('ZONE_ANSWER_NOT_JSON');
  const parsed=JSON.parse(match[0]);
  if(!Array.isArray(parsed.combinations))throw new Error('ZONE_ANSWER_SHAPE');
  const byId=new Map(judged(unique).map(item=>[item.id,item])),combinations=[],rejected=[];
  for(const raw of parsed.combinations){
    const ids=Array.isArray(raw.evidenceIds)?raw.evidenceIds:[],members=ids.map(id=>byId.get(id));
    const reject=code=>rejected.push({type:raw.type,evidenceIds:ids,unit:raw.unit,code});
    if(!COMBINATION_TYPE.test(raw.type)||!(raw.unit in UNITS)||typeof raw.reason!=='string'||!raw.reason.trim()){reject('malformed');continue;}
    if(ids.length<2||new Set(ids).size!==ids.length||members.some(member=>!member)){reject('unknown_or_repeated_member');continue;}
    // Seen together in one photo: that photo's own analysis is where it belongs.
    if(members[0].photos.some(photo=>members.every(member=>member.photos.includes(photo)))){reject('single_photo');continue;}
    if(rank(raw.unit)>=rank(narrowest(members.map(member=>member.unit)))){reject('not_narrower');continue;}
    combinations.push({id:`zone-combo-${combinations.length}`,type:raw.type,evidenceIds:ids,unit:raw.unit,risk:UNITS[raw.unit].risk,reason:raw.reason.trim().slice(0,300),photos:[...new Set(members.flatMap(member=>member.photos))].sort((a,b)=>a-b)});
  }
  return {combinations,rejected};
}

// What the zone gives away compared with reading its photos one at a time.
//   photoUnits: [{index,unit}] the narrowest unit each photo reaches alone, from its remaining clues
//   and the combinations its own analysis found among them.
// `raised` is true only when the zone is narrower than both the narrowest single clue and the most
// exposed single photo: otherwise reading the photos together added nothing.
const label=item=>item.isText?`글자 "${item.texts[0]}"`:item.key;
export function summarize({unique,combinations,photoUnits}){
  const clueUnit=narrowest(unique.map(item=>item.unit)),photoUnit=narrowest(photoUnits.map(photo=>photo.unit));
  const best=combinations.reduce((a,b)=>a===null||rank(b.unit)<rank(a.unit)?b:a,null);
  const zoneUnit=narrowest([clueUnit,photoUnit,...combinations.map(combo=>combo.unit)].filter(Boolean));
  const raised=Boolean(best)&&rank(best.unit)<rank(clueUnit)&&rank(best.unit)<rank(photoUnit);
  const byId=new Map(unique.map(item=>[item.id,item]));
  const explain=combo=>`${combo.evidenceIds.map(id=>{const item=byId.get(id);return `사진 ${item.photos.join('·')}의 ${label(item)}(단독: ${UNITS[item.unit].ko})`;}).join(' + ')} → ${UNITS[combo.unit].ko}. ${combo.reason}`;
  let statement;
  if(!best)statement=`사진을 함께 읽어도 새로 좁혀지는 조합이 없습니다. 구역의 위험도는 단독 분석과 같은 ${RISK_KO[UNITS[zoneUnit].risk]}(${UNITS[zoneUnit].ko})입니다.`;
  else if(raised)statement=`단독으로는 가장 좁은 단서가 ${UNITS[clueUnit].ko}, 가장 드러난 사진이 ${UNITS[photoUnit].ko}였으나, 사진을 함께 읽으면 ${UNITS[best.unit].ko}까지 좁혀집니다. 누적 위험도는 ${RISK_KO[best.risk]}입니다.`;
  else statement=`사진을 함께 읽으면 ${UNITS[best.unit].ko}까지 좁혀지는 조합이 있지만, 사진 한 장만으로도 이미 ${UNITS[photoUnit].ko}까지 좁혀집니다. 누적으로 더 위험해지지는 않았습니다.`;
  return {clueUnit,photoUnit,zoneUnit,zoneRisk:UNITS[zoneUnit].risk,raised,statement,combinations:combinations.map(combo=>({...combo,explanation:explain(combo)}))};
}
