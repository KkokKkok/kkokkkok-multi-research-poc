// Estimates each person's registered place from their photo folder (lib/places.mjs) and writes
// private-data/places.json. A stand-in until the places are read from the database.
//   node scripts/estimate-places.mjs
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimatePlaces } from '../lib/places.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const zones=JSON.parse(readFileSync(resolve(root,'private-data/zones.json'),'utf8'));
const estimate=estimatePlaces([...zones.zones.flatMap(zone=>zone.photos),...zones.singles]);
writeFileSync(resolve(root,'private-data/places.json'),JSON.stringify({createdAt:new Date().toISOString(),...estimate},null,1));
const noGps=Object.keys(zones.withoutGpsByFolder??{}).filter(folder=>!estimate.places.some(place=>place.folder===folder));
console.log(JSON.stringify({source:estimate.source,places:estimate.places.map(place=>`${place.folder} (${place.kind}, 사진 ${place.estimatedFrom.photos}장)`),notEstimated:noGps}));
