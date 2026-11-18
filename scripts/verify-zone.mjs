// Map check of a zone: how many places really have the pattern its photos show.
//   node --env-file=<lab>/.env scripts/verify-zone.mjs G1
// The zone judgement (analyze-zone.mjs) only estimates "a few places fit". This step counts them.
//   1. Claude turns every clue left in the zone into a search condition: an area written in a clue
//      ("마포구"), a kind of place (school, clothing shop) with the chain's name when the clue states
//      one (GS25), or nothing searchable. It sees the clue texts only. Kept in map-spec.json.
//   2. Two patterns are counted on Kakao Local:
//        places       every place clue of the zone, laid over each other one at a time
//        combination  each combination the zone judgement gave, with its own members
//      The search area is the one a clue names; when no clue names one it is Seoul, which is an
//      assumption (nothing in the photos says so) and is marked as such.
//   3. For a pattern, each kind's number in the area is asked first (one query). The rarest kind
//      is listed in full, and the other kinds are looked for around each of those places, rarest
//      first, on the places still left. A place that has them all within TOLERANCE_M is a
//      candidate; candidates next to each other are one place.
//   4. The count sets the unit: 1 = a single point (high), 2-5 = a few places (medium), more = the
//      area as a whole (low). The zone's risk is worked out again from that.
// A kind that is not found at the real zone (the map does not list that shop, or the condition is
// wrong) is left out of the pattern and reported; this uses the true position, on this machine only,
// and keeps a bad condition from throwing the real place out.
// What an appearance says (a granite gate, a historic hall) cannot be searched, so only the kind of
// place is counted and the count is an upper bound: the real number is that or fewer.
// The photos' coordinates are never sent. Kakao is asked about the area and about public places in it.
//   private-data/zone-analysis/<zone>/map-spec.json    the search conditions (Claude's answer)
//   private-data/zone-analysis/<zone>/map-check.json   the candidates and the adjusted risk
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { UNITS,RISK_KO,rank,narrowest } from '../lib/zone-analysis.mjs';
import { kakao,metres } from '../lib/kakao.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lab=resolve(process.env.KKOK_LAB_ROOT||'C:/KKokKKok/KkokKkok-Research-PoC/location-cue-lab');
process.env.KKOK_LEGACY_ROOT||='C:/KKokKKok/KkokKkok-PoC';
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
// Two things seen from photos within 100m of each other, measured between the points a map gives
// them: a school's point is the middle of its grounds, about 100m from its gate.
const TOLERANCE_M=200,FEW_MAX=5;
// A kind with more places than this in the area is not listed in full (it is still looked for
// around the places of a rarer kind); and a run stops asking after this many queries.
const LIST_MAX=6000,CALL_MAX=20000,SHOWN_MAX=300;
const DEFAULT_AREA='서울';
const unitOf=count=>count===1?'point':count<=FEW_MAX?'few':'city';

const zoneId=process.argv[2];
const zone=readJson(resolve(root,'private-data/zones.json')).zones.find(item=>item.id===zoneId);
const directory=resolve(root,'private-data/zone-analysis',zoneId||'');
if(!zone||!existsSync(resolve(directory,'result.json'))){console.error('usage: node --env-file=<lab>/.env scripts/verify-zone.mjs <zone id>   (run analyze-zone.mjs first)');process.exit(2);}
const result=readJson(resolve(directory,'result.json')),evidence=new Map(result.evidence.map(item=>[item.id,item]));

// ---------- 1. search conditions ----------
const SPEC_TEMPLATE=`The clues below come from several photographs taken within 100 metres of each other. Whether they narrow down a place is going to be checked on a map service (Kakao Local, South Korea). Turn each clue into a search condition. You do not see the photographs. Never guess the actual place: give only what the clue itself states.

For every clue answer one of:
- "area": the clue is a text naming an administrative area (a city, a district, a neighbourhood). Give "areaName" in Korean as a map would write it, with the city in front when you are sure of it (for example "서울 마포구").
- "place": the clue shows a place a map lists (a school, a clothing shop, a convenience store, a subway station), seen at or near where the photo was taken. Give
    "label": the kind in Korean, short (for example "초·중학교", "의류 매장", "GS25 편의점"),
    "brand": the name of a chain with many branches, only when the clue's own text states that name (for example "GS25", "스타벅스", "올리브영"); written as the map would write it. null for a kind without a stated chain, and null for a single shop's own name,
    "categoryGroup": one of these Kakao category group codes when one fits, else null:
      MT1 hypermarket, CS2 convenience store, PS3 kindergarten/daycare, SC4 school (all levels, universities included), AC5 private academy, PK6 car park, OL7 petrol station, SW8 subway station, BK9 bank, CT1 cultural facility, AG2 estate agent, PO3 public office, AT4 tourist attraction, AD5 lodging, FD6 restaurant, CE7 cafe, HP8 hospital, PM9 pharmacy
    "categoryIncludes": Korean words of which at least one must appear in the place's category name, to keep only the fitting kind (for example ["초등학교","중학교"] or ["의류"]); [] when the group code or the brand alone is right,
    "keyword": a Korean search word for the kind (for example "중학교", "옷가게"); general, never a name,
    "unsearched": what the clue says beyond the kind that a map search cannot use (the look of a gate, the style of a building), in Korean; null when nothing.
  Be as specific about the kind as the clue allows and no more: if the clue cannot tell an elementary school from a middle school, include both.
- "none": the clue is not a place a map lists, or says nothing that tells one neighbourhood from another (street furniture, paving, a generic building, an advertisement for something elsewhere, a product someone carries). Give "unsearched" in Korean, or null.

Clues:
<<CLUES>>

Answer with JSON only, every clue once:
{"clues":[{"evidenceId":"E1","role":"area|place|none","areaName":null,"label":null,"brand":null,"categoryGroup":null,"categoryIncludes":[],"keyword":null,"unsearched":null}]}`;
// Every clue left in the zone except the scene-wide ones (language, season, weather, layout).
const asked=result.evidence.filter(item=>!item.key.startsWith('scene|'));
const shown=asked.map(item=>({evidenceId:item.id,kind:item.key,...(item.isText?{texts:item.texts}:{}),seenInPhotos:item.photos,descriptions:[...new Set(item.members.flatMap(member=>member.details))]}));
const specPrompt=SPEC_TEMPLATE.replace('<<CLUES>>',()=>JSON.stringify(shown,null,2)),specSha=createHash('sha256').update(specPrompt).digest('hex');
const specPath=resolve(directory,'map-spec.json');
let spec=existsSync(specPath)?readJson(specPath):null;
if(asked.length&&spec?.promptSha256!==specSha){
  const provider=(await import(pathToFileURL(resolve(lab,'lib/paper-claude.mjs')).href)).researchProvider(process.env),stage=provider.stage('rules');
  if(provider.name!=='claude'||!provider.configured(stage)){console.error(`No Claude credential. ${provider.hint}`);process.exit(2);}
  const reply=await provider.llm({model:stage.model,reasoningEffort:stage.reasoningEffort,text:specPrompt});
  const text=reply.text.replace(/^\uFEFF/,''),json=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
  spec={promptSha256:specSha,answeredAt:new Date().toISOString(),model:reply.raw?.responseModel??stage.model,clues:json.clues};
  writeFileSync(specPath,JSON.stringify(spec,null,1));
}
const featureOf=id=>{
  const member=(spec?.clues||[]).find(item=>item.evidenceId===id)||{role:'none'},item=evidence.get(id);
  const feature={evidenceId:id,key:item.key,texts:item.isText?item.texts:[],photos:item.photos,role:member.role,areaName:member.areaName??null,label:member.label??null,brand:member.brand??null,
    categoryGroup:member.categoryGroup??null,categoryIncludes:member.categoryIncludes??[],keyword:member.keyword??null,unsearched:member.unsearched??null};
  if(feature.role==='place'&&!(feature.brand||feature.categoryGroup||feature.keyword))feature.role='none';
  return feature;
};
const all=asked.map(item=>featureOf(item.id));

// ---------- 2. the area ----------
const api=kakao();
// The rectangle searched around an area's centre; what lies outside the area is dropped by address.
const SPAN={1:[0.3,0.35],2:[0.12,0.15],3:[0.04,0.05]};
const centre={lat:zone.center.lat,lon:zone.center.lon};
// The attacker reads all the photos, so an area named in any of them is known for every pattern.
const named=all.filter(item=>item.role==='area'&&item.areaName).sort((a,b)=>b.areaName.length-a.areaName.length)[0]??null;
const area=await api.area(named?.areaName??DEFAULT_AREA),assumedArea=!named;
const box=area?[area.lon-SPAN[area.depth][1],area.lat-SPAN[area.depth][0],area.lon+SPAN[area.depth][1],area.lat+SPAN[area.depth][0]]:null;
const inArea=item=>item.address.startsWith(area.name);

// ---------- 3. one pattern ----------
// The same kind asked for twice (two clues, one condition) is one condition.
const sameKind=(a,b)=>a.brand===b.brand&&a.categoryGroup===b.categoryGroup&&(a.brand||a.categoryGroup||a.keyword===b.keyword)&&a.categoryIncludes.join('|')===b.categoryIncludes.join('|');
const merged=spots=>{
  const groups=[];
  for(const spot of spots){
    const joined=groups.filter(items=>items.some(other=>metres(other.place,spot.place)<=TOLERANCE_M)),together=[spot,...joined.flat()];
    for(const items of joined)groups.splice(groups.indexOf(items),1);
    groups.push(together);
  }
  return groups;
};
async function pattern(features){
  const places=[];
  for(const feature of features.filter(item=>item.role==='place'))if(!places.some(other=>sameKind(other,feature)))places.push(feature);
  if(!area)return {verdict:'unverifiable',note:`지도에서 지역 "${named?.areaName??DEFAULT_AREA}"을(를) 찾지 못했습니다.`};
  if(!places.length)return {verdict:'unverifiable',note:'지도가 장소로 싣는 종류의 단서가 없어 셀 수 없습니다.'};
  const numbers=new Map();
  for(const feature of places)numbers.set(feature,await api.count(feature,box));
  const order=[...places].sort((a,b)=>numbers.get(a)-numbers.get(b)),steps=[],absent=[];
  // The rarest kind that is found at the real zone is the one listed in full.
  let anchor=null,alive=null,truth=null;
  for(const feature of order){
    if(numbers.get(feature)>LIST_MAX||api.calls>CALL_MAX)break;
    const spots=(await api.within(feature,box)).filter(inArea).map(place=>({place,near:[]}));
    const nearest=spots.reduce((a,b)=>a===null||metres(b.place,centre)<metres(a.place,centre)?b:a,null);
    if(nearest&&metres(nearest.place,centre)<=TOLERANCE_M+100){anchor=feature;alive=spots;truth=nearest;break;}
    absent.push(feature);
    steps.push({evidenceId:feature.evidenceId,label:feature.label,inArea:spots.length,skipped:true,count:null});
  }
  if(!anchor)return {verdict:absent.length?'missed':'unverifiable',steps,note:`${absent.length?`가장 드문 종류부터 찾았지만 실제 구역 근처에서는 지도에 나오지 않았습니다(${absent.map(item=>item.label).join(', ')}).`:'장소 종류가 모두 너무 흔해서 전부 찾지 않았습니다.'} 이 패턴으로는 세지 못했습니다.`};
  steps.push({evidenceId:anchor.evidenceId,label:anchor.label,inArea:alive.length,skipped:false,count:merged(alive).length});
  for(const feature of order.filter(item=>item!==anchor&&!absent.includes(item))){
    if(api.calls>CALL_MAX){steps.push({evidenceId:feature.evidenceId,label:feature.label,inArea:numbers.get(feature),skipped:true,stopped:true,count:null});continue;}
    const found=new Map();
    for(const spot of alive){const near=(await api.around(feature,spot.place,TOLERANCE_M))[0];if(near)found.set(spot,near);}
    // Not at the real zone: the map does not list it there, or the condition is wrong. Left out.
    if(!found.has(truth)){absent.push(feature);steps.push({evidenceId:feature.evidenceId,label:feature.label,inArea:numbers.get(feature),skipped:true,count:null});continue;}
    alive=alive.filter(spot=>found.has(spot));
    for(const spot of alive)if(found.get(spot).id!==spot.place.id)spot.near.push({evidenceId:feature.evidenceId,name:found.get(spot).name,category:found.get(spot).category,lat:found.get(spot).lat,lon:found.get(spot).lon,distanceM:found.get(spot).distanceM});
    steps.push({evidenceId:feature.evidenceId,label:feature.label,inArea:numbers.get(feature),skipped:false,count:merged(alive).length});
  }
  const groups=merged(alive),count=groups.length;
  const candidates=groups.map(items=>({lat:items.reduce((sum,spot)=>sum+spot.place.lat,0)/items.length,lon:items.reduce((sum,spot)=>sum+spot.place.lon,0)/items.length,isTrue:items.includes(truth),
    places:items.map(spot=>({evidenceId:anchor.evidenceId,name:spot.place.name,category:spot.place.category,address:spot.place.address,lat:spot.place.lat,lon:spot.place.lon,near:spot.near}))}))
    .sort((a,b)=>Number(b.isTrue)-Number(a.isTrue)).slice(0,SHOWN_MAX);
  const used=places.filter(item=>!absent.includes(item));
  const upperBound=used.some(item=>item.unsearched)||absent.length>0||features.some(item=>item.role==='none');
  const others=count>1?` 다른 ${count-1}곳에도 같은 패턴이 있습니다.`:' 다른 곳에는 없습니다.';
  const left=absent.length?` ${absent.map(item=>item.label).join(', ')}은(는) 실제 구역 근처에서 지도에 나오지 않아 조건에서 뺐습니다.`:'';
  const bound=upperBound?' 모양·분위기와 지도에 없는 것은 셀 수 없어, 실제로 맞는 곳은 이보다 적을 수 있습니다.':'';
  return {verdict:'counted',steps,anchor:{evidenceId:anchor.evidenceId,label:anchor.label,total:steps.find(step=>step.evidenceId===anchor.evidenceId).inArea},candidates,count,shown:candidates.length,upperBound,trueFound:true,
    used:used.map(item=>item.evidenceId),absent:absent.map(item=>item.evidenceId),
    note:`${area.name}${assumedArea?'(가정)':''} 안에서 ${used.map(item=>item.label).join(' + ')}이(가) 서로 ${TOLERANCE_M}m 안에 모인 곳은 ${count}곳입니다 (실제 촬영 구역 포함).${others}${left}${bound}`};
}
const describe=(base,features,unitBefore,counted)=>{
  const common={...base,features,toleranceM:TOLERANCE_M,area:area?{asked:named?.areaName??DEFAULT_AREA,name:area.name,assumed:assumedArea}:null,unitBefore,countsByTolerance:{},...counted};
  if(counted.verdict!=='counted')return {...common,unitAfter:unitBefore,candidates:[],count:null};
  // More places than a few: the pattern says no more than the area does. An area that was only
  // assumed is not something the photos gave away, so the unit stays what it was.
  const unitAfter=counted.count>FEW_MAX&&assumedArea?unitBefore:unitOf(counted.count);
  return {...common,unitAfter,verdict:rank(unitAfter)<rank(unitBefore)?'raised':rank(unitAfter)>rank(unitBefore)?'lowered':'kept'};
};
const combinations=[];
// Every place clue of the zone, laid over each other.
const placeFeatures=all.filter(item=>item.role!=='none');
if(placeFeatures.some(item=>item.role==='place')){
  const members=placeFeatures.map(item=>item.evidenceId);
  combinations.push(describe({id:'zone-places',kind:'places',type:'places',evidenceIds:members,claim:'구역의 사진들에 나온 장소 단서를 전부 겹쳤을 때'},placeFeatures,narrowest(members.map(id=>evidence.get(id).unit)),await pattern(placeFeatures)));
}
// Each combination the zone judgement gave.
for(const combo of result.combinations){
  const features=combo.evidenceIds.map(featureOf);
  combinations.push(describe({id:combo.id,kind:'combination',type:combo.type,evidenceIds:combo.evidenceIds,claim:combo.reason},features,combo.unit,await pattern(features)));
}

// ---------- 4. the zone's risk, worked out again ----------
// A pattern counts only while it is narrower than each of its members.
const standing=combinations.filter(combo=>rank(combo.unitAfter)<rank(narrowest(combo.evidenceIds.map(id=>evidence.get(id).unit))));
const best=standing.reduce((a,b)=>a===null||rank(b.unitAfter)<rank(a.unitAfter)?b:a,null);
const unitAfter=narrowest([result.clueUnit,result.photoUnit,...standing.map(combo=>combo.unitAfter)]);
const raised=Boolean(best)&&rank(best.unitAfter)<rank(result.clueUnit)&&rank(best.unitAfter)<rank(result.photoUnit);
const counted=combinations.filter(combo=>combo.count!==null);
const risk=unit=>`${RISK_KO[UNITS[unit].risk]}(${UNITS[unit].ko})`;
const name=combo=>combo.kind==='places'?'사진들의 장소 단서를 전부 겹치면':'판정 모델이 낸 조합은';
let statement;
if(!combinations.length)statement='지도로 셀 수 있는 장소 단서가 없습니다.';
else if(!counted.length)statement=`지도로 세지 못했습니다. 구역의 위험도는 ${risk(unitAfter)} 그대로입니다.`;
else statement=`${counted.map(combo=>`${name(combo)} ${combo.area.name}${combo.area.assumed?'(가정)':''}에서 ${combo.count}곳(${UNITS[combo.unitAfter].ko})입니다.`).join(' ')} ${raised?`단독으로는 ${UNITS[narrowest([result.clueUnit,result.photoUnit])].ko}까지였으므로 누적으로 더 위험해졌습니다. 구역의 위험도는 ${risk(unitAfter)}입니다.`:`구역의 위험도는 ${risk(result.zoneUnit)} → ${risk(unitAfter)}${unitAfter===result.zoneUnit?' (변화 없음)':''}입니다.`}`;
const output={schemaVersion:'zone-map-check-v2',zone:zoneId,createdAt:new Date().toISOString(),source:'Kakao Local API',kakaoCalls:api.calls,toleranceM:TOLERANCE_M,fewMax:FEW_MAX,specModel:spec?.model??null,
  area:area?{name:area.name,assumed:assumedArea}:null,combinations,zoneUnitBefore:result.zoneUnit,zoneUnitAfter:unitAfter,zoneRiskAfter:UNITS[unitAfter].risk,raisedAfter:raised,statement};
writeFileSync(resolve(directory,'map-check.json'),JSON.stringify(output,null,1));
console.log(JSON.stringify({zone:zoneId,kakaoCalls:api.calls,area:output.area,zoneUnit:`${result.zoneUnit}->${unitAfter}`,raisedAfter:raised,
  combinations:combinations.map(combo=>({id:combo.id,verdict:combo.verdict,count:combo.count,unit:`${combo.unitBefore}->${combo.unitAfter}`,
    steps:(combo.steps||[]).map(step=>`${step.label}[${step.inArea}]${step.skipped?' 뺌':` → ${step.count}곳`}`)}))},null,1));
console.log(statement);
