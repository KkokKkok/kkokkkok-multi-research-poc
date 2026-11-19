// The places a person registered (home, school, work), which the exposure score measures groups against.
// For now they are estimated from the photo folders (one folder = one person and one registered
// place: "집_합정", "학교", "회사_충무로"). Later they come from the database; whatever the source,
// loadPlaces returns the same shape:
//   {source, places:[{id, folder, kind: home|school|work, name, lat, lon, estimatedFrom}]}
// The file holds coordinates: it stays in private-data and is never shown on screen.
import { readFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { metres } from './kakao.mjs';

const KIND=[[/^집/,'home','집'],[/^학교/,'school','학교'],[/^회사/,'work','회사']];
export const kindOf=folder=>{const found=KIND.find(([pattern])=>pattern.test(folder));return found?{kind:found[1],ko:found[2]}:null;};

// Estimate: the folder's photo that is nearest, in total, to all the others (the medoid). One far
// photo (a trip) does not move it, and it is always a spot the person actually was. It is a stand-in:
// a home is near the photos taken around it, not necessarily at their middle.
export function estimatePlaces(photos){
  const byFolder=Map.groupBy(photos.filter(photo=>kindOf(photo.folder)),photo=>photo.folder),places=[];
  for(const [folder,items] of byFolder){
    const medoid=items.reduce((best,photo)=>{
      const total=items.reduce((sum,other)=>sum+metres(photo,other),0);
      return !best||total<best.total?{photo,total}:best;
    },null).photo;
    const {kind,ko}=kindOf(folder);
    places.push({id:folder,folder,kind,name:folder.replace(/_/g,' '),kindKo:ko,lat:medoid.lat,lon:medoid.lon,estimatedFrom:{method:'medoid',photos:items.length}});
  }
  return {source:'folder-estimate',places};
}

// The registered places, from wherever they are kept. Only the folder estimate exists so far
// (scripts/estimate-places.mjs writes it); a database source goes here.
export function loadPlaces(root){
  const path=resolve(root,'private-data/places.json');
  if(!existsSync(path))throw Object.assign(new Error('private-data/places.json is missing: run `node scripts/estimate-places.mjs` first'),{code:'no_places'});
  return JSON.parse(readFileSync(path,'utf8'));
}
