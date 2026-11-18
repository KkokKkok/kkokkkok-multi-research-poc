// Kakao Local API, as far as the map check needs it: an area's centre, every place of a kind inside
// a rectangle, and the places of a kind around a point. The key is KAKAO_REST_API_KEY (the lab's
// .env); it is sent to dapi.kakao.com only. Nothing here knows where a photo was taken.
// A kind of place is {brand, categoryGroup, keyword, categoryIncludes}:
//   brand            a chain's name as a clue states it ("GS25"): searched by name, and a place counts
//                    only when its name or category holds that name
//   categoryGroup    a Kakao category group code (SC4 ...): the whole group is listed
//   keyword          a search word for kinds without a group ("옷가게")
//   categoryIncludes words of which one must be in the place's category name
const BASE='https://dapi.kakao.com/v2/local/';
const plain=text=>String(text).toLowerCase().replace(/[\s·.\-_]/g,'');
export function kakao(env=process.env){
  const key=env.KAKAO_REST_API_KEY;
  if(!key)throw Object.assign(new Error('KAKAO_REST_API_KEY is not set (the lab .env)'),{code:'no_kakao_key'});
  let calls=0;
  async function get(path,query){
    const url=new URL(BASE+path);
    for(const [name,value] of Object.entries(query))if(value!==null&&value!==undefined)url.searchParams.set(name,String(value));
    for(let attempt=0;;attempt++){
      calls++;
      const response=await fetch(url,{headers:{Authorization:`KakaoAK ${key}`}});
      if(response.ok)return response.json();
      if(response.status>=500&&attempt<2){await new Promise(done=>setTimeout(done,500*(attempt+1)));continue;}
      throw Object.assign(new Error(`kakao ${path} ${response.status}`),{code:'kakao_failed',status:response.status});
    }
  }
  const place=doc=>({id:doc.id,name:doc.place_name,category:doc.category_name,address:doc.address_name,lat:Number(doc.y),lon:Number(doc.x),...(doc.distance!==''&&doc.distance!==undefined?{distanceM:Number(doc.distance)}:{})});
  const search=(kind,where)=>kind.brand
    ?get('search/keyword.json',{query:kind.brand,category_group_code:kind.categoryGroup||null,size:15,...where})
    :kind.categoryGroup
      ?get('search/category.json',{category_group_code:kind.categoryGroup,size:15,...where})
      :get('search/keyword.json',{query:kind.keyword,size:15,...where});
  const fits=kind=>item=>(!kind.brand||plain(item.name).includes(plain(kind.brand))||plain(item.category).includes(plain(kind.brand)))
    &&(!kind.categoryIncludes?.length||kind.categoryIncludes.some(word=>item.category.includes(word)));
  async function pages(kind,where,stop=()=>false){
    const found=[];
    for(let page=1;page<=3;page++){
      const body=await search(kind,{...where,page});
      found.push(...body.documents.map(place));
      if(body.meta.is_end||stop(found))break;
    }
    return found;
  }
  const rect=([west,south,east,north])=>({rect:`${west},${south},${east},${north}`});
  return {
    get calls(){return calls;},
    // The centre of an administrative area written as text ("서울 마포구"), or null.
    async area(name){
      const doc=(await get('search/address.json',{query:name,size:5})).documents.find(item=>item.address_type==='REGION');
      return doc?{name:doc.address_name,lat:Number(doc.y),lon:Number(doc.x),depth:doc.address.region_3depth_name?3:doc.address.region_2depth_name?2:1}:null;
    },
    // About how many places of the kind the rectangle holds: what one query reports, before the
    // kind's own filters. Enough to tell a rare kind from a common one.
    async count(kind,box){return (await search(kind,{...rect(box),page:1})).meta.total_count;},
    // Every place of the kind inside the rectangle. A query returns 45 places at most, so a
    // rectangle holding more is split in four until each part holds 45 or fewer.
    async within(kind,box){
      const byId=new Map();
      async function walk(part,depth){
        const [west,south,east,north]=part,first=await search(kind,{...rect(part),page:1});
        if(first.meta.total_count>45&&depth<12){
          const x=(west+east)/2,y=(south+north)/2;
          for(const quarter of [[west,south,x,y],[x,south,east,y],[west,y,x,north],[x,y,east,north]])await walk(quarter,depth+1);
          return;
        }
        const found=first.documents.map(place);
        if(!first.meta.is_end)for(let page=2;page<=3;page++){const body=await search(kind,{...rect(part),page});found.push(...body.documents.map(place));if(body.meta.is_end)break;}
        for(const item of found)byId.set(item.id,item);
      }
      await walk(box,0);
      return [...byId.values()].filter(fits(kind));
    },
    // The places of the kind within `radiusM` of a point, nearest first (up to 45 are looked at).
    async around(kind,{lat,lon},radiusM){
      const ok=fits(kind);
      return (await pages(kind,{x:lon,y:lat,radius:radiusM,sort:'distance'},found=>found.some(ok))).filter(ok);
    },
  };
}
export function metres(a,b){
  const rad=Math.PI/180,dLat=(b.lat-a.lat)*rad,dLon=(b.lon-a.lon)*rad,h=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLon/2)**2;
  return 2*6371000*Math.asin(Math.sqrt(h));
}
