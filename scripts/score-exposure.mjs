// Cumulative exposure score per person and registered place (lib/exposure-score.mjs).
//   node scripts/score-exposure.mjs            every place in private-data/places.json
//   node scripts/score-exposure.mjs 집_합정     one person (folder)
// One folder is one person for now, and its registered place is the folder estimate (lib/places.mjs).
// Groups are the 100m zones of private-data/zones.json, and a photo in no zone is a group of its own.
// A clue's unit is the rule sheet's own reading (the lab's ruleOf), and a combination is one the sheet
// admits within one photo; the address guess of the evaluation records is left out, since it used the
// true position. Combinations across photos are not counted (the document leaves them for later).
// The virtual attacker (lib/attacker.mjs) is worked out next to the score: where the places the photos
// give away lead, without the registered place, and how soon that search reaches it.
//   private-data/exposure/<folder>.json   groups, A, B, S, the sentences, the edits suggested, the attacker
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { STRENGTH,UNIT_KO,score,sentences,suggestEdits,residual,withoutHigh,capOther,applyEdits } from '../lib/exposure-score.mjs';
import { attack,influenceOf,attackerLines } from '../lib/attacker.mjs';
import { loadPlaces } from '../lib/places.mjs';
import { metres } from '../lib/kakao.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lab=resolve(process.env.KKOK_LAB_ROOT||'C:/KKokKKok/KkokKkok-Research-PoC/location-cue-lab');
process.env.KKOK_LEGACY_ROOT||='C:/KKokKKok/KkokKkok-PoC';
const fromLab=name=>import(pathToFileURL(resolve(lab,'lib',name)).href);
const {ruleOf,allCombinations,RULE_CLASSES}=await fromLab('paper-rules.mjs'),{normalizeText}=await fromLab('paper-evidence.mjs');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));

const zones=readJson(resolve(root,'private-data/zones.json')),{source,places}=loadPlaces(root);
const only=process.argv[2]??null;
if(only&&!places.some(place=>place.folder===only)){console.error(`no registered place for "${only}": ${places.map(place=>place.folder).join(', ')}`);process.exit(2);}

// A clue as a candidate. The same text read in several photos of a group is one target: covering
// the sign means covering it in every photo it is in. A clue without a region in its photo (the
// season, an ordinary interior) cannot be covered.
const textOf=clue=>(clue.textTargets||[]).find(text=>normalizeText(text).length>=2)??null;
const targetOf=(runId,clue)=>{const text=textOf(clue);return text?`text|${normalizeText(text)}`:`${runId}|${clue.id}`;};
const labelOf=clue=>{
  const text=textOf(clue);
  if(text)return `'${text}' 글자`;
  const rule=ruleOf(clue);
  return `${RULE_CLASSES[rule.class]??'기타'} 단서(${clue.objectTargets?.[0]??clue.category})`;
};
// What a clue without text shows, for a group's name: the object the clue named, or its category.
const whatOf=clue=>clue.objectTargets?.[0]??clue.category;
function candidatesOf(runId,run){
  const byId=new Map(run.clues.map(clue=>[clue.id,clue]));
  const clues=run.clues.map(clue=>{const unit=ruleOf(clue).unit;return {s:STRENGTH[unit]??0,unit,targets:[targetOf(runId,clue)],label:labelOf(clue),fixed:!(clue.regions?.length),clueIds:[clue.id],text:textOf(clue),what:whatOf(clue)};}).filter(candidate=>candidate.s>0);
  const combos=allCombinations(run).filter(combo=>combo.type!=='guess').map(combo=>{
    const members=combo.clueIds.map(id=>byId.get(id)).filter(Boolean);
    // A combination outside the sheet's table is held to one unit narrower than its members until verified (capOther).
    const {unit,capped}=combo.type==='other'?capOther(combo.unit,members.map(clue=>ruleOf(clue).unit)):{unit:combo.unit,capped:false};
    return {s:STRENGTH[unit]??0,unit,unitByModel:combo.unit,capped,targets:members.map(clue=>targetOf(runId,clue)),label:`조합 ${combo.type}${capped?'(검증 전)':''}(${members.map(labelOf).join(' + ')})`,fixed:members.every(clue=>!(clue.regions?.length)),clueIds:combo.clueIds,combination:combo.type,
      texts:members.map(textOf).filter(Boolean),what:members.map(whatOf).join(' + ')};
  }).filter(candidate=>candidate.s>0);
  return [...clues,...combos];
}

// A group's name (§2): the text read at its deciding clue, else what kind of clue decides it, else a number.
function nameOf(group,number){
  const all=group.photos.flatMap(photo=>photo.candidates),L=Math.max(0,...all.map(candidate=>candidate.s));
  if(!L)return `장소 ${number}`;
  const deciding=all.filter(candidate=>candidate.s===L),singles=deciding.filter(candidate=>!candidate.combination);
  // A text that sets L by itself, else any text among the deciding clues and combinations' members, else the clue's kind.
  const text=singles.find(candidate=>candidate.text)?.text??deciding.flatMap(candidate=>candidate.texts??[candidate.text]).find(Boolean);
  const short=value=>value.length>24?`${value.slice(0,24)}…`:value;
  if(text)return short(text);
  return `${short((singles[0]??deciding[0]).what)}이(가) 보이는 곳`;
}

// The combinations across the photos of a zone, from the cumulative zone analysis: the model's
// combinations that passed the code's checks (result.json), with the map's count in place of the
// model's unit where the map counted it (map-check.json). Each member is an evidence of the zone,
// with its clues in every photo it was seen in: the combination is gone once one member is covered
// in all of them. None for a zone that was not analysed.
const runOf=new Map();
const runFor=runId=>{if(!runOf.has(runId))runOf.set(runId,readJson(resolve(lab,'private-data/paper/runs',`${runId}.json`)));return runOf.get(runId);};
function crossOf(zoneId){
  const directory=resolve(root,'private-data/zone-analysis',zoneId),resultPath=resolve(directory,'result.json');
  if(!existsSync(resultPath))return {cross:[],analysed:false};
  const analysis=readJson(resultPath),checkPath=resolve(directory,'map-check.json'),check=existsSync(checkPath)?readJson(checkPath):null;
  const evidence=new Map(analysis.evidence.map(item=>[item.id,item]));
  const keysOf=item=>[...new Set(item.members.flatMap(member=>{const run=runFor(member.runId);return member.clueIds.map(id=>targetOf(member.runId,run.clues.find(clue=>clue.id===id)));}))];
  const nameOf=item=>item.isText?`'${item.texts[0]}' 글자`:item.key.split('|').slice(0,2).join(' ');
  const cross=analysis.combinations.map(combo=>{
    const members=combo.evidenceIds.map(id=>evidence.get(id)),counted=check?.combinations.find(item=>item.id===combo.id&&['raised','kept','lowered'].includes(item.verdict));
    // A map count is a verification; an "other" combination the map did not count is held by capOther.
    const {unit,capped}=counted?{unit:counted.unitAfter,capped:false}:combo.type==='other'?capOther(combo.unit,members.map(item=>item.unit)):{unit:combo.unit,capped:false};
    return {s:STRENGTH[unit]??0,unit,unitByModel:combo.unit,capped,unitSource:counted?'map':'model',type:combo.type,reason:combo.reason,photos:combo.photos,
      requires:members.map(keysOf),labels:members.map(nameOf),label:`사진 간 조합 ${combo.type}${capped?'(검증 전)':''}(${members.map(nameOf).join(' + ')})`,fixed:false};
  }).filter(candidate=>candidate.s>0);
  return {cross,analysed:true};
}

const groupsOf=folder=>{
  const sets=[...zones.zones.filter(zone=>zone.folder===folder).map(zone=>({id:zone.id,centre:zone.center,photos:zone.photos,...crossOf(zone.id)})),
    ...zones.singles.filter(photo=>photo.folder===folder).map(photo=>({id:`S${photo.index}`,centre:{lat:photo.lat,lon:photo.lon},photos:[photo],cross:[],analysed:false}))];
  return sets.map((set,number)=>{
    const group={id:set.id,centre:set.centre,cross:set.cross,analysed:set.analysed,photos:set.photos.map(photo=>({id:photo.runId,index:photo.index,day:photo.day,candidates:candidatesOf(photo.runId,runFor(photo.runId))}))};
    return {...group,name:nameOf(group,number+1)};
  });
};

mkdirSync(resolve(root,'private-data/exposure'),{recursive:true});
const unitOfL=L=>Object.keys(STRENGTH).find(unit=>STRENGTH[unit]===L)??null;
for(const place of places.filter(item=>!only||item.folder===only)){
  const groups=groupsOf(place.folder).map(group=>({...group,distanceM:Math.round(metres(group.centre,place))}));
  // The document's score, and the same with the combinations across photos (for comparison: on the
  // photos as they are it adds little, since one photo already gives most places away).
  const result=score(groups),withCross=score(groups,{cross:true});
  const excluded={noClue:result.groups.reduce((sum,group)=>sum+group.unlinked,0),noGps:zones.withoutGpsByFolder?.[place.folder]??0};
  // Edits chosen with the combinations across photos: an edit they stand in for comes with a warning.
  const lines=sentences(result,excluded),edits=suggestEdits(groups,{cross:true,maxSteps:50});
  // The document's own plan (photo by photo), and what the combinations across photos give away after it.
  const left=residual(groups);
  // Without the clues that are high alone: what the medium and low clues give away, photo by photo
  // (the document's score) and read together (with the combinations across photos).
  const bare=withoutHigh(groups),bareRule=score(bare),bareCross=score(bare,{cross:true});
  const noHigh={removed:bare.reduce((sum,group)=>sum+(group.covered?.length??0),0),
    A:bareRule.A,m:bareRule.m,B:bareRule.B,S:bareRule.S,grade:bareRule.grade.key,
    cross:{A:bareCross.A,m:bareCross.m,B:bareCross.B,S:bareCross.S,grade:bareCross.grade.key},
    sentences:sentences(bareRule,{noClue:bareRule.groups.reduce((sum,group)=>sum+group.unlinked,0),noGps:0}).filter(line=>line.kind!=='excluded'),
    groups:bareRule.groups.map((group,index)=>({id:group.id,L:group.L,k:group.k,a:Math.round(group.a*100)/100,share:Math.round(group.share*100)/100,LCross:bareCross.groups[index].L,crossLifts:bareCross.groups[index].crossLifts,
      deciding:[...new Set(bareCross.groups[index].deciding.map(candidate=>candidate.label))]})),
    edits:suggestEdits(bare,{cross:true,maxSteps:30})};
  // The virtual attacker: the photos read together (the combinations across photos count), in three
  // states: as they are, without the clues that are high alone, and after the document's own edits.
  const registered=[{id:place.id,lat:place.lat,lon:place.lon}];
  const seen=state=>{
    const found=attack(score(state,{cross:true}).groups,{registered});
    return {...found.places[0],peak:found.peak,evidence:found.evidence,candidates:found.candidates,lines:attackerLines(found,place.id)};
  };
  const attacker={original:seen(groups),noHigh:seen(bare),edited:seen(applyEdits(groups,suggestEdits(groups,{cross:false,maxSteps:50}))),
    influence:influenceOf(score(groups,{cross:true}).groups,place.id,{registered}).slice(0,5)};
  // Positions are kept for the local viewer's map only (private-data, served to this machine).
  const output={schemaVersion:'exposure-score-v3',createdAt:new Date().toISOString(),person:place.folder,place:{id:place.id,kind:place.kind,kindKo:place.kindKo,name:place.name,source,lat:place.lat,lon:place.lon},
    A:result.A,m:result.m,B:result.B,S:result.S,grade:{key:result.grade.key,ko:result.grade.ko,line:result.grade.line},
    withCross:{A:withCross.A,m:withCross.m,B:withCross.B,S:withCross.S,grade:withCross.grade.key},excluded,sentences:lines,edits,residual:left,noHigh,attacker,
    groups:result.groups.map((group,index)=>{
      const crossed=withCross.groups[index];
      return {id:group.id,name:group.name,photos:group.photos.length,linkable:group.linkable,L:group.L,unit:unitOfL(group.L),unitKo:UNIT_KO[unitOfL(group.L)]??'단서 없음',
        LCross:crossed.L,crossLifts:crossed.crossLifts,analysed:group.analysed,
        k:group.k,R:Math.round(group.R*100)/100,w:group.w,band:group.band,distanceM:group.distanceM,a:Math.round(group.a*100)/100,share:Math.round(group.share*100)/100,
        deciding:[...new Set(group.deciding.map(candidate=>candidate.label))],
        cross:group.cross.map(candidate=>({type:candidate.type,unit:candidate.unit,unitByModel:candidate.unitByModel,capped:candidate.capped,unitSource:candidate.unitSource,photos:candidate.photos,members:candidate.labels,reason:candidate.reason})),
        centre:group.centre,
        photoList:group.photos.map(photo=>({index:photo.index,runId:photo.id,day:photo.day,s:Math.max(0,...photo.candidates.map(candidate=>candidate.s))}))};
    })};
  writeFileSync(resolve(root,'private-data/exposure',`${place.folder}.json`),JSON.stringify(output,null,1));
  console.log(`\n== ${place.folder} (${place.kindKo}, ${source}) S ${result.S} ${result.grade.ko} | A ${result.A} B ${result.B} m ${result.m} | 사진 간 조합 포함 S ${withCross.S}`);
  for(const group of output.groups.filter(group=>group.w>0||group.L>0))console.log(`  ${group.id.padEnd(4)} ${group.name.slice(0,24).padEnd(24)} 사진 ${group.photos} L ${group.L}${group.cross.length?` (사진 간 조합 ${group.cross.map(item=>`${item.type}:${item.unit}`).join(',')})`:''} k ${group.k} R ${group.R} w ${group.w}(${group.band??'3km 밖'}) → L·R·w ${group.a}, L·w ${group.share}`);
  for(const line of lines)console.log(`  · ${line.text}`);
  for(const edit of edits)console.log(`  ✎ ${edit.text} [사진 간 조합 포함 점수 ${edit.SAfterCross}]`);
  const said=state=>`${state.verdict.ko}${state.searchRadiusM===null?'':` 반경 ${state.searchRadiusM}m`}${state.candidate?` (${state.candidate.rank}순위 후보에서 ${state.candidate.distanceM}m)`:''}`;
  console.log(`  ◎ 가상 공격자: 원래 ${said(attacker.original)} | 높음 단서 없이 ${said(attacker.noHigh)} | 한 장씩 편집 뒤 ${said(attacker.edited)}`);
  if(attacker.influence.length)console.log(`    빼면 가장 넓어지는 곳: ${attacker.influence.slice(0,3).map(item=>`${item.groupId} → ${item.searchRadiusM===null?'찾지 못함':`${item.searchRadiusM}m`}`).join(', ')}`);
  console.log(`  ▶ 문서 방식 편집 ${left.steps}단계 뒤: 점수 ${left.S}(${left.grade}), 사진 간 조합 포함 ${left.SCross}(${left.gradeCross})${left.reopened.length?` · 다시 드러나는 곳: ${left.reopened.map(group=>`${group.groupId} ${UNIT_KO[Object.keys(STRENGTH).find(unit=>STRENGTH[unit]===group.ownL)]}→${UNIT_KO[Object.keys(STRENGTH).find(unit=>STRENGTH[unit]===group.L)]} (${group.by.map(item=>`사진 ${item.photos.join('·')} ${item.label}`).join('; ')})`).join(' / ')}`:''}`);
}
