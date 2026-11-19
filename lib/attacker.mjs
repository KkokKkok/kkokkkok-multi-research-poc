// The virtual attacker: someone who has a person's photos and nothing else, and looks for where
// the person's life is centred (a home, a school, a workplace).
// The exposure score (lib/exposure-score.mjs) starts from the registered place and asks how much is
// given away around it. That takes the place as known. This module turns the question round: from
// the places the photos give away alone, where would one look, and how soon does that search reach
// the registered place? The registered place is used to grade the answer only, never to find it.
//
// What the attacker has, per group (a place): its unit (how far the clues narrow it) and on how many
// days it was photographed. Not its position: that is known only as far as the unit goes.
//   point   the spot itself
//   few     one of a few spots: somewhere within UNCERTAINTY_M.few
//   city    a district: somewhere within UNCERTAINTY_M.city
// So a group stands at a "believed" position: its own centre for a point, and otherwise the middle
// of the cell of a fixed grid its centre falls in (the true centre is never further than the
// uncertainty from it). Five photos of one district say "this district" five times, not five spots.
//
// Where a centre of life could be: the score's own distance weight w, read the other way. A place
// within 500m of the registered one counts 1 there, so a place known to a point speaks for every
// spot within 500m of it with 1, within 1km with 0.8, within 3km with 0.5. The support of a spot is
//   support(p) = Σ over groups of L · (1 + R) · w(distance(p, believed) − uncertainty)
// (R the score's repeat factor: a place seen on several days counts up to twice). At the registered
// place, with every group a point seen once, this is the score's m. The attacker searches from the
// best supported spot down. Hence, per registered place:
//   search area   the area supported at least as well as the registered place: what is searched
//                 before the search reaches it. As a radius: one place known to a point gives 500m,
//                 to a few spots 1km, to a district 3km; places around it on several sides give less.
//   candidates    the best supported regions, each with the groups behind it. One far from every
//                 registered place, and well supported, is a centre of life nobody registered.
// This is a lower bound of what can be found: an attacker who knows the school or the employer from
// elsewhere needs less. Positions are for the computation and the local viewer only.
import { STRENGTH,BANDS,weightOf,repeatOf } from './exposure-score.mjs';

// How far a group's true centre can be from where the attacker puts it, by unit (metres). With the
// 500m band of w, a lone place leads to 500m, 1km or 3km: the score's own bands.
export const UNCERTAINTY_M={point:0,few:500,city:2500};
export const unitOfL=L=>L>=STRENGTH.point?'point':L>=STRENGTH.few?'few':L>=STRENGTH.city?'city':null;
// How close the search gets, by the radius of the search area: the score's bands again.
export const VERDICTS=[{maxM:500,key:'found',ko:'찾아냄',line:'사진만으로 500m 안까지 좁혀져요'},
  {maxM:1000,key:'near',ko:'근처까지',line:'사진만으로 1km 안까지 좁혀져요'},
  {maxM:3000,key:'area',ko:'동네 수준',line:'사진만으로는 동네 수준까지만 좁혀져요'}];
export const NOT_FOUND={key:'none',ko:'찾지 못함',line:'사진만으로는 이 장소 근처를 가리키지 못해요'};
export const verdictOf=radiusM=>radiusM===null?NOT_FOUND:VERDICTS.find(verdict=>radiusM<=verdict.maxM)??NOT_FOUND;
// A candidate this well supported, away from every registered place, is reported as a centre of
// life nobody registered: two places known to a point, or one seen on several days.
export const HUB_SUPPORT=2;
const REACH_M=BANDS.at(-1).maxM,DEG=111195;

// Where the attacker puts a group: the centre for a point, else the middle of the grid cell it is
// in. The grid is fixed (it does not depend on the other groups), and a cell's half diagonal is
// the uncertainty, so the true centre is within it.
export function believedOf(centre,unit){
  const uncertaintyM=UNCERTAINTY_M[unit]??0;
  if(!uncertaintyM)return {lat:centre.lat,lon:centre.lon,uncertaintyM:0};
  const cell=uncertaintyM*Math.SQRT2,stepLat=cell/DEG,lat=(Math.floor(centre.lat/stepLat)+0.5)*stepLat;
  const stepLon=cell/(DEG*Math.cos(lat*Math.PI/180)),lon=(Math.floor(centre.lon/stepLon)+0.5)*stepLon;
  return {lat,lon,uncertaintyM};
}

// What the attacker has: one entry per group that gives anything away.
//   groups   [{id, centre:{lat,lon}, L, R?, k?}]   (the measured groups of score())
function evidenceOf(groups,plane){
  return groups.flatMap(group=>{
    const unit=unitOfL(group.L);
    if(!unit||!group.centre)return [];
    const believed=believedOf(group.centre,unit),R=group.R??repeatOf(group.k??1);
    return [{id:group.id,unit,weight:group.L*(1+R),uncertaintyM:believed.uncertaintyM,...plane.to(believed)}];
  });
}
// A flat map around the photos, in metres: fine over the few kilometres that matter, and the same
// for every call on the same photos (the reference latitude is rounded), so results compare.
function planeOf(groups){
  const first=groups.find(group=>group.centre)?.centre??{lat:0,lon:0},scale=Math.cos(Math.round(first.lat*10)/10*Math.PI/180);
  return {to:({lat,lon})=>({x:lon*DEG*scale,y:lat*DEG}),from:({x,y})=>({lat:y/DEG,lon:x/(DEG*scale)})};
}
const supportAt=(evidence,x,y)=>evidence.reduce((sum,item)=>sum+item.weight*weightOf(Math.max(0,Math.hypot(x-item.x,y-item.y)-item.uncertaintyM)),0);
// The support of every cell some evidence reaches: Map(cell key => support). Cells are cellM wide.
const OFFSET=1e6,SPAN=4e6,keyOf=(ix,iy)=>(ix+OFFSET)*SPAN+iy+OFFSET,cellOf=key=>[Math.floor(key/SPAN)-OFFSET,key%SPAN-OFFSET];
function supportMap(evidence,cellM){
  const cells=new Map();
  for(const item of evidence){
    const reach=REACH_M+item.uncertaintyM;
    for(let ix=Math.ceil((item.x-reach)/cellM);ix*cellM<=item.x+reach;ix++)for(let iy=Math.ceil((item.y-reach)/cellM);iy*cellM<=item.y+reach;iy++){
      const w=weightOf(Math.max(0,Math.hypot(ix*cellM-item.x,iy*cellM-item.y)-item.uncertaintyM));
      if(w>0){const key=keyOf(ix,iy);cells.set(key,(cells.get(key)??0)+item.weight*w);}
    }
  }
  return cells;
}
const EPSILON=1e-9,radiusOf=areaM2=>Math.sqrt(areaM2/Math.PI),round1=x=>Math.round(x*10)/10,round2=x=>Math.round(x*100)/100;
// The best supported region: the cells as well supported as the best one, as far as they hang together.
function peakOf(cells,cellM){
  let top=null,peak=0;
  for(const [key,value] of cells)if(value>peak+EPSILON){peak=value;top=key;}
  if(top===null)return null;
  const floor=peak-EPSILON,seen=new Set([top]),queue=[top];
  let sumX=0,sumY=0;
  for(let head=0;head<queue.length;head++){
    const [ix,iy]=cellOf(queue[head]);
    sumX+=ix;sumY+=iy;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const next=keyOf(ix+dx,iy+dy);
      if(!seen.has(next)&&(cells.get(next)??0)>=floor){seen.add(next);queue.push(next);}
    }
  }
  return {peak,x:sumX/queue.length*cellM,y:sumY/queue.length*cellM,areaM2:queue.length*cellM*cellM};
}

// groups => what the attacker finds.
//   registered   [{id, lat, lon}]   the registered places, to grade against
// Returns
//   {evidence, peak,
//    candidates:[{rank, lat, lon, support, radiusM, groupIds, nearest:{id, distanceM}|null, unregistered}],
//    places:[{id, support, share, searchAreaKm2, searchRadiusM, verdict:{key, ko, line}, candidate:{rank, distanceM}|null}]}
export function attack(groups,{registered=[],cellM=50,maxCandidates=3,minSupport=1}={}){
  const plane=planeOf(groups),evidence=evidenceOf(groups,plane),cells=supportMap(evidence,cellM);
  const spots=registered.map(place=>({id:place.id,...plane.to(place)}));
  // The candidates: the best region, then the best of what the groups behind it leave, and so on.
  const candidates=[];
  for(let left=evidence;left.length&&candidates.length<maxCandidates;){
    const found=peakOf(left===evidence?cells:supportMap(left,cellM),cellM);
    if(!found||found.peak<minSupport-EPSILON)break;
    const behind=left.filter(item=>Math.hypot(found.x-item.x,found.y-item.y)-item.uncertaintyM<=REACH_M);
    const nearest=spots.map(spot=>({id:spot.id,distanceM:Math.round(Math.hypot(found.x-spot.x,found.y-spot.y))})).sort((a,b)=>a.distanceM-b.distanceM)[0]??null;
    candidates.push({rank:candidates.length+1,...plane.from(found),support:round2(found.peak),radiusM:Math.round(radiusOf(found.areaM2)),groupIds:behind.map(item=>item.id),nearest,
      unregistered:found.peak>=HUB_SUPPORT-EPSILON&&(!nearest||nearest.distanceM>REACH_M)});
    left=left.filter(item=>!behind.includes(item));
  }
  const peak=Math.max(0,...cells.values());
  const places=spots.map(spot=>{
    const support=supportAt(evidence,spot.x,spot.y);
    // Everything supported at least as well is searched first (or as likely): ties count in full.
    let count=0;
    if(support>EPSILON)for(const value of cells.values())if(value>=support-EPSILON)count++;
    // To 10m: the cells make a 500m circle a few metres more or less.
    const searchRadiusM=count?Math.round(radiusOf(count*cellM*cellM)/10)*10:null;
    const near=candidates.map(candidate=>({rank:candidate.rank,distanceM:Math.round(Math.hypot(plane.to(candidate).x-spot.x,plane.to(candidate).y-spot.y))})).sort((a,b)=>a.distanceM-b.distanceM)[0]??null;
    return {id:spot.id,support:round2(support),share:peak?round2(support/peak):0,searchAreaKm2:count?round2(count*cellM*cellM/1e6):null,searchRadiusM,verdict:verdictOf(searchRadiusM),candidate:near};
  });
  return {evidence:evidence.length,peak:round2(peak),candidates,places};
}

// What each group does for the search: the search radius of a registered place with that group
// left out (as if every clue in it were covered). The group whose absence widens the search most
// comes first; null means the search no longer reaches the place.
export function influenceOf(groups,placeId,options={}){
  const radius=list=>attack(list,options).places.find(place=>place.id===placeId)?.searchRadiusM??null;
  const before=radius(groups),far=value=>value===null?Infinity:value;
  return groups.filter(group=>unitOfL(group.L)).map(group=>{
    const without=radius(groups.filter(other=>other!==group));
    return {groupId:group.id,name:group.name,searchRadiusM:without,verdict:verdictOf(without).key,widensM:without===null||before===null?null:without-before};
  }).sort((a,b)=>far(b.searchRadiusM)-far(a.searchRadiusM)).filter(item=>far(item.searchRadiusM)>far(before));
}
// Sentences for a registered place (no position in them).
export function attackerLines(result,placeId){
  const place=result.places.find(item=>item.id===placeId);
  if(!place)return [];
  if(place.searchRadiusM===null)return ['사진에 드러난 장소만으로는 등록한 장소 근처를 가리키지 못해요.'];
  const size=place.searchRadiusM>=1000?`${round1(place.searchRadiusM/1000)}km`:`${place.searchRadiusM}m`;
  const lines=[`사진에 드러난 장소만 모아 보면, 등록한 장소를 반경 약 ${size} 범위 안으로 좁힐 수 있어요.`];
  const hubs=result.candidates.filter(candidate=>candidate.unregistered).length;
  if(hubs)lines.push(`등록하지 않은 곳 중에도 자주 드러나는 지역이 ${hubs}곳 있어요.`);
  return lines;
}
