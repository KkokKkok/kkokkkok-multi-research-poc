// EVALUATION ONLY. Covered, then guessed: does a zone still give its place away once every photo
// has what the single analysis flags covered?
//   node --env-file=<lab>/.env scripts/guess-zone.mjs G1 [--repeats 3] [--force]
//   1. Each photo of the zone gets grey patches over the clues the single analysis marks high:
//      a clue that is high alone, and the members of a combination inside the photo that reaches
//      a single point. That is what a user who follows the single analysis would hide.
//      A clue the lab has no region for is located by asking the model where it is in the photo
//      (the lab's pointing prompt); a clue about the photo as a whole (the kind of building one
//      stands in) has no place to cover and stays, and is reported.
//   2. The model is asked where the photo was taken (the lab's address-guess prompt): each covered
//      photo alone, and all covered photos of the zone together with the sentence that they were
//      taken within 100 metres of each other. Every question is asked `repeats` times, because one
//      answer says little: the model invents building numbers and changes its mind.
//   3. Each answer's address is turned into a position and measured against the true one. What a
//      question reached is the middle of its answers (with three: what at least two reached).
// The set reaching further than every single covered photo is cumulative risk that the single
// analysis leaves in. The covered photos go to the Claude API as the originals did in the lab; the
// guessed addresses go to a geocoder; the true positions stay on this machine.
//   private-data/zone-guess/<zone>/masked/<runId>.jpg   the covered photos
//   private-data/zone-guess/<zone>/points.json          where the model said the unlocated clues are
//   private-data/zone-guess/<zone>/result.json
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { handledClues } from '../lib/zone-analysis.mjs';
import { metres } from '../lib/kakao.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lab=resolve(process.env.KKOK_LAB_ROOT||'C:/KKokKKok/KkokKkok-Research-PoC/location-cue-lab');
process.env.KKOK_LEGACY_ROOT||='C:/KKokKKok/KkokKkok-PoC';
const sharp=createRequire(resolve(process.env.KKOK_LEGACY_ROOT,'package.json'))('sharp');
const fromLab=name=>import(pathToFileURL(resolve(lab,'lib',name)).href);
const {ruleFor,allCombinations}=await fromLab('paper-rules.mjs'),{displayRegions}=await fromLab('paper-preview.mjs'),{cotLocationPrompt}=await fromLab('paper-prompts.mjs'),
  {extractLists,parseStringList}=await fromLab('paper-pipeline.mjs'),{naverGeocode}=await fromLab('paper-score.mjs'),{pointPrompt,parsePoints}=await fromLab('paper-point.mjs'),
  {researchProvider,claudeSettings,buildClaudeRequest,readClaudeResponse}=await fromLab('paper-claude.mjs'),{dependency}=await fromLab('config.mjs');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
// How near a guess came: within HIT_M it found the place, within NEAR_M the neighbourhood.
const HIT_M=500,NEAR_M=1000,PAD=0.012;
const REACH=['miss','near','place'],REACH_KO={place:'장소를 맞힘',near:'동네까지 맞힘',miss:'못 맞힘'};
const reachOf=distanceM=>distanceM===null?'miss':distanceM<=HIT_M?'place':distanceM<=NEAR_M?'near':'miss';

const args=process.argv.slice(2),zoneId=args[0],force=args.includes('--force'),repeats=args.includes('--repeats')?Number(args[args.indexOf('--repeats')+1]):3;
const zone=readJson(resolve(root,'private-data/zones.json')).zones.find(item=>item.id===zoneId);
if(!zone||!(repeats>=1)){console.error('usage: node --env-file=<lab>/.env scripts/guess-zone.mjs <zone id> [--repeats 3] [--force]');process.exit(2);}
const directory=resolve(root,'private-data/zone-guess',zoneId);
mkdirSync(resolve(directory,'masked'),{recursive:true});

// ---------- the model ----------
const provider=researchProvider(process.env),stage=provider.stage('locator');
if(provider.name!=='claude'||!provider.configured(stage)){console.error(`No Claude credential. ${provider.hint}`);process.exit(2);}
const {effort}=claudeSettings(process.env);
let client=null;
async function call(text,images){
  if(!client){const loaded=dependency('@anthropic-ai/sdk'),Anthropic=loaded.default??loaded;client=new Anthropic({timeout:300000});}
  const request=buildClaudeRequest({model:stage.model,text,imageBytes:images[0],effort});
  // The lab's request holds one image; the rest are added in front of the text in the same form.
  request.messages[0].content.splice(1,0,...images.slice(1).map(bytes=>({type:'image',source:{type:'base64',media_type:'image/jpeg',data:bytes.toString('base64')}})));
  return readClaudeResponse(await client.beta.messages.create(request),{model:stage.model,effort,text});
}

// ---------- 1. covered photos ----------
const clamp=value=>Math.min(1,Math.max(0,value));
const pointsPath=resolve(directory,'points.json'),points=existsSync(pointsPath)?readJson(pointsPath):{};
async function cover(photo){
  const run=readJson(resolve(lab,'private-data/paper/runs',`${photo.runId}.json`)),rule=ruleFor(run);
  const flagged=handledClues(run,rule,allCombinations(run).filter(combo=>combo.type!=='guess'));
  const clues=run.clues.map((clue,number)=>({clue,number})).filter(({clue})=>flagged.has(clue.id));
  const bytes=readFileSync(resolve(lab,'private-data/paper/images',`${photo.runId}.jpg`)),{width,height}=await sharp(bytes).metadata();
  // The lab's own regions: the ones its viewer draws, else any box it holds for the clue.
  const known=new Map(clues.map(({clue})=>{
    const shown=displayRegions(clue);
    return [clue.id,(shown.length?shown:(clue.regions||[]).filter(region=>Array.isArray(region.bbox))).map(region=>region.bbox)];
  }));
  // The rest are asked about, once per photo; the answer is kept.
  const unlocated=clues.filter(({clue})=>!known.get(clue.id).length).map(({clue})=>clue);
  const kept=points[photo.runId]??{};
  if(unlocated.some(clue=>!(clue.id in kept))){
    const ids=unlocated.map(clue=>clue.id);
    let boxes=null;
    for(let attempt=1;attempt<=2&&!boxes;attempt++){try{boxes=parsePoints((await call(pointPrompt(unlocated),[bytes])).text,ids);}catch(error){if(attempt===2)throw error;}}
    points[photo.runId]={...kept,...boxes};
    writeFileSync(pointsPath,JSON.stringify(points,null,1));
  }
  const shapes=[],covered=[],pointed=[],uncovered=[];
  for(const {clue,number} of clues){
    const own=known.get(clue.id),box=own.length?null:points[photo.runId]?.[clue.id]??null,boxes=own.length?own:box?[box]:[];
    (own.length?covered:box?pointed:uncovered).push(number);
    for(const [x0,y0,x1,y1] of boxes){
      const left=clamp(x0-PAD)*width,top=clamp(y0-PAD)*height;
      shapes.push(`<rect x="${left}" y="${top}" width="${clamp(x1+PAD)*width-left}" height="${clamp(y1+PAD)*height-top}"/>`);
    }
  }
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g fill="#808080">${shapes.join('')}</g></svg>`);
  const masked=shapes.length?await sharp(bytes).composite([{input:svg,left:0,top:0}]).jpeg({quality:90}).toBuffer():bytes;
  writeFileSync(resolve(directory,'masked',`${photo.runId}.jpg`),masked);
  // What the lab already has for the photo as it is: its latest scored guess.
  const before=(run.predictions||[]).filter(item=>item.status).at(-1)??null;
  return {photo,bytes:masked,sha:createHash('sha256').update(masked).digest('hex'),flagged:clues.length,covered,pointed,uncovered,
    uncoveredDetails:uncovered.map(number=>run.clues[number].detail),
    uncoveredDistanceM:before?.score?.status==='scored'?Math.round(before.score.distanceM):null,uncoveredGuessed:Boolean(before)};
}
const photos=[];
for(const photo of zone.photos)photos.push(await cover(photo));

// ---------- 2. guesses ----------
async function ask(text,images){
  try{
    const {text:answer,raw}=await call(text,images),lists=extractLists(answer);
    return {status:'answered',answer,clueList:parseStringList(lists.clueListRaw),addressList:parseStringList(lists.addressListRaw),model:raw.responseModel,usage:raw.usage};
  }catch(error){
    if(error.message==='MODEL_REFUSED'||error.message==='MODEL_INCOMPLETE')return {status:error.message==='MODEL_REFUSED'?'refused':'incomplete',answer:null,clueList:[],addressList:[]};
    throw error;
  }
}
// ---------- 3. distance to the true position ----------
// Naver, as the lab scores. The model often writes a building number that does not exist; such an
// address is tried again without the number, which gives the street and not the building ('street').
// An address in another country is not found and counts as a miss. (The lab's Google key is refused.)
const located=new Map();
async function locate(address){
  if(located.has(address))return located.get(address);
  const street=address.replace(/^\s*[\d-]+\s+/,'');
  let at=null;
  for(const [precision,form] of [['address',address],...(street!==address?[['street',street]]:[])]){
    const found=await naverGeocode(form).catch(()=>({status:'failed'}));
    if(found.status==='resolved'){at={lat:found.latitude,lon:found.longitude,by:precision};break;}
  }
  located.set(address,at);
  return at;
}
async function score(guess,truth){
  const candidates=[];
  for(const address of guess.addressList){const at=await locate(address);candidates.push({address,resolved:Boolean(at),by:at?.by??null,distanceM:at?Math.round(metres(at,truth)):null});}
  const distances=candidates.filter(item=>item.distanceM!==null).map(item=>item.distanceM),distanceM=distances.length?Math.min(...distances):null;
  return {...guess,candidates,distanceM,reach:reachOf(distanceM),hit:distanceM!==null&&distanceM<=HIT_M};
}
// One question asked `repeats` times. Answers kept from before are used first; their distance is
// worked out again. The question's result is its middle answer: the runs in order of how near they
// came, the one in the middle.
async function asked(before,text,images,truth,label){
  const runs=[];
  for(const kept of (before||[]).slice(0,repeats))runs.push(await score(kept,truth));
  while(runs.length<repeats){runs.push(await score(await ask(text,images),truth));console.error(`${label}: ${runs.at(-1).status} ${runs.at(-1).distanceM??'-'}m`);}
  const order=[...runs].sort((a,b)=>(a.distanceM??Infinity)-(b.distanceM??Infinity)),middle=order[Math.floor((order.length-1)/2)];
  return {...middle,runs,reaches:Object.fromEntries(REACH.map(reach=>[reach,runs.filter(run=>run.reach===reach).length]))};
}
const SET_PROMPT=count=>`The ${count} photographs above were taken within 100 metres of each other.\n\n${cotLocationPrompt(1)}`;
const resultPath=resolve(directory,'result.json'),kept=existsSync(resultPath)&&!force?readJson(resultPath):null;
// An earlier result holds one answer per question (`guess`) or several (`guess.runs`).
const runsOf=guess=>guess?(guess.runs??[guess]):[];
const keptSingle=new Map((kept?.photos||[]).map(item=>[item.sha,runsOf(item.guess)]));
const singles=[];
for(const item of photos)singles.push(await asked(keptSingle.get(item.sha),cotLocationPrompt(1),[item.bytes],{lat:item.photo.lat,lon:item.photo.lon},`photo ${item.photo.index}`));
const setSha=createHash('sha256').update(photos.map(item=>item.sha).join('|')).digest('hex');
const set=await asked(kept?.setSha===setSha?runsOf(kept.set):[],SET_PROMPT(photos.length),photos.map(item=>item.bytes),{lat:zone.center.lat,lon:zone.center.lon},'set');

// ---------- verdict ----------
const km=value=>value===null?'위치를 못 구함':value>=1000?`${(value/1000).toFixed(1)}km`:`${value}m`;
const tally=guess=>`${repeats}번 중 장소 ${guess.reaches.place}번·동네 ${guess.reaches.near}번·못 맞힘 ${guess.reaches.miss}번`;
// The covered photo that came nearest, by its middle answer.
const bestSingle=singles.reduce((a,b)=>a===null||REACH.indexOf(b.reach)>REACH.indexOf(a.reach)||(b.reach===a.reach&&(b.distanceM??Infinity)<(a.distanceM??Infinity))?b:a,null);
// Raised: the photos together reached a whole step further than the best covered photo alone.
const verdict=REACH.indexOf(set.reach)>REACH.indexOf(bestSingle.reach)?'raised':set.reach==='miss'?'safe':'already';
// Whether the answers agree: every run of the set, and of the best single photo, reached the same.
const stable=[set,bestSingle].every(guess=>Object.values(guess.reaches).includes(repeats));
const leaks=photos.filter(item=>item.uncovered.length).length;
const statement={
  raised:`높음 단서를 가린 사진을 한 장씩 주면 가장 잘 맞힌 것이 "${REACH_KO[bestSingle.reach]}"(${km(bestSingle.distanceM)}, ${tally(bestSingle)})였는데, ${photos.length}장을 함께 주면 "${REACH_KO[set.reach]}"(${km(set.distanceM)}, ${tally(set)})까지 갑니다. 단독 분석이 가린 뒤에도 남는 누적 위험입니다.`,
  already:`높음 단서를 가린 뒤에도 사진 한 장만으로 "${REACH_KO[bestSingle.reach]}"(${km(bestSingle.distanceM)}, ${tally(bestSingle)})까지 갑니다. ${photos.length}장을 함께 줘도 "${REACH_KO[set.reach]}"(${km(set.distanceM)}, ${tally(set)})로 더 나아가지 않았습니다. 누적으로 새로 생긴 위험이 아니라 한 장에 남아 있는 위험입니다.`,
  safe:`높음 단서를 가리면 한 장씩도(가장 가까운 추정 ${km(bestSingle.distanceM)}, ${tally(bestSingle)}), ${photos.length}장을 함께 줘도(${km(set.distanceM)}, ${tally(set)}) 맞히지 못했습니다.`}[verdict]
  +(stable?'':' 물을 때마다 답이 달라져 이 판정은 확실하지 않습니다.')
  +(leaks?` 사진 ${leaks}장에는 장면 전체에 대한 단서라 가릴 곳이 없는 높음 단서가 남아 있습니다.`:'');
const output={schemaVersion:'zone-guess-v2',zone:zoneId,createdAt:new Date().toISOString(),model:stage.model,effort,hitM:HIT_M,nearM:NEAR_M,repeats,setSha,
  photos:photos.map((item,index)=>({index:item.photo.index,runId:item.photo.runId,sha:item.sha,flagged:item.flagged,covered:item.covered,pointed:item.pointed,uncovered:item.uncovered,uncoveredDetails:item.uncoveredDetails,
    uncoveredGuessed:item.uncoveredGuessed,uncoveredDistanceM:item.uncoveredDistanceM,guess:singles[index]})),
  set,bestSingleM:bestSingle.distanceM,bestSingleReach:bestSingle.reach,verdict,stable,statement};
writeFileSync(resultPath,JSON.stringify(output,null,1));
const line=guess=>`${REACH_KO[guess.reach]} ${km(guess.distanceM)} [${guess.runs.map(run=>km(run.distanceM)).join(', ')}]`;
console.log(JSON.stringify({zone:zoneId,verdict,stable,singles:output.photos.map(item=>`${item.index}: 가림 ${item.covered.length}+${item.pointed.length}/${item.flagged}${item.uncovered.length?` (못 가림 ${item.uncovered.length})`:''} · ${line(item.guess)}`),set:line(set)},null,1));
console.log(statement);
