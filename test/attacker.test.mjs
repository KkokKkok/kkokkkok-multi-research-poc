// The virtual attacker (lib/attacker.mjs): what the places given away lead to, without the registered place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attack,influenceOf,believedOf,attackerLines,UNCERTAINTY_M } from '../lib/attacker.mjs';

const home={id:'home',lat:37.55,lon:126.91},DEG=111195,scale=Math.cos(37.5*Math.PI/180);
// A spot `north` and `east` metres from home.
const at=(north,east)=>({lat:home.lat+north/DEG,lon:home.lon+east/(DEG*scale)});
const place=(id,north,east,L=1,k=1)=>({id,name:id,centre:at(north,east),L,k});
const seen=(groups,registered=[home])=>attack(groups,{registered});
const metres=(a,b)=>Math.hypot((a.lat-b.lat)*DEG,(a.lon-b.lon)*DEG*scale);

test('where the attacker puts a place: the spot for a point, a grid cell otherwise',()=>{
  const centre=at(120,-340);
  assert.deepEqual(believedOf(centre,'point'),{...centre,uncertaintyM:0});
  for(const unit of ['few','city']){
    const believed=believedOf(centre,unit);
    assert.ok(metres(believed,centre)<=UNCERTAINTY_M[unit]+1);
    // Places of one cell stand at one spot: the same district said twice is one district.
    assert.deepEqual(believedOf({lat:believed.lat+1e-5,lon:believed.lon-1e-5},unit),believed);
  }
});

test('one place alone leads to 500m, 1km, 3km by its unit',()=>{
  const radius=L=>seen([place('a',150,100,L)]).places[0];
  assert.equal(radius(1).searchRadiusM,500);assert.equal(radius(1).verdict.key,'found');
  assert.equal(radius(0.6).searchRadiusM,1000);assert.equal(radius(0.6).verdict.key,'near');
  assert.equal(radius(0.2).searchRadiusM,3000);assert.equal(radius(0.2).verdict.key,'area');
});

test('nothing given away, or only far away: the place is not found',()=>{
  assert.equal(seen([place('a',100,100,0)]).places[0].verdict.key,'none');
  const far=seen([place('trip',40000,0)]);
  assert.equal(far.places[0].searchRadiusM,null);assert.equal(far.places[0].verdict.key,'none');
  assert.deepEqual(attackerLines(far,'home'),['사진에 드러난 장소만으로는 등록한 장소 근처를 가리키지 못해요.']);
});

test('places around the home narrow the search; places on one side do not',()=>{
  const around=seen([place('n',400,0),place('e',0,400),place('s',-400,0),place('w',0,-400)]);
  const oneSide=seen([place('a',0,400),place('b',60,420),place('c',-60,430)]);
  assert.ok(around.places[0].searchRadiusM<200);
  assert.ok(around.candidates[0].nearest.distanceM<60);
  assert.ok(oneSide.places[0].searchRadiusM>around.places[0].searchRadiusM*2);
  assert.ok(oneSide.candidates[0].nearest.distanceM>300);
  assert.match(attackerLines(around,'home')[0],/반경 약 \d+m 범위 안으로/);
});

test('covering the clues widens the search: point, then few, then city',()=>{
  const groups=L=>[place('n',400,0,L),place('e',0,400,L),place('s',-400,0,L),place('w',0,-400,L)];
  const [point,few,city]=[1,0.6,0.2].map(L=>seen(groups(L)).places[0].searchRadiusM);
  // (Districts stand on a fixed grid: places in neighbouring cells narrow the search to their border.)
  assert.ok(point<few&&few<city);
});

test('another well supported region is a centre of life nobody registered',()=>{
  const near=[place('n',300,0),place('e',0,300)],gym=[place('gym',9000,200,1,3),place('shop',9100,300)];
  const result=seen([...near,...gym]);
  assert.equal(result.candidates.length,2);
  const hub=result.candidates.find(candidate=>candidate.unregistered);
  assert.deepEqual(hub.groupIds.sort(),['gym','shop']);
  assert.ok(hub.nearest.distanceM>3000);
  // The better supported region is searched first: the home is reached after it.
  assert.equal(hub.rank,1);
  assert.ok(result.places[0].searchRadiusM>seen(near).places[0].searchRadiusM);
  // One place seen once, far away (a trip), is a candidate but not a centre of life.
  assert.equal(seen([...near,place('trip',40000,0)]).candidates.some(candidate=>candidate.unregistered),false);
  assert.match(attackerLines(result,'home')[1],/등록하지 않은 곳 중에도 자주 드러나는 지역이 1곳/);
});

test('a place seen on several days counts more',()=>{
  const once=seen([place('a',100,0,1,1)]).places[0],often=seen([place('a',100,0,1,3)]).places[0];
  assert.equal(once.support,1);assert.equal(often.support,1.75);
});

test('influence: the place whose absence widens the search most comes first',()=>{
  const groups=[place('n',400,0),place('e',0,400),place('s',-400,0),place('w',0,-400),place('far',0,2500)];
  const influence=influenceOf(groups,'home',{registered:[home]});
  assert.ok(influence.length>=4);
  assert.ok(['n','e','s','w'].includes(influence[0].groupId));
  assert.ok(influence[0].widensM>0);
  assert.equal(influence.some(item=>item.groupId==='far'&&item.widensM>influence[0].widensM),false);
});
