// Cumulative exposure score of one person's photos ("꼭꼭 누적 노출 위험 점수 산출 규칙").
// The photos are grouped by EXIF position (a group is one place). For each group:
//   L  how far its clues narrow the place down: the narrowest unit of any clue, or of a combination
//      the rule sheet admits within one photo, in any photo of the group (the strength s of that unit);
//   k  on how many different days it was photographed (photos with s > 0 only);
//   w  how close it is to a place the person registered (home, school, work).
// Then
//   A = max over groups of L·R·w, R = 1 − 0.5^(k−1)       one place shown again and again
//   B = 1 − 0.5^m, m = Σ L·w                               several places near the registered one
//   S = round(100·[1 − (1 − A)(1 − B)])
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

// A group as this module reads it:
//   {id, name, distanceM, photos:[{id, day, candidates:[{s, unit, targets:[key], label, fixed}]}]}
// A candidate is a clue, or a combination the sheet admits within one photo. `targets` are the clues
// it is made of, as keys that are the same for the same clue seen in several photos of the group
// (the same text read twice is one sign): covering a target removes every candidate that holds it.
const photoStrength=photo=>Math.max(0,...photo.candidates.map(candidate=>candidate.s));
export function measure(group){
  const strengths=group.photos.map(photoStrength),L=Math.max(0,...strengths);
  const linkable=group.photos.filter((photo,index)=>strengths[index]>0);
  const k=new Set(linkable.map(photo=>photo.day).filter(Boolean)).size;
  const R=repeatOf(k),w=group.w??weightOf(group.distanceM),band=group.band??bandOf(group.distanceM)?.ko??null;
  const deciding=group.photos.flatMap(photo=>photo.candidates.filter(candidate=>L>0&&candidate.s===L));
  return {L,k,R,w,band,a:L*R*w,share:L*w,linkable:linkable.length,unlinked:group.photos.length-linkable.length,deciding};
}
// groups => {A, m, B, S, grade, groups:[group with its measures]}
export function score(groups){
  const measured=groups.map(group=>({...group,...measure(group)}));
  const A=Math.max(0,...measured.map(group=>group.a)),m=measured.reduce((sum,group)=>sum+group.share,0),B=1-0.5**m;
  // `exact` is S before rounding: an edit that lowers it is worth suggesting even when the rounded
  // score does not move yet (a person with many exposed places sits at 99-100 until several are covered).
  const exact=100*(1-(1-A)*(1-B)),S=Math.round(exact);
  return {A:round2(A),m:round2(m),B:round2(B),S,exact,grade:gradeOf(S),groups:measured};
}

// The deciding clue of a group, as a sentence names it: the label of a candidate that sets L.
const decidingLabel=group=>group.deciding[0]?.label??'단서';
const unitName=L=>L>=1?UNIT_KO.point:L>=0.6?UNIT_KO.few:L>=0.2?UNIT_KO.city:'단서 아님';
// At most `shown` items in a sentence, the rest counted.
export const SHOWN=3;
const listed=(items,shown=SHOWN)=>items.length<=shown?items.join(', '):`${items.slice(0,shown).join(', ')} 외 ${items.length-shown}개`;
// How a sentence says what a group's L does: at the end, before "and", before "so". Only point and
// few are said (§5): a city-wide clue is not put in a sentence.
const PHRASE={point:{end:'장소를 특정할 수 있어요',and:'장소를 특정할 수 있고',so:'장소를 특정할 수 있어'},
  few:{end:'후보가 몇 곳으로 줄어요',and:'후보가 몇 곳으로 줄고',so:'후보가 몇 곳으로 줄어'}};
const phraseOf=L=>L>=1?PHRASE.point:L>=0.6?PHRASE.few:null;
// The sentences shown with the score (§5), the larger of A and B first.
// excluded: {noClue, noGps} photo counts left out of the computation.
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

// Covering a clue everywhere it is in a group: the candidates that hold any of `keys` are gone.
export function cover(group,keys){
  const gone=new Set(keys);
  return {...group,photos:group.photos.map(photo=>({...photo,candidates:photo.candidates.filter(candidate=>!candidate.targets.some(key=>gone.has(key)))}))};
}
// The edits that can lower a group's L: each clue of a candidate that sets L, and, when several
// candidates set it, all of them at once (covering one would leave the others at the same unit).
// A candidate with `fixed: true` cannot be covered (an ordinary interior, a season: the whole frame).
function editsOf(group){
  const deciding=measure(group).deciding.filter(candidate=>!candidate.fixed);
  if(!deciding.length)return [];
  const options=new Map();
  for(const candidate of deciding)for(const key of candidate.targets)if(!options.has(key))options.set(key,{keys:[key],label:candidate.label});
  const all=[...new Set(deciding.flatMap(candidate=>candidate.targets))];
  if(all.length>1)options.set(all.join('+'),{keys:all,label:listed([...new Set(deciding.map(candidate=>candidate.label))])});
  return [...options.values()];
}
const photosHolding=(group,keys)=>group.photos.filter(photo=>photo.candidates.some(candidate=>candidate.targets.some(key=>keys.includes(key)))).length;
// Protective edits (§8): the score worked out again from the start with a clue covered, the largest
// fall first (ties: fewer photos to edit), one at a time, until the grade is low or nothing lowers it.
// Each step's `unitBefore`/`unitAfter` is the group's L before and after.
export function suggestEdits(groups,{maxSteps=10}={}){
  let current=groups,before=score(current);
  const steps=[];
  while(steps.length<maxSteps&&before.grade.key!=='low'){
    let best=null;
    for(const [index,group] of current.entries())for(const option of editsOf(group)){
      const next=current.map((other,j)=>j===index?cover(other,option.keys):other),after=score(next);
      const photos=photosHolding(group,option.keys),drop=before.exact-after.exact;
      if(!best||drop>best.drop||(drop===best.drop&&photos<best.photos))best={index,option,next,after,drop,photos};
    }
    if(!best||best.drop<=1e-9)break;
    const group=current[best.index],L0=measure(group).L,L1=measure(best.next[best.index]).L;
    steps.push({groupId:group.id,groupName:group.name,label:best.option.label,keys:best.option.keys,photos:best.photos,LBefore:L0,LAfter:L1,SBefore:before.S,SAfter:best.after.S,grade:best.after.grade.key,
      text:`'${group.name}' 사진 ${best.photos}장에서 ${best.option.label}을(를) 지우면 ${unitName(L0)} → ${unitName(L1)}, 점수 ${before.S} → ${best.after.S}`});
    current=best.next;before=best.after;
  }
  return steps;
}
