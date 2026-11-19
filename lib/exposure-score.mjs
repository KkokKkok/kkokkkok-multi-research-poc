// Cumulative exposure score of one person's photos ("꼭꼭 누적 노출 위험 점수 산출 규칙").
// Two layers, one above the other:
//   place   one group (the photos of one place, by EXIF position): how far its clues narrow that
//           place down, L. The document's L is the narrowest unit of any clue, or of a combination
//           the rule sheet admits within one photo, in any photo of the group. The cumulative zone
//           analysis (lib/zone-analysis.mjs, scripts/verify-zone.mjs) adds combinations across the
//           photos of the group; they count only when asked for ({cross: true}).
//   person  every group of the person: how often a place comes back, k, and how close it is to a
//           place the person registered (home, school, work), w. Then
//             A = max over groups of L·R·w, R = 1 − 0.5^(k−1)    one place shown again and again
//             B = 1 − 0.5^m, m = Σ L·w                            several places near the registered one
//             S = round(100·[1 − (1 − A)(1 − B)])
// The score itself is the document's: no combination across photos (they rest on a model's reading
// and the document leaves them for later). They come in where the zone analysis was aimed from the
// start: once the clues that give a place away alone are covered (the protective edits, §8), can the
// clues left in several photos give it away together? So the edit loop works the score out with them.
// The numbers below are the document's starting values; they are to be tuned with user tests.
// Positions and distances are for the computation only: no sentence made here holds one.

export const STRENGTH={point:1,few:0.6,city:0.2,country:0};
export const UNIT_KO={point:'지점 하나',few:'몇 곳',city:'도시·구',country:'국가·광역'};
// Distance from a group's centre to the registered place: [up to metres, w, how a sentence says it].
export const BANDS=[{maxM:500,w:1,ko:'500m'},{maxM:1000,w:0.8,ko:'1km'},{maxM:3000,w:0.5,ko:'3km'}];
export const bandOf=distanceM=>BANDS.find(band=>distanceM<=band.maxM)??null;
export const weightOf=distanceM=>bandOf(distanceM)?.w??0;
export const repeatOf=k=>k<1?0:1-0.5**(k-1);
export const GRADES=[{min:70,key:'high',ko:'높음',line:'주의가 필요해요. 모아 보면 생활권이 드러날 수 있어요'},
  {min:40,key:'caution',ko:'주의',line:'위치가 드러날 수 있는 단서가 있어요'},
  {min:0,key:'low',ko:'낮음',line:'비슷한 배경이 있어요. 참고해 주세요'}];
export const gradeOf=S=>GRADES.find(grade=>S>=grade.min);
// Thresholds of the sentences (§5).
export const REPEAT_SHOWN=0.3,COMBINATION_L=0.6;
const round2=x=>Math.round(x*100)/100;
export const unitName=L=>L>=1?UNIT_KO.point:L>=0.6?UNIT_KO.few:L>=0.2?UNIT_KO.city:'단서 아님';
// At most `shown` items in a sentence, the rest counted.
export const SHOWN=3;
const listed=(items,shown=SHOWN)=>items.length<=shown?items.join(', '):`${items.slice(0,shown).join(', ')} 외 ${items.length-shown}개`;

// ---------- combinations of type "other" ----------
// The rule sheet's combination table (A1-D2) fixes what each kind of combination narrows to. A
// combination outside the table ("other") is graded by the model alone, and most of those it grades
// a point read "a few places by a name, then one of them by its look": a last step nobody checked
// (a look is not something a map search finds). So until it is verified, such a combination narrows
// by one unit at most, and never to a point:
//   unit ≤ one unit narrower than its narrowest member, and no narrower than few.
// Verified: a map count left one spot (the zone analysis's map check), or the pattern is made a row
// of the table. Applies alike to combinations within one photo and across photos.
const ORDER=['point','few','city','country'];
export function capOther(unit,memberUnits,{verified=false}={}){
  if(verified||!(unit in STRENGTH))return {unit,capped:false};
  const narrowestMember=Math.min(...memberUnits.map(member=>ORDER.indexOf(member)).filter(index=>index>=0));
  const limit=Math.max(Number.isFinite(narrowestMember)?narrowestMember-1:ORDER.indexOf('few'),ORDER.indexOf('few'));
  const capped=Math.max(ORDER.indexOf(unit),limit);
  return {unit:ORDER[capped],capped:capped!==ORDER.indexOf(unit)};
}

// ---------- place layer ----------
// A group as this module reads it:
//   {id, name, distanceM, covered?:[key],
//    photos:[{id, index, day, candidates:[candidate]}],     a clue, or a combination within one photo
//    cross?:[candidate with photos:[index]]}                a combination across photos of the group
// candidate: {s, label, fixed, requires:[[key]] | targets:[key]}
//   requires   what the candidate is made of: one entry per member, each the keys of that member in
//              every photo it is in (the same sign in three photos is one member with three keys,
//              or one key when its text is read the same). It is gone once every key of some member
//              is covered: covering the sign in two of its three photos leaves it.
//   targets    shorthand for a candidate whose every member has one key.
//   fixed      it cannot be covered (an ordinary interior, a season: the whole frame).
const requiresOf=candidate=>candidate.requires??candidate.targets.map(key=>[key]);
const alive=(candidate,covered)=>requiresOf(candidate).every(member=>member.some(key=>!covered.has(key)));
// The place layer: what a group gives away, with the clues in `group.covered` covered.
//   cross   also the combinations across its photos (the zone analysis)
// Returns {L, deciding, strengths, linkable, crossLifts} where `crossLifts` says whether L comes from
// a combination across photos only (the photos' own clues reach less).
export function placeOf(group,{cross=false}={}){
  const covered=new Set(group.covered??[]);
  const live=photo=>photo.candidates.filter(candidate=>alive(candidate,covered));
  const strengths=group.photos.map(photo=>Math.max(0,...live(photo).map(candidate=>candidate.s)));
  const across=cross?(group.cross??[]).filter(candidate=>alive(candidate,covered)):[];
  const own=Math.max(0,...strengths),L=Math.max(own,...across.map(candidate=>candidate.s));
  // A photo is linkable when something in it narrows the place: its own clues, or a combination it is part of.
  const inCross=new Set(across.filter(candidate=>candidate.s>0).flatMap(candidate=>candidate.photos));
  const linkable=group.photos.filter((photo,index)=>strengths[index]>0||inCross.has(photo.index));
  const deciding=L>0?[...group.photos.flatMap(photo=>live(photo).filter(candidate=>candidate.s===L)),...across.filter(candidate=>candidate.s===L)]:[];
  return {L,own,deciding,strengths,linkable,crossLifts:L>own};
}

// ---------- person layer ----------
export function measure(group,options={}){
  const place=placeOf(group,options);
  const k=new Set(place.linkable.map(photo=>photo.day).filter(Boolean)).size;
  const R=repeatOf(k),w=group.w??weightOf(group.distanceM),band=group.band??bandOf(group.distanceM)?.ko??null;
  return {L:place.L,ownL:place.own,crossLifts:place.crossLifts,k,R,w,band,a:place.L*R*w,share:place.L*w,linkable:place.linkable.length,unlinked:group.photos.length-place.linkable.length,deciding:place.deciding};
}
// groups => {A, m, B, S, exact, grade, groups:[group with its measures]}
export function score(groups,options={}){
  const measured=groups.map(group=>({...group,...measure(group,options)}));
  const A=Math.max(0,...measured.map(group=>group.a)),m=measured.reduce((sum,group)=>sum+group.share,0),B=1-0.5**m;
  // `exact` is S before rounding: an edit that lowers it is worth suggesting even when the rounded
  // score does not move yet (a person with many exposed places sits at 99-100 until several are covered).
  const exact=100*(1-(1-A)*(1-B)),S=Math.round(exact);
  return {A:round2(A),m:round2(m),B:round2(B),S,exact,grade:gradeOf(S),groups:measured};
}

// ---------- sentences (§5) ----------
// The deciding clue of a group, as a sentence names it: the label of a candidate that sets L.
const decidingLabel=group=>group.deciding[0]?.label??'단서';
// How a sentence says what a group's L does: at the end, before "and", before "so". Only point and
// few are said (§5): a city-wide clue is not put in a sentence.
const PHRASE={point:{end:'장소를 특정할 수 있어요',and:'장소를 특정할 수 있고',so:'장소를 특정할 수 있어'},
  few:{end:'후보가 몇 곳으로 줄어요',and:'후보가 몇 곳으로 줄고',so:'후보가 몇 곳으로 줄어'}};
const phraseOf=L=>L>=1?PHRASE.point:L>=0.6?PHRASE.few:null;
// The larger of A and B first. excluded: {noClue, noGps} photo counts left out of the computation.
export function sentences(result,excluded={noClue:0,noGps:0}){
  const repeat=result.groups.filter(group=>group.a>=REPEAT_SHOWN).sort((x,y)=>y.a-x.a).map(group=>{
    const phrase=phraseOf(group.L);
    return {kind:'repeat',groupId:group.id,text:`'${group.name}' 사진 ${group.linkable}장이 ${group.k}일에 걸쳐 같은 장소로 반복돼요. ${decidingLabel(group)}(으)로 ${phrase?`${phrase.so}, `:''}자주 가는 곳으로 보일 수 있어요.`};
  });
  const strong=result.groups.filter(group=>group.L>=COMBINATION_L&&group.w>0).sort((x,y)=>y.share-x.share);
  let place=[];
  if(strong.length>=2){
    const farthest=strong.reduce((x,y)=>(y.distanceM??0)>(x.distanceM??0)?y:x);
    // The strongest SHOWN places are named; the others are counted.
    const named=strong.slice(0,SHOWN),rest=strong.length-named.length;
    const parts=named.map((group,index)=>`'${group.name}'의 ${decidingLabel(group)}(으)로 ${index===named.length-1?phraseOf(group.L).end:phraseOf(group.L).and}`).join(', ');
    place=[{kind:'combination',groupIds:strong.map(group=>group.id),text:`${parts}.${rest?` 이런 곳이 ${rest}곳 더 있어요.`:''} 모두 등록한 장소 ${farthest.band} 안이라 함께 보면 생활권이 좁혀질 수 있어요.`}];
  }else if(strong.length===1)place=[{kind:'single',groupId:strong[0].id,text:`'${strong[0].name}'의 ${decidingLabel(strong[0])}(으)로 장소를 확인할 수 있어요.`}];
  const out=result.B>result.A?[...place,...repeat]:[...repeat,...place];
  const left=[excluded.noClue?`위치 단서가 없는 사진 ${excluded.noClue}장`:null,excluded.noGps?`위치 정보가 없는 사진 ${excluded.noGps}장`:null].filter(Boolean);
  if(left.length)out.push({kind:'excluded',text:`${left.join(', ')}은 계산에서 뺐어요.`});
  return out;
}

// ---------- protective edits (§8) ----------
// Covering clues in a group: the keys join `covered`, wherever they are.
export function cover(group,keys){return {...group,covered:[...new Set([...(group.covered??[]),...keys])]};}
// The edits that can lower a group's L: each member of a candidate that sets L (all its keys, so
// every photo it is in), and, when several candidates set it, all of them at once (covering one
// would leave the others at the same unit).
function editsOf(group,options){
  const covered=new Set(group.covered??[]);
  const deciding=placeOf(group,options).deciding.filter(candidate=>!candidate.fixed);
  if(!deciding.length)return [];
  const open=member=>member.filter(key=>!covered.has(key)),byKeys=new Map();
  for(const candidate of deciding)requiresOf(candidate).forEach((member,index)=>{
    const keys=open(member);
    if(keys.length&&!byKeys.has(keys.join('|')))byKeys.set(keys.join('|'),{keys,label:candidate.labels?.[index]??candidate.label});
  });
  // All of them at once, covering as little as it takes: one member of each candidate, the member
  // that undoes the most candidates first (a sign shared by two combinations goes before either's
  // other members). Covering every member would be more than a person does, and would also take
  // away what is left for the photos to give away together.
  let left=deciding.filter(candidate=>alive(candidate,covered));
  const chosen=new Set();
  while(left.length>1||(left.length===1&&chosen.size)){
    const members=new Map();
    for(const candidate of left)for(const member of requiresOf(candidate)){const keys=open(member);if(keys.length)members.set(keys.join('|'),keys);}
    let best=null;
    for(const keys of members.values()){
      const trial=new Set([...covered,...chosen,...keys]),undone=left.filter(candidate=>!alive(candidate,trial)).length;
      if(!best||undone>best.undone||(undone===best.undone&&keys.length<best.keys.length))best={keys,undone};
    }
    if(!best?.undone)break;
    best.keys.forEach(key=>chosen.add(key));
    left=left.filter(candidate=>alive(candidate,new Set([...covered,...chosen])));
  }
  const all=[...chosen];
  if(all.length>1&&!byKeys.has(all.join('|'))){
    const touched=deciding.filter(candidate=>requiresOf(candidate).some(member=>member.some(key=>chosen.has(key))));
    byKeys.set(all.join('|'),{keys:all,label:listed([...new Set(touched.flatMap(candidate=>requiresOf(candidate).map((member,index)=>member.some(key=>chosen.has(key))?candidate.labels?.[index]??(requiresOf(candidate).length===1?candidate.label:null):null)).filter(Boolean))])});
  }
  return [...byKeys.values()];
}
// The photos an edit touches: those that hold one of its keys, in a clue or in a combination.
const photosHolding=(group,keys)=>group.photos.filter(photo=>photo.candidates.some(candidate=>requiresOf(candidate).some(member=>member.some(key=>keys.includes(key))))).length;
// Edits one at a time, each the one that lowers the score most (ties: fewer photos to edit), until
// the grade is low or nothing lowers it. The score worked out again from the start each time.
//   cross   whether the score the edits are chosen by counts the combinations across photos. With
//           it, an edit whose clue a combination across photos stands in for is worth little, and
//           the combination's own members become the next edit.
// Each step gives both scores, the document's (`SAfter`) and with combinations across photos
// (`SAfterCross`), and `warning` when the group still gives itself away through such a combination.
export function suggestEdits(groups,{maxSteps=10,cross=true}={}){
  const by={cross};
  let current=groups,before=score(current,by);
  const steps=[];
  while(steps.length<maxSteps&&before.grade.key!=='low'){
    let best=null;
    for(const [index,group] of current.entries())for(const option of editsOf(group,by)){
      const next=current.map((other,j)=>j===index?cover(other,option.keys):other),after=score(next,by);
      const photos=photosHolding(group,option.keys),drop=before.exact-after.exact;
      if(!best||drop>best.drop||(drop===best.drop&&photos<best.photos))best={index,option,next,after,drop,photos};
    }
    if(!best||best.drop<=1e-9)break;
    const group=current[best.index],edited=best.next[best.index];
    const ruleBefore=placeOf(group).L,ruleAfter=placeOf(edited).L,crossBefore=placeOf(group,{cross:true}).L,place=placeOf(edited,{cross:true});
    const rule=score(best.next),withCross=score(best.next,{cross:true});
    const step={groupId:group.id,groupName:group.name,label:best.option.label,keys:best.option.keys,photos:best.photos,
      LBefore:ruleBefore,LAfter:ruleAfter,LCrossBefore:crossBefore,LCrossAfter:place.L,SAfter:rule.S,SAfterCross:withCross.S,grade:rule.grade.key,gradeCross:withCross.grade.key,
      SBefore:score(current).S,SBeforeCross:before.S,
      text:`'${group.name}' 사진 ${best.photos}장에서 ${best.option.label}을(를) 지우면 ${unitName(ruleBefore)} → ${unitName(ruleAfter)}, 점수 ${score(current).S} → ${rule.S}`};
    if(place.crossLifts){
      const combination=place.deciding.find(candidate=>candidate.photos)??null;
      step.warning=`다만 사진 ${combination.photos.join('·')}을(를) 함께 보면 ${combination.label}(으)로 여전히 ${unitName(place.L)}까지 좁혀져요.`;
      step.text+=` ${step.warning}`;
    }else{
      // The edit covers members of combinations across photos as well. Would the photos' own clues
      // have been enough? If covering only those leaves the place given away by a combination
      // across photos, say so: reading the photos one at a time would have missed it.
      const deciding=placeOf(group,by).deciding.filter(candidate=>!candidate.fixed),covered=new Set(group.covered??[]);
      const ownKeys=[...new Set(deciding.filter(candidate=>!candidate.photos).flatMap(candidate=>requiresOf(candidate).flat()))].filter(key=>!covered.has(key)&&best.option.keys.includes(key));
      const crossed=deciding.filter(candidate=>candidate.photos);
      if(crossed.length&&ownKeys.length<best.option.keys.length){
        const ownOnly=placeOf(cover(group,ownKeys),{cross:true});
        if(ownOnly.crossLifts&&ownOnly.L>place.L){
          const combination=ownOnly.deciding.find(candidate=>candidate.photos);
          step.crossNeeded={label:combination.label,photos:combination.photos,unit:unitName(ownOnly.L)};
          step.text+=` 사진마다 보이는 단서만 지우면 사진 ${combination.photos.join('·')}을(를) 함께 볼 때 ${combination.label}(으)로 ${unitName(ownOnly.L)}까지 좁혀져서, 그 조합도 함께 지워야 해요.`;
        }
      }
    }
    steps.push(step);
    current=best.next;before=best.after;
  }
  return steps;
}
// The groups as they are once every clue that is high alone (a point by itself: a shop's name, a
// school's name, a station) is gone, wherever it was read. The state the zone analysis starts from
// (lib/zone-analysis.mjs handledClues): a combination within one photo whose members are each below
// high stays, and so does a combination across photos. Clues that cannot be covered go too: the
// question is what is left without them, not how to edit.
const highAlone=candidate=>candidate.s>=STRENGTH.point&&!candidate.combination&&!candidate.photos&&requiresOf(candidate).length===1;
export function withoutHigh(groups){
  return groups.map(group=>cover(group,[...new Set(group.photos.flatMap(photo=>photo.candidates.filter(highAlone).flatMap(candidate=>requiresOf(candidate).flat())))]));
}
// The groups with the edits of `steps` applied.
export const applyEdits=(groups,steps)=>groups.map(group=>cover(group,steps.filter(step=>step.groupId===group.id).flatMap(step=>step.keys)));
// What the document's own edit plan leaves once the photos are read together: the edits chosen
// without the combinations across photos, applied, then the score with and without them.
export function residual(groups,{maxSteps=50}={}){
  const steps=suggestEdits(groups,{cross:false,maxSteps}),edited=applyEdits(groups,steps);
  const rule=score(edited),withCross=score(edited,{cross:true});
  const reopened=withCross.groups.filter(group=>group.crossLifts).map(group=>({groupId:group.id,name:group.name,L:group.L,ownL:group.ownL,
    by:group.deciding.filter(candidate=>candidate.photos).map(candidate=>({label:candidate.label,photos:candidate.photos}))}));
  // Groups still above city level, and whether what keeps them there can be covered at all.
  const left=withCross.groups.filter(group=>group.L>STRENGTH.city).map(group=>({groupId:group.id,name:group.name,L:group.L,ownL:group.ownL,
    uncoverable:group.deciding.every(candidate=>candidate.fixed),labels:[...new Set(group.deciding.map(candidate=>candidate.label))]}));
  return {steps:steps.length,S:rule.S,grade:rule.grade.key,SCross:withCross.S,gradeCross:withCross.grade.key,reopened,left};
}
