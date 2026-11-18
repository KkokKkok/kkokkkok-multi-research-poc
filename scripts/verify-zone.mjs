// Map check of a zone's combinations: how many places really have the pattern.
//   node --env-file=<lab>/.env scripts/verify-zone.mjs G1
// The zone judgement (analyze-zone.mjs) only estimates "a few places fit". This step counts them:
//   1. Claude turns each member of a combination into a search condition: an area written in a
//      clue ("마포구"), a kind of place (school, clothing shop), or nothing searchable. It sees the
//      clue texts only, as the zone judgement did. Kept in map-spec.json and asked once.
//   2. Kakao Local lists every place of the rarest kind inside the area, then looks around each one
//      for the other kinds. A place that has them all within TOLERANCE_M is a candidate. Candidates
//      next to each other are one place.
//   3. The count sets the unit: 1 = a single point (high), 2-5 = a few places (medium), more = the
//      area as a whole (low). The zone's risk is worked out again from that.
// What an appearance says (a granite gate, a historic hall) cannot be searched, so only the kind of
// place is counted and the count is an upper bound: the real number is that or fewer.
// The photos' coordinates are never sent. Kakao is asked about the area and about public places in
// it; which candidate is the real zone is decided here, from zones.json.
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
const TOLERANCE_M=200,LOOK_M=300,SENSITIVITY=[100,200,300];
const FEW_MAX=5;
const unitOf=count=>count===1?'point':count<=FEW_MAX?'few':'city';

const zoneId=process.argv[2];
const zone=readJson(resolve(root,'private-data/zones.json')).zones.find(item=>item.id===zoneId);
const directory=resolve(root,'private-data/zone-analysis',zoneId||'');
if(!zone||!existsSync(resolve(directory,'result.json'))){console.error('usage: node --env-file=<lab>/.env scripts/verify-zone.mjs <zone id>   (run analyze-zone.mjs first)');process.exit(2);}
const result=readJson(resolve(directory,'result.json')),evidence=new Map(result.evidence.map(item=>[item.id,item]));

// ---------- 1. search conditions ----------
const SPEC_TEMPLATE=`A set of clues from several photographs taken within 100 metres of each other is said to fit only a few places. That claim is going to be checked on a map service (Kakao Local, South Korea). Turn each clue into a search condition. You do not see the photographs. Never name or guess the actual place, shop, school or brand: give only what the clue itself states.

For every clue answer one of:
- "area": the clue is a text naming an administrative area (a city, a district, a neighbourhood). Give "areaName" in Korean as a map would write it, with the city in front when you are sure of it (for example "서울 마포구").
- "place": the clue shows a kind of place a map lists (a school, a clothing shop, a hospital, a subway station). Give
    "label": the kind in Korean, short (for example "초·중학교", "의류 매장"),
    "categoryGroup": one of these Kakao category group codes when one fits, else null:
      MT1 hypermarket, CS2 convenience store, PS3 kindergarten/daycare, SC4 school (all levels, universities included), AC5 private academy, PK6 car park, OL7 petrol station, SW8 subway station, BK9 bank, CT1 cultural facility, AG2 estate agent, PO3 public office, AT4 tourist attraction, AD5 lodging, FD6 restaurant, CE7 cafe, HP8 hospital, PM9 pharmacy
    "categoryIncludes": Korean words of which at least one must appear in the place's category name, to keep only the fitting kind (for example ["초등학교","중학교"] or ["의류판매"]); [] when the group code alone is right,
    "keyword": a Korean search word for the kind (for example "중학교", "옷가게"); general, never a name,
    "unsearched": what the clue says beyond the kind that a map search cannot use (the look of a gate, the style of a building), in Korean; null when nothing.
  Be as specific about the kind as the clue allows and no more: if the clue cannot tell an elementary school from a middle school, include both.
- "none": the clue is not a place a map lists (street furniture, paving, weather). Give "unsearched" in Korean.

Combinations and their clues:
<<COMBINATIONS>>

Answer with JSON only:
{"combinations":[{"id":"zone-combo-0","members":[{"evidenceId":"E1","role":"area|place|none","areaName":null,"label":null,"categoryGroup":null,"categoryIncludes":[],"keyword":null,"unsearched":null}]}]}`;
const shown=result.combinations.map(combo=>({id:combo.id,claim:combo.reason,clues:combo.evidenceIds.map(id=>{
  const item=evidence.get(id);
  return {evidenceId:id,kind:item.key,...(item.isText?{texts:item.texts}:{}),seenInPhotos:item.photos,descriptions:item.members.flatMap(member=>member.details)};
})}));
const specPrompt=SPEC_TEMPLATE.replace('<<COMBINATIONS>>',()=>JSON.stringify(shown,null,2)),specSha=createHash('sha256').update(specPrompt).digest('hex');
const specPath=resolve(directory,'map-spec.json');
let spec=existsSync(specPath)?readJson(specPath):null;
if(result.combinations.length&&spec?.promptSha256!==specSha){
  const provider=(await import(pathToFileURL(resolve(lab,'lib/paper-claude.mjs')).href)).researchProvider(process.env),stage=provider.stage('rules');
  if(provider.name!=='claude'||!provider.configured(stage)){console.error(`No Claude credential. ${provider.hint}`);process.exit(2);}
  const reply=await provider.llm({model:stage.model,reasoningEffort:stage.reasoningEffort,text:specPrompt});
  const text=reply.text.replace(/^\uFEFF/,''),json=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
  spec={promptSha256:specSha,answeredAt:new Date().toISOString(),model:reply.raw?.responseModel??stage.model,combinations:json.combinations};
  writeFileSync(specPath,JSON.stringify(spec,null,1));
}

// ---------- 2. candidates ----------
const api=kakao();
// The rectangle searched around an area's centre; what lies outside the area is dropped by address.
const SPAN={1:[0.3,0.35],2:[0.12,0.15],3:[0.04,0.05]};
const centre={lat:zone.center.lat,lon:zone.center.lon};
async function check(combo){
  const members=(spec.combinations.find(item=>item.id===combo.id)?.members||[]).filter(member=>combo.evidenceIds.includes(member.evidenceId));
  const features=combo.evidenceIds.map(id=>{
    const member=members.find(item=>item.evidenceId===id)||{role:'none'},item=evidence.get(id);
    return {evidenceId:id,key:item.key,texts:item.isText?item.texts:[],photos:item.photos,role:member.role,areaName:member.areaName??null,label:member.label??null,categoryGroup:member.categoryGroup??null,categoryIncludes:member.categoryIncludes??[],keyword:member.keyword??null,unsearched:member.unsearched??null};
  });
  const base={id:combo.id,type:combo.type,evidenceIds:combo.evidenceIds,claim:combo.reason,unitBefore:combo.unit,features,toleranceM:TOLERANCE_M};
  const keep=(verdict,note)=>({...base,verdict,note,unitAfter:combo.unit,candidates:[],count:null});
  const areaName=features.filter(item=>item.role==='area'&&item.areaName).map(item=>item.areaName).sort((a,b)=>b.length-a.length)[0];
  const places=features.filter(item=>item.role==='place'&&(item.categoryGroup||item.keyword));
  if(!areaName)return keep('unverifiable','조합에 지역 이름이 적힌 단서가 없어 어디를 찾을지 정할 수 없습니다. 판정 모델의 추정을 그대로 둡니다.');
  if(!places.length)return keep('unverifiable','조합에 지도가 장소로 싣는 종류의 단서가 없어 셀 수 없습니다. 판정 모델의 추정을 그대로 둡니다.');
  const area=await api.area(areaName);
  if(!area)return keep('unverifiable',`지도에서 지역 "${areaName}"을(를) 찾지 못했습니다.`);
  const [dLat,dLon]=SPAN[area.depth],box=[area.lon-dLon,area.lat-dLat,area.lon+dLon,area.lat+dLat];
  const inArea=item=>item.address.startsWith(area.name);
  // The rarest kind is listed in full. Kinds with a category group are cheap to list; a kind known
  // by keyword only is listed when there is no other.
  const listable=places.filter(item=>item.categoryGroup),lists=[];
  for(const feature of listable.length?listable:[places[0]])lists.push({feature,all:(await api.within(feature,box)).filter(inArea)});
  lists.sort((a,b)=>a.all.length-b.all.length);
  const anchor=lists[0],others=places.filter(item=>item!==anchor.feature);
  const spots=[];
  for(const place of anchor.all){
    const near=[];
    for(const feature of others){
      const found=(await api.around(feature,place,LOOK_M)).filter(item=>item.id!==place.id)[0];
      near.push(found?{evidenceId:feature.evidenceId,name:found.name,category:found.category,address:found.address,lat:found.lat,lon:found.lon,distanceM:found.distanceM}:null);
    }
    spots.push({place,near,reach:Math.max(0,...near.map(item=>item?item.distanceM:Infinity))});
  }
  // Spots next to each other are one place (two buildings of one campus).
  const group=limit=>{
    const fit=spots.filter(spot=>spot.reach<=limit),groups=[];
    for(const spot of fit){
      const joined=groups.filter(items=>items.some(other=>metres(other.place,spot.place)<=limit));
      const merged=[spot,...joined.flat()];
      for(const items of joined)groups.splice(groups.indexOf(items),1);
      groups.push(merged);
    }
    return groups;
  };
  const candidates=group(TOLERANCE_M).map(items=>{
    const points=items.flatMap(spot=>[spot.place,...spot.near]);
    return {lat:items.reduce((sum,spot)=>sum+spot.place.lat,0)/items.length,lon:items.reduce((sum,spot)=>sum+spot.place.lon,0)/items.length,
      // Decided on this machine: the zone's own centre is not part of any request.
      offM:Math.min(...points.map(point=>metres(point,centre))),
      places:items.map(spot=>({evidenceId:anchor.feature.evidenceId,name:spot.place.name,category:spot.place.category,address:spot.place.address,lat:spot.place.lat,lon:spot.place.lon,
        near:spot.near.map(item=>({evidenceId:item.evidenceId,name:item.name,category:item.category,lat:item.lat,lon:item.lon,distanceM:item.distanceM}))}))};
  });
  // The real zone is the candidate nearest to it, when that one is near enough: a place's point may
  // be TOLERANCE_M from what the photos show, and the photos up to 100m from the zone's centre.
  const nearest=candidates.reduce((a,b)=>a===null||b.offM<a.offM?b:a,null);
  for(const item of candidates){item.isTrue=item===nearest&&item.offM<=TOLERANCE_M+100;delete item.offM;}
  candidates.sort((a,b)=>Number(b.isTrue)-Number(a.isTrue));
  const count=candidates.length,trueFound=candidates.some(item=>item.isTrue);
  const upperBound=features.some(item=>item.role==='none'||item.unsearched);
  const common={...base,area:{asked:areaName,name:area.name,lat:area.lat,lon:area.lon},anchor:{evidenceId:anchor.feature.evidenceId,label:anchor.feature.label,total:anchor.all.length},
    candidates,count,countsByTolerance:Object.fromEntries(SENSITIVITY.map(limit=>[limit,group(limit).length])),upperBound,trueFound};
  if(!trueFound)return {...common,verdict:'missed',unitAfter:combo.unit,note:`검색 조건에 맞는 곳 ${count}곳 중에 실제 촬영 구역이 없습니다. 검색 조건이 실제 장소를 놓친 것이므로 이 개수로 위험도를 바꾸지 않습니다.`};
  const unitAfter=unitOf(count),verdict=rank(unitAfter)<rank(combo.unit)?'raised':rank(unitAfter)>rank(combo.unit)?'lowered':'kept';
  const bound=upperBound?' 모양·분위기는 지도에서 찾을 수 없어 장소의 종류만 셌으므로, 실제로 맞는 곳은 이보다 적을 수 있습니다.':'';
  return {...common,verdict,unitAfter,note:`${area.name} 안에서 이 패턴이 있는 곳은 ${count}곳입니다 (실제 촬영 구역 포함).${count>1?` 다른 ${count-1}곳에도 같은 패턴이 있습니다.`:' 다른 곳에는 없습니다.'}${bound}`};
}
const combinations=[];
for(const combo of result.combinations)combinations.push(await check(combo));

// ---------- 3. the zone's risk, worked out again ----------
// A combination counts only while it is narrower than each of its members.
const standing=combinations.filter(combo=>rank(combo.unitAfter)<rank(narrowest(combo.evidenceIds.map(id=>evidence.get(id).unit))));
const best=standing.reduce((a,b)=>a===null||rank(b.unitAfter)<rank(a.unitAfter)?b:a,null);
const unitAfter=narrowest([result.clueUnit,result.photoUnit,...standing.map(combo=>combo.unitAfter)]);
const raised=Boolean(best)&&rank(best.unitAfter)<rank(result.clueUnit)&&rank(best.unitAfter)<rank(result.photoUnit);
const changed=combinations.filter(combo=>combo.verdict==='raised'||combo.verdict==='lowered');
const risk=unit=>`${RISK_KO[UNITS[unit].risk]}(${UNITS[unit].ko})`;
let statement;
if(!combinations.length)statement='지도로 확인할 조합이 없습니다.';
else if(!changed.length)statement=`지도에서 센 결과가 판정 모델의 추정과 같거나, 지도로 셀 수 없었습니다. 구역의 위험도는 ${risk(unitAfter)} 그대로입니다.`;
else statement=`${changed.map(combo=>`${combo.area.name}에서 이 패턴이 있는 곳을 지도로 세면 ${combo.count}곳이라 조합의 범위가 ${UNITS[combo.unitBefore].ko} → ${UNITS[combo.unitAfter].ko}로 ${combo.verdict==='raised'?'좁아집니다':'넓어집니다'}.`).join(' ')} 구역의 위험도는 ${risk(result.zoneUnit)} → ${risk(unitAfter)}${unitAfter===result.zoneUnit?' (변화 없음: 사진 한 장만으로 이미 이 범위)':''}입니다.`;
const output={schemaVersion:'zone-map-check-v1',zone:zoneId,createdAt:new Date().toISOString(),source:'Kakao Local API',kakaoCalls:api.calls,toleranceM:TOLERANCE_M,fewMax:FEW_MAX,specModel:spec?.model??null,
  combinations,zoneUnitBefore:result.zoneUnit,zoneUnitAfter:unitAfter,zoneRiskAfter:UNITS[unitAfter].risk,raisedAfter:raised,statement};
writeFileSync(resolve(directory,'map-check.json'),JSON.stringify(output,null,1));
console.log(JSON.stringify({zone:zoneId,kakaoCalls:api.calls,zoneUnitBefore:result.zoneUnit,zoneUnitAfter:unitAfter,raisedAfter:raised,
  combinations:combinations.map(combo=>({id:combo.id,verdict:combo.verdict,area:combo.area?.name,features:combo.features.map(item=>`${item.evidenceId}:${item.role}:${item.label??item.areaName??''}:${item.categoryGroup??item.keyword??''}:${item.categoryIncludes.join('|')}`),anchorTotal:combo.anchor?.total,count:combo.count,byTolerance:combo.countsByTolerance,trueFound:combo.trueFound,upperBound:combo.upperBound,unit:`${combo.unitBefore}->${combo.unitAfter}`}))},null,1));
console.log(statement);
