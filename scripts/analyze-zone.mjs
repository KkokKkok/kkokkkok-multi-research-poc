// Cumulative analysis of one zone (lib/zone-analysis.mjs).
//   node scripts/analyze-zone.mjs G3
//   node scripts/analyze-zone.mjs G3 --handoff
// The zone judgement is one text-only call to Claude, made the way the lab's `rules` step makes it:
// the lab's key (ANTHROPIC_API_KEY in its .env), model (ANALYSIS_MODEL) and effort (ANALYSIS_EFFORT).
//   private-data/zone-analysis/<zone>/prompt.txt     the complete prompt
//   private-data/zone-analysis/<zone>/response.txt   the answer; kept, so a second run asks nothing
//   private-data/zone-analysis/<zone>/call.json      which model answered, and its token usage
//   private-data/zone-analysis/<zone>/result.json    the checked result
// --handoff makes no call: it writes the prompt and stops until someone writes response.txt.
// Every photo of the zone needs the lab's `rules` and `evidence` steps first; the command stops and
// lists the photos that lack one.
import { readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,rmSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { UNITS,rank,narrowest,poolOf,handledClues,zoneHandled,verdictLookup,pairKey,uniqueEvidence,judged,zonePrompt,checkAnswer,summarize } from '../lib/zone-analysis.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lab=resolve(process.env.KKOK_LAB_ROOT||'C:/KKokKKok/KkokKkok-Research-PoC/location-cue-lab');
process.env.KKOK_LEGACY_ROOT||='C:/KKokKKok/KkokKkok-PoC';
const fromLab=name=>import(pathToFileURL(resolve(lab,'lib',name)).href);
const {ruleFor,allCombinations}=await fromLab('paper-rules.mjs'),{sameText,normalizeText}=await fromLab('paper-evidence.mjs'),{displayRegions}=await fromLab('paper-preview.mjs');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));

const zoneId=process.argv[2],handoff=process.argv.includes('--handoff');
const zone=readJson(resolve(root,'private-data/zones.json')).zones.find(item=>item.id===zoneId);
if(!zone){console.error('usage: node scripts/analyze-zone.mjs <zone id, e.g. G3>   (run `npm run zones` first)');process.exit(2);}
const photos=zone.photos.map(photo=>({label:photo.label,index:photo.index,runId:photo.runId,run:readJson(resolve(lab,'private-data/paper/runs',`${photo.runId}.json`))}));
const lacking=photos.filter(photo=>!photo.run.rules||!photo.run.evidence).map(photo=>({photo:photo.label,runId:photo.runId,rules:Boolean(photo.run.rules),evidence:Boolean(photo.run.evidence)}));
if(lacking.length){console.log(JSON.stringify({zone:zoneId,status:'not_ready',lacking},null,1));process.exit(2);}

// The sheet's combinations of one photo. An address guess is left out: it is an evaluation, not a
// rule, and the clues it raises are already high through ruleFor.
// Where a clue or an evidence is in its photo, for the viewer: the boxes the lab's own viewer draws.
const shape=region=>({kind:region.kind,bbox:region.bbox,...(region.kind==='text'&&Array.isArray(region.polygon)?{polygon:region.polygon}:{})});
function regionsOf(run,member){
  const sources=member.clues.map(source=>run.clues.find(clue=>clue.id===source.id)),wanted=new Set(member.evidence.regionIds||[]);
  const own=sources.flatMap(clue=>displayRegions(clue).filter(region=>wanted.has(region.id)));
  // An evidence without a region of its own (a text OCR did not find) is shown by its clue's boxes.
  return (own.length?own:sources.flatMap(clue=>displayRegions(clue))).map(shape);
}
const ownCombinations=run=>allCombinations(run).filter(combo=>combo.type!=='guess');
const ownHandled=run=>handledClues(run,ruleFor(run),ownCombinations(run));
// A handled text read again: the same reading (the lab's sameText: a misread letter, a part of at
// least two fifths), or the handled text inside a longer one ("DEPOUND" in "DEPOUND WITH ..."). The
// second needs a text long enough to be a name and not a word: five letters or digits, three Hangul syllables.
const longEnough=text=>/\p{Script=Hangul}/u.test(text)?text.length>=3:text.length>=5;
const readAgain=(known,candidate)=>sameText(known,candidate)||(longEnough(normalizeText(known))&&normalizeText(candidate).includes(normalizeText(known)));
// Clues found to be an object that is already handled in another photo (below): runId => Set of clue ids.
const sameObject=new Map(photos.map(photo=>[photo.runId,new Set()])),objectWhy=new Map();
const baseHandled=run=>new Set([...ownHandled(run),...sameObject.get(run.id)]);
let zoneWide=zoneHandled(photos,baseHandled,readAgain),handled=zoneWide.of,pool=poolOf(photos,ruleFor,handled);

const directory=resolve(root,'private-data/zone-analysis',zoneId);
mkdirSync(directory,{recursive:true});
// The model, asked the way the lab asks it. Loaded only when a call is needed.
let provider=null;
async function claude(stageName){
  if(!provider){
    provider=(await fromLab('paper-claude.mjs')).researchProvider(process.env);
    if(provider.name!=='claude'||!provider.configured(provider.stage(stageName))){console.error(`No Claude credential. ${provider.hint}`);process.exit(2);}
  }
  const stage=provider.stage(stageName);
  return request=>provider.llm({model:stage.model,reasoningEffort:stage.reasoningEffort,...request});
}
// Same object or not: a medium evidence without text is joined to one of its kind in another photo
// only when a model, shown both photos side by side, says it is the same object (the lab's check
// prompt). One call per pair of photos; the verdicts are kept in checks.json and asked once.
const checksPath=resolve(directory,'checks.json'),checks=existsSync(checksPath)?readJson(checksPath):{};
const image=runId=>readFileSync(resolve(lab,'private-data/paper/images',`${runId}.jpg`));
const words=entry=>entry.clues.map(clue=>clue.detail).join(' / ');
let unique,needs,asked=0;
// needs: [{entry,reference}], each {runId,evidence,clues:[{detail}]}. Answers go into `checks`.
async function compare(needs){
  const {sideBySide}=await fromLab('paper-runner.mjs'),{checkPrompt,parseCheckAnswer}=await fromLab('paper-evidence.mjs'),ask=await claude('evidence');
  for(const [,items] of Map.groupBy(needs,need=>`${need.reference.runId}~${need.entry.runId}`)){
    const prompt=checkPrompt(items.map(({entry,reference})=>({kind:`${entry.evidence.subject} / ${entry.evidence.aspect}`,inA:words(reference),inB:words(entry)})));
    let verdicts;
    try{verdicts=parseCheckAnswer((await ask({text:prompt,imageBytes:await sideBySide(image(items[0].reference.runId),image(items[0].entry.runId))})).text,items.length);}
    catch(error){console.error(JSON.stringify({zone:zoneId,status:'failed',step:'check',error:error.message,code:error.code??null,httpStatus:error.status??null}));process.exit(1);}
    items.forEach(({entry,reference},index)=>{checks[pairKey(entry,reference)]=verdicts[index];});
    asked++;
    writeFileSync(checksPath,JSON.stringify(checks,null,1));
  }
}
// A medium evidence without text that is left, against what is handled of its kind in another photo:
// the logo of a shop was taken out with its name in one photo and was a clue of its own, without the
// name, in the next. When the photos show the same object, its clue is handled too. Only medium
// evidence is asked about: a low one fits a whole city whether or not it is the same object.
const handledObjects=()=>photos.flatMap(photo=>{
  const out=handled(photo.run),byId=new Map(photo.run.clues.map(clue=>[clue.id,clue]));
  return (photo.run.evidence||[]).filter(evidence=>!['text','logo'].includes(evidence.aspect)&&!evidence.key.startsWith('scene|')&&evidence.clueIds.some(id=>out.has(id)))
    .map(evidence=>({runId:photo.runId,index:photo.index,evidence,clues:evidence.clueIds.filter(id=>out.has(id)).map(id=>({id,detail:byId.get(id).detail}))}));
});
for(;;){
  const known=handledObjects(),left=pool.filter(entry=>!['text','logo'].includes(entry.evidence.aspect)&&!entry.evidence.key.startsWith('scene|')&&UNITS[entry.unit].risk==='medium');
  const pairs=left.flatMap(entry=>known.filter(reference=>reference.runId!==entry.runId&&reference.evidence.key===entry.evidence.key).map(reference=>({entry,reference})));
  const open=pairs.filter(pair=>!(pairKey(pair.entry,pair.reference) in checks));
  if(open.length&&!handoff)await compare(open);
  const same=pairs.filter(pair=>checks[pairKey(pair.entry,pair.reference)]==='same');
  let grew=false;
  for(const {entry,reference} of same)for(const clue of entry.clues)if(!sameObject.get(entry.runId).has(clue.id)){sameObject.get(entry.runId).add(clue.id);objectWhy.set(`${entry.runId}|${clue.id}`,{photo:reference.index});grew=true;}
  if(!grew)break;
  zoneWide=zoneHandled(photos,baseHandled,readAgain);handled=zoneWide.of;pool=poolOf(photos,ruleFor,handled);
}
for(;;){
  ({unique,needs}=uniqueEvidence(pool,{sameText,verdictOf:verdictLookup(photos,checks)}));
  if(!needs.length||handoff)break;
  await compare(needs);
}
// What a photo still reaches alone once the handled clues are out: its remaining clues, and the
// combinations among them (those below a point, since a point's members were taken out).
const photoUnits=photos.map(photo=>{
  const rule=ruleFor(photo.run),out=handled(photo.run),left=photo.run.clues.filter(clue=>!out.has(clue.id)),leftIds=new Set(left.map(clue=>clue.id));
  const combos=ownCombinations(photo.run).filter(combo=>combo.clueIds.every(id=>leftIds.has(id)));
  const highAlone=photo.run.clues.filter(clue=>rule(clue).risk==='high').length;
  // For the viewer: what was taken out and why, with where it is in the photo.
  const highCombos=ownCombinations(photo.run).filter(combo=>combo.unit==='point');
  const taken=photo.run.clues.map((clue,number)=>({clue,number})).filter(({clue})=>out.has(clue.id)).map(({clue,number})=>{
    const judgement=rule(clue),alone=judgement.risk==='high',key=`${photo.runId}|${clue.id}`,object=objectWhy.get(key)??null,sameAs=object??zoneWide.why.get(key)??null;
    return {clueId:clue.id,number,why:alone?(judgement.raised?'raised':'alone'):object?'object':sameAs?'text':'combination',sameAs,unit:judgement.unit,basis:judgement.basis,texts:clue.textTargets||[],detail:clue.detail,regions:displayRegions(clue).map(shape),
      combinations:highCombos.filter(combo=>combo.clueIds.includes(clue.id)).map(combo=>combo.id)};
  });
  return {index:photo.index,label:photo.label,runId:photo.runId,taken,highCombinations:highCombos.map(combo=>({id:combo.id,type:combo.type,clueIds:combo.clueIds,reason:combo.reason})),
    highClues:highAlone,inHighCombination:out.size-highAlone,clueUnit:narrowest(left.map(clue=>rule(clue).unit))??'country',unit:narrowest([...left.map(clue=>rule(clue).unit),...combos.map(combo=>combo.unit)])??'country',
    combinations:combos.map(combo=>({type:combo.type,clueIds:combo.clueIds,unit:combo.unit,reason:combo.reason}))};
});

const prompt=zonePrompt(unique),promptSha256=createHash('sha256').update(prompt).digest('hex');
// An answer belongs to the prompt it was written for. When the prompt changed (other rules, other
// photos), the old answer is set aside under the old prompt's hash and the request is pending again.
const promptPath=resolve(directory,'prompt.txt'),answerPath=resolve(directory,'response.txt');
if(existsSync(promptPath)&&existsSync(answerPath)){
  const before=createHash('sha256').update(readFileSync(promptPath)).digest('hex');
  if(before!==promptSha256){renameSync(answerPath,resolve(directory,`response-${before.slice(0,8)}.txt`));rmSync(resolve(directory,'result.json'),{force:true});}
}
writeFileSync(promptPath,prompt);
const counts={photos:photos.length,pool:pool.length,unique:unique.length,shownToModel:judged(unique).length,seenInSeveralPhotos:unique.filter(item=>item.photos.length>1).length,uncertain:unique.filter(item=>item.uncertain).length,unchecked:needs.length,photoComparisons:Object.keys(checks).length,comparisonCallsNow:asked};
const responsePath=resolve(directory,'response.txt'),callPath=resolve(directory,'call.json');
if(!existsSync(responsePath)||!readFileSync(responsePath,'utf8').trim()){
  if(handoff){console.log(JSON.stringify({zone:zoneId,status:'pending',prompt:resolve(directory,'prompt.txt'),answerTo:responsePath,counts},null,1));process.exit(0);}
  // The lab's Claude path: its key (.env there), model and effort, as its `rules` step uses them.
  let reply;
  try{reply=await (await claude('rules'))({text:prompt});}
  catch(error){console.error(JSON.stringify({zone:zoneId,status:'failed',error:error.message,code:error.code??null,httpStatus:error.status??null}));process.exit(1);}
  writeFileSync(responsePath,reply.text);
  writeFileSync(callPath,JSON.stringify({answeredAt:new Date().toISOString(),...reply.raw},null,1));
}else if(handoff&&!existsSync(callPath))writeFileSync(callPath,JSON.stringify({transport:'handoff',promptSha256},null,1));
// Who answered: the API call's record, or a stand-in. An answer kept from before this file existed is a stand-in's.
const call=existsSync(callPath)?readJson(callPath):{transport:'handoff'};
const answeredBy=call.promptSha256===promptSha256?call:{transport:'handoff'};

const answer=readFileSync(responsePath,'utf8').replace(/^\uFEFF/,''),{combinations,rejected}=checkAnswer(answer,unique);
const summary=summarize({unique,combinations,photoUnits});
const result={schemaVersion:'zone-analysis-v1',zone:zoneId,createdAt:new Date().toISOString(),promptSha256,
  model:{transport:answeredBy.transport,model:answeredBy.responseModel??null,effort:answeredBy.requestedReasoningEffort??null,usage:answeredBy.usage??null},answer,counts,
  photos:photoUnits.map(photo=>({...photo,risk:UNITS[photo.unit].risk})),
  evidence:unique.map(item=>({id:item.id,key:item.key,isText:item.isText,texts:item.texts,unit:item.unit,risk:UNITS[item.unit].risk,class:item.class,photos:item.photos,uncertain:item.uncertain,unchecked:item.unchecked,
    members:item.members.map(member=>{
      const run=photos.find(photo=>photo.runId===member.runId).run,rule=ruleFor(run);
      return {runId:member.runId,photo:member.index,evidenceId:member.evidence.id,clueIds:member.clues.map(clue=>clue.id),
        details:member.clues.map(clue=>clue.detail),basis:member.clues.map(clue=>rule(run.clues.find(own=>own.id===clue.id)).basis),regions:regionsOf(run,member)};
    })})),
  rejected,...summary};
writeFileSync(resolve(directory,'result.json'),JSON.stringify(result,null,1));
console.log(JSON.stringify({zone:zoneId,status:'done',counts,photoUnits:photoUnits.map(photo=>`${photo.index}:${photo.unit}`),clueUnit:summary.clueUnit,photoUnit:summary.photoUnit,zoneUnit:summary.zoneUnit,raised:summary.raised,combinations:combinations.length,rejected:rejected.map(item=>item.code)},null,1));
console.log(summary.statement);
for(const combo of summary.combinations)console.log(`- [${combo.type}] ${combo.explanation}`);
void rank;
