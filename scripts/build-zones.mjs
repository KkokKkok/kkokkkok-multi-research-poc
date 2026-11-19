// Builds private-data/zones.json: the 100m GPS zones of the stored photos, with each photo's
// position and clues. The file holds coordinates, so it stays in private-data (not committed)
// and is only served to this machine by server.mjs.
//
// Reads from the single-photo research repo (KkokKkok-Research-PoC/location-cue-lab):
//   private-data/paper/batches/all-photos.json          folder, index, file, runId of each photo
//   private-data/paper/batches/gps-clusters-100m.json   zone membership (complete linkage, 100m)
//   private-data/paper/runs/<runId>.json                clues with their rule judgement
//   private-data/new-photos/<folder>/<file>             originals, for the EXIF position
// sharp and exif-reader are loaded from the earlier runtime's node_modules, as the lab does.
//   KKOK_LAB_ROOT     default C:/KKokKKok/KkokKkok-Research-PoC/location-cue-lab
//   KKOK_LEGACY_ROOT  default C:/KKokKKok/KkokKkok-PoC
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lab=resolve(process.env.KKOK_LAB_ROOT||'C:/KKokKKok/KkokKkok-Research-PoC/location-cue-lab');
const legacy=resolve(process.env.KKOK_LEGACY_ROOT||'C:/KKokKKok/KkokKkok-PoC');
const need=createRequire(resolve(legacy,'package.json')),sharp=need('sharp'),exifReader=need('exif-reader');
const paper=resolve(lab,'private-data/paper');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));

function gpsOf(exif){
  if(!exif)return null;
  try{
    const g=exifReader(exif).GPSInfo;
    // Same checks as the lab's parseGps (location-experiment.mjs), so both count the same photos.
    if(!g||g.GPSStatus==='V'||(g.GPSMapDatum&&g.GPSMapDatum.replace(/[\s-]/g,'').toUpperCase()!=='WGS84'))return null;
    const valid=(a,ref,refs,max)=>Array.isArray(a)&&a.length===3&&a.every(x=>Number.isFinite(x)&&x>=0)&&a[1]<60&&a[2]<60&&refs.includes(ref)&&a[0]+a[1]/60+a[2]/3600<=max;
    if(!valid(g.GPSLatitude,g.GPSLatitudeRef,['N','S'],90)||!valid(g.GPSLongitude,g.GPSLongitudeRef,['E','W'],180))return null;
    const degrees=(a,negative)=>(a[0]+a[1]/60+a[2]/3600)*(negative?-1:1);
    const lat=degrees(g.GPSLatitude,g.GPSLatitudeRef==='S'),lon=degrees(g.GPSLongitude,g.GPSLongitudeRef==='W');
    return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
  }catch{return null;}
}
export function haversineM(a,b){
  const rad=Math.PI/180,dLat=(b.lat-a.lat)*rad,dLon=(b.lon-a.lon)*rad;
  const h=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLon/2)**2;
  return 2*6371008.8*Math.asin(Math.sqrt(h));
}
// A clue as the zone analysis needs it. risk: the rule sheet's (high, medium, low) or null when the
// record was never judged by it; tier: the older category tier (A, B, C).
const clueOf=(clue,number)=>({id:clue.id,number,taxonomy:clue.taxonomy?.name||clue.category,risk:clue.rule?.risk||null,unit:clue.rule?.unit||null,ruleClass:clue.rule?.class||null,basis:clue.rule?.basis||null,tier:clue.risk?.tier||null,texts:clue.textTargets||[],detail:clue.detail});

const all=readJson(resolve(paper,'batches/all-photos.json')).photos;
const clusters=readJson(resolve(paper,'batches/gps-clusters-100m.json'));
const zoneOfRun=new Map();
clusters.clusters.forEach((cluster,index)=>cluster.photos.forEach(photo=>zoneOfRun.set(photo.runId,index)));

// The day a photo was taken (EXIF DateTimeOriginal, as the camera wrote it: "2026-11-03"), or null.
// Only the date is kept: the visit count of the exposure score needs no more.
function dayOf(exif){
  if(!exif)return null;
  try{
    const tags=exifReader(exif),value=tags.Photo?.DateTimeOriginal??tags.Image?.DateTime??null;
    return value instanceof Date&&!Number.isNaN(value.getTime())?value.toISOString().slice(0,10):null;
  }catch{return null;}
}

const zones=clusters.clusters.map((cluster,index)=>({id:`G${index}`,name:cluster.name,maxPairM:cluster.maxPairM,photos:[]})),singles=[];
let withoutGps=0;
const withoutGpsByFolder={};
for(const photo of all){
  const exif=photo.file?(await sharp(readFileSync(resolve(lab,'private-data/new-photos',photo.folder,photo.file))).metadata()).exif:null;
  const gps=gpsOf(exif);
  if(!gps){withoutGps++;withoutGpsByFolder[photo.folder]=(withoutGpsByFolder[photo.folder]??0)+1;continue;}
  const run=readJson(resolve(paper,'runs',`${photo.runId}.json`));
  const entry={label:`${photo.folder} ${photo.index}`,folder:photo.folder,index:photo.index,runId:photo.runId,...gps,day:dayOf(exif),judged:run.clues.some(clue=>clue.rule),clues:run.clues.map(clueOf)};
  if(zoneOfRun.has(photo.runId))zones[zoneOfRun.get(photo.runId)].photos.push(entry);else singles.push(entry);
}
for(const zone of zones){
  const center={lat:zone.photos.reduce((sum,p)=>sum+p.lat,0)/zone.photos.length,lon:zone.photos.reduce((sum,p)=>sum+p.lon,0)/zone.photos.length};
  zone.center=center;zone.radiusM=Math.max(...zone.photos.map(p=>haversineM(center,p)));
  zone.folder=zone.photos[0].folder;
}
mkdirSync(resolve(root,'private-data'),{recursive:true});
writeFileSync(resolve(root,'private-data/zones.json'),JSON.stringify({createdAt:new Date().toISOString(),radiusM:clusters.radiusM,linkage:clusters.linkage,zones,singles,withoutGpsByFolder},null,1));
console.log(JSON.stringify({zones:zones.length,photosInZones:zones.reduce((sum,zone)=>sum+zone.photos.length,0),singles:singles.length,withoutGps}));
