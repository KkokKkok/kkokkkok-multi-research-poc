// The viewer as one HTML file that opens without the server: double-click it.
//   node scripts/export-html.mjs                 every zone
//   node scripts/export-html.mjs G1 G5           these zones only
// The file holds what the server would serve: the zones, their analysis and map check, and the
// photos (made smaller). It is written to private-data/export/, which is not committed: it shows
// the photos and where they were taken, so think about who gets it.
// Leaflet and the map tiles still come from the internet when the file is opened.
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lab=resolve(process.env.KKOK_LAB_ROOT||'C:/KKokKKok/KkokKkok-Research-PoC/location-cue-lab');
const legacy=resolve(process.env.KKOK_LEGACY_ROOT||'C:/KKokKKok/KkokKkok-PoC');
const sharp=createRequire(resolve(legacy,'package.json'))('sharp');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const optional=path=>existsSync(path)?readJson(path):null;

const wanted=process.argv.slice(2),all=readJson(resolve(root,'private-data/zones.json'));
const zones=all.zones.filter(zone=>!wanted.length||wanted.includes(zone.id));
if(!zones.length){console.error('no such zone');process.exit(2);}
// Photos outside the chosen zones are left out, and so are the photos without a zone when only
// some zones are exported.
const data={zones:{...all,zones,singles:wanted.length?[]:all.singles},analysis:{},mapCheck:{},guess:{},masked:{},photos:{}};
const small=async file=>`data:image/jpeg;base64,${(await sharp(readFileSync(file)).rotate().resize({width:900,height:900,fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer()).toString('base64')}`;
for(const zone of zones){
  const directory=resolve(root,'private-data/zone-analysis',zone.id);
  data.analysis[zone.id]=optional(resolve(directory,'result.json'));
  data.mapCheck[zone.id]=optional(resolve(directory,'map-check.json'));
  data.guess[zone.id]=optional(resolve(root,'private-data/zone-guess',zone.id,'result.json'));
  for(const photo of zone.photos){
    data.photos[photo.runId]=await small(resolve(lab,'private-data/paper/images',`${photo.runId}.jpg`));
    const covered=resolve(root,'private-data/zone-guess',zone.id,'masked',`${photo.runId}.jpg`);
    if(data.guess[zone.id]&&existsSync(covered))data.masked[photo.runId]=await small(covered);
  }
}
// The viewer's own code, with the two things it asks the server for answered from the file.
const app=readFileSync(resolve(root,'public/app.js'),'utf8').replace(/\/masked\/\$\{[^}]+\}\/\$\{([^}]+)\}/g,(_,name)=>`\${DATA.masked[${name}]}`).replace(/\/photo\/\$\{([^}]+)\}/g,(_,name)=>`\${DATA.photos[${name}]}`);
const shim=`const DATA=JSON.parse(document.getElementById('data').textContent);
window.fetch=path=>{
  const zone=String(path).split('/').pop();
  const body=path==='/api/zones'?DATA.zones:String(path).startsWith('/api/analysis/')?DATA.analysis[zone]??null:String(path).startsWith('/api/map-check/')?DATA.mapCheck[zone]??null:String(path).startsWith('/api/guess/')?DATA.guess[zone]??null:null;
  return Promise.resolve({json:()=>Promise.resolve(body)});
};`;
const html=readFileSync(resolve(root,'public/index.html'),'utf8')
  .replace('<link rel="stylesheet" href="style.css">',()=>`<style>${readFileSync(resolve(root,'public/style.css'),'utf8')}</style>`)
  .replace('<script src="app.js"></script>',()=>`<script type="application/json" id="data">${JSON.stringify(data).replace(/</g,'\\u003c')}</script>\n<script>${shim}\n${app.replace(/<\/script/g,'<\\/script')}</script>`);
const directory=resolve(root,'private-data/export');
mkdirSync(directory,{recursive:true});
const file=resolve(directory,`kkok-zones${wanted.length?'-'+wanted.join('-'):''}.html`);
writeFileSync(file,html);
console.log(JSON.stringify({file,zones:zones.length,photos:Object.keys(data.photos).length,megabytes:Number((html.length/1048576).toFixed(1))}));
