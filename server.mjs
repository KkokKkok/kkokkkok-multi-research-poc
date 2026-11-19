// Local viewer for the GPS zones. Serves this machine only (127.0.0.1): the data has the photos'
// coordinates and the photos themselves.
//   node server.mjs            http://localhost:3020
//   PORT=3021 node server.mjs   or   node server.mjs --port 3021
import { createServer } from 'node:http';
import { readFileSync,existsSync,readdirSync } from 'node:fs';
import { resolve,dirname,extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));
const lab=resolve(process.env.KKOK_LAB_ROOT||'C:/KKokKKok/KkokKkok-Research-PoC/location-cue-lab');
const portArg=process.argv.indexOf('--port');
const port=Number(portArg>0?process.argv[portArg+1]:process.env.PORT||3020);
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const send=(response,status,type,body)=>{response.writeHead(status,{'content-type':type,'cache-control':'no-store'});response.end(body);};

createServer((request,response)=>{
  const path=new URL(request.url,'http://localhost').pathname;
  if(path==='/api/zones'){
    const file=resolve(root,'private-data/zones.json');
    return existsSync(file)?send(response,200,'application/json; charset=utf-8',readFileSync(file)):send(response,404,'application/json','{"error":"run `npm run zones` first"}');
  }
  // The cumulative analysis of one zone (scripts/analyze-zone.mjs), or null when it was not run yet.
  const analysis=path.match(/^\/api\/analysis\/(G\d+)$/);
  if(analysis){
    const file=resolve(root,'private-data/zone-analysis',analysis[1],'result.json');
    return send(response,200,'application/json; charset=utf-8',existsSync(file)?readFileSync(file):'null');
  }
  // The map check of the zone's combinations (scripts/verify-zone.mjs), or null.
  const mapCheck=path.match(/^\/api\/map-check\/(G\d+)$/);
  if(mapCheck){
    const file=resolve(root,'private-data/zone-analysis',mapCheck[1],'map-check.json');
    return send(response,200,'application/json; charset=utf-8',existsSync(file)?readFileSync(file):'null');
  }
  // The exposure score of every person (scripts/score-exposure.mjs): [result], empty when not run yet.
  if(path==='/api/exposure'){
    const directory=resolve(root,'private-data/exposure');
    const results=existsSync(directory)?readdirSync(directory).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(resolve(directory,name),'utf8'))):[];
    return send(response,200,'application/json; charset=utf-8',JSON.stringify(results));
  }
  const photo=path.match(/^\/photo\/([0-9a-f-]{36})$/);
  if(photo){
    const file=resolve(lab,'private-data/paper/images',`${photo[1]}.jpg`);
    return existsSync(file)?send(response,200,'image/jpeg',readFileSync(file)):send(response,404,'text/plain','not found');
  }
  const name=path==='/'?'index.html':path.slice(1);
  const file=resolve(root,'public',name);
  if(!/^[\w.-]+$/.test(name)||!existsSync(file))return send(response,404,'text/plain','not found');
  send(response,200,TYPES[extname(file)]||'application/octet-stream',readFileSync(file));
}).listen(port,'127.0.0.1',()=>console.log(`zone viewer: http://localhost:${port}`));
