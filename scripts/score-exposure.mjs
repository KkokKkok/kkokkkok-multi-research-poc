// Cumulative exposure score per person and registered place (lib/exposure-score.mjs).
//   node scripts/score-exposure.mjs            every place in private-data/places.json
//   node scripts/score-exposure.mjs 집_합정     one person (folder)
// One folder is one person for now, and its registered place is the folder estimate (lib/places.mjs).
// Groups are the 100m zones of private-data/zones.json, and a photo in no zone is a group of its own.
// A clue's unit is the rule sheet's own reading (the lab's ruleOf), and a combination is one the sheet
// admits within one photo; the address guess of the evaluation records is left out, since it used the
// true position. Combinations across photos are not counted (the document leaves them for later).
//   private-data/exposure/<folder>.json   groups, A, B, S, the sentences and the edits suggested
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { STRENGTH,UNIT_KO,score,sentences,suggestEdits } from '../lib/exposure-score.mjs';
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
    return {s:STRENGTH[combo.unit]??0,unit:combo.unit,targets:members.map(clue=>targetOf(runId,clue)),label:`조합 ${combo.type}(${members.map(labelOf).join(' + ')})`,fixed:members.every(clue=>!(clue.regions?.length)),clueIds:combo.clueIds,combination:combo.type,
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

const groupsOf=folder=>{
  const sets=[...zones.zones.filter(zone=>zone.folder===folder).map(zone=>({id:zone.id,centre:zone.center,photos:zone.photos})),
    ...zones.singles.filter(photo=>photo.folder===folder).map(photo=>({id:`S${photo.index}`,centre:{lat:photo.lat,lon:photo.lon},photos:[photo]}))];
  return sets.map((set,number)=>{
    const group={id:set.id,centre:set.centre,photos:set.photos.map(photo=>({id:photo.runId,index:photo.index,day:photo.day,candidates:candidatesOf(photo.runId,readJson(resolve(lab,'private-data/paper/runs',`${photo.runId}.json`)))}))};
    return {...group,name:nameOf(group,number+1)};
  });
};

mkdirSync(resolve(root,'private-data/exposure'),{recursive:true});
const unitOfL=L=>Object.keys(STRENGTH).find(unit=>STRENGTH[unit]===L)??null;
for(const place of places.filter(item=>!only||item.folder===only)){
  const groups=groupsOf(place.folder).map(group=>({...group,distanceM:Math.round(metres(group.centre,place))}));
  const result=score(groups);
  const excluded={noClue:result.groups.reduce((sum,group)=>sum+group.unlinked,0),noGps:zones.withoutGpsByFolder?.[place.folder]??0};
  const lines=sentences(result,excluded),edits=suggestEdits(groups);
  const output={schemaVersion:'exposure-score-v1',createdAt:new Date().toISOString(),person:place.folder,place:{id:place.id,kind:place.kind,name:place.name,source},
    A:result.A,m:result.m,B:result.B,S:result.S,grade:{key:result.grade.key,ko:result.grade.ko,line:result.grade.line},excluded,sentences:lines,edits,
    groups:result.groups.map(group=>({id:group.id,name:group.name,photos:group.photos.length,linkable:group.linkable,L:group.L,unit:unitOfL(group.L),unitKo:UNIT_KO[unitOfL(group.L)]??'단서 없음',
      k:group.k,R:Math.round(group.R*100)/100,w:group.w,band:group.band,distanceM:group.distanceM,a:Math.round(group.a*100)/100,share:Math.round(group.share*100)/100,
      deciding:[...new Set(group.deciding.map(candidate=>candidate.label))],
      photoList:group.photos.map(photo=>({index:photo.index,day:photo.day,s:Math.max(0,...photo.candidates.map(candidate=>candidate.s))}))}))};
  writeFileSync(resolve(root,'private-data/exposure',`${place.folder}.json`),JSON.stringify(output,null,1));
  console.log(`\n== ${place.folder} (${place.kindKo}, ${source}) S ${result.S} ${result.grade.ko} | A ${result.A} B ${result.B} m ${result.m}`);
  for(const group of output.groups.filter(group=>group.w>0||group.L>0))console.log(`  ${group.id.padEnd(4)} ${group.name.slice(0,24).padEnd(24)} 사진 ${group.photos} L ${group.L} k ${group.k} R ${group.R} w ${group.w}(${group.band??'3km 밖'}) → L·R·w ${group.a}, L·w ${group.share}`);
  for(const line of lines)console.log(`  · ${line.text}`);
  for(const edit of edits)console.log(`  ✎ ${edit.text}`);
}
