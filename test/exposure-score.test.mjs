// The worked example of the rule document (§6 scenario 1 and §8): the numbers must come out as written there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score,sentences,suggestEdits,cover,residual,withoutHigh,capOther,repeatOf,weightOf } from '../lib/exposure-score.mjs';

const clue=(s,key,label,fixed=false)=>({s,targets:[key],label,fixed});
const interior=n=>clue(0.2,`interior-${n}`,'평범한 실내',true);
// 단골 카페: 5 days, a window reflecting a sign in 4 of 5 photos, an ordinary interior in all.
const regular={id:'regular',name:'창밖 간판이 보이는 카페',distanceM:800,photos:[1,2,3,4,5].map(n=>({id:`r${n}`,day:`2026-11-0${n}`,
  candidates:[interior(n),...(n<=4?[clue(0.6,'window-sign','창에 비친 간판')]:[])]}))};
// 미술관: the building's name and its look in one photo, two photos of artworks, one day.
const museum={id:'museum',name:'○○미술관 건물',distanceM:900,photos:[
  {id:'m1',day:'2026-11-07',candidates:[clue(1,'museum-name','건물명'),clue(0.6,'museum-look','특징적 외관')]},
  {id:'m2',day:'2026-11-07',candidates:[]},{id:'m3',day:'2026-11-07',candidates:[]}]};
const mart={id:'mart',name:'○○마트 로고',distanceM:300,photos:[{id:'k1',day:'2026-11-08',candidates:[clue(0.2,'mart-logo','체인 로고')]}]};
const cafe={id:'cafe',name:'○○카페 간판',distanceM:200,photos:[{id:'c1',day:'2026-11-09',candidates:[clue(1,'cafe-sign','상호 간판'),interior(9)]}]};
const groups=[regular,museum,mart,cafe];

test('repeat and distance weights',()=>{
  assert.deepEqual([1,2,3].map(repeatOf),[0,0.5,0.75]);
  assert.equal(Math.round(repeatOf(5)*100)/100,0.94);
  assert.deepEqual([300,500,800,2000,3500].map(weightOf),[1,1,0.8,0.5,0]);
});

test('scenario 1: A 0.45, m 2.48, B 0.82, S 90 (높음)',()=>{
  const result=score(groups);
  assert.equal(result.A,0.45);assert.equal(result.m,2.48);assert.equal(result.B,0.82);assert.equal(result.S,90);assert.equal(result.grade.key,'high');
  const lines=sentences(result,{noClue:2,noGps:0});
  assert.equal(lines[0].kind,'combination');
  assert.match(lines[0].text,/1km 안이라 함께 보면 생활권이 좁혀질 수 있어요/);
  assert.equal(lines[1].kind,'repeat');
  assert.match(lines[1].text,/사진 5장이 5일에 걸쳐/);
  assert.equal(lines.at(-1).text,'위치 단서가 없는 사진 2장은 계산에서 뺐어요.');
});

test('§8 first candidates: 81, 83, 88, 89',()=>{
  const after=(index,key)=>score(groups.map((group,j)=>j===index?cover(group,[key]):group)).S;
  assert.equal(after(0,'window-sign'),81);
  assert.equal(after(3,'cafe-sign'),83);
  assert.equal(after(1,'museum-name'),88);
  assert.equal(after(2,'mart-logo'),89);
});

// A place whose name gives it away in one photo, while two chains seen in two different photos give
// it away together too (a combination across photos, from the zone analysis): covering the name is
// not enough once the photos are read together.
const name=clue(1,'shop-name','상호 간판'),chainA=clue(0.2,'chain-a','체인 A 로고'),chainB=clue(0.2,'chain-b','체인 B 로고');
const shop={id:'shop',name:'○○가게',distanceM:200,photos:[
  {id:'p1',index:1,day:'2026-11-01',candidates:[name,chainA]},
  {id:'p2',index:2,day:'2026-11-02',candidates:[chainB]}],
  cross:[{s:0.6,requires:[['chain-a'],['chain-b']],labels:['체인 A 로고','체인 B 로고'],label:'체인 A + 체인 B',photos:[1,2]}]};

test('place layer: a combination across photos counts only when asked for',()=>{
  assert.equal(score([shop]).groups[0].L,1);
  const covered=cover(shop,['shop-name']);
  assert.equal(score([covered]).groups[0].L,0.2);
  const withCross=score([covered],{cross:true}).groups[0];
  assert.equal(withCross.L,0.6);assert.equal(withCross.crossLifts,true);
  assert.equal(score([cover(covered,['chain-b'])],{cross:true}).groups[0].L,0.2);
});

test('edit loop: the warning, then the combination\'s member as the next edit',()=>{
  const steps=suggestEdits([shop]);
  assert.equal(steps[0].label,'상호 간판');
  assert.equal(steps[0].LAfter,0.2);assert.equal(steps[0].LCrossAfter,0.6);
  assert.match(steps[0].warning,/사진 1·2을\(를\) 함께 보면 체인 A \+ 체인 B\(으\)로 여전히 몇 곳까지/);
  assert.ok(steps[1].keys.some(key=>key.startsWith('chain-')));
  assert.ok(steps[1].LCrossAfter<0.6);assert.equal(steps[1].warning,undefined);
  // Without the combinations across photos the loop stops once the document's score is low.
  assert.equal(suggestEdits([shop],{cross:false}).length,1);
});

test('residual: the document\'s plan, read with the combinations across photos',()=>{
  const left=residual([shop]);
  assert.equal(left.steps,1);
  assert.ok(left.SCross>left.S);
  assert.deepEqual(left.reopened.map(group=>[group.groupId,group.L,group.ownL]),[['shop',0.6,0.2]]);
});

test('without the clues that are high alone',()=>{
  // The shop's name goes; the chains stay, and read together they give the place away again.
  const [left]=withoutHigh([shop]);
  assert.deepEqual(left.covered,['shop-name']);
  assert.equal(score([left]).groups[0].L,0.2);
  assert.equal(score([left],{cross:true}).groups[0].L,0.6);
  // The document's example: the museum's name and the café's sign go, the window sign stays.
  const S=score(withoutHigh(groups)).groups.map(group=>group.L);
  assert.deepEqual(S,[0.6,0.6,0.2,0.2]);
});

test('"other" combinations: one unit narrower at most, never a point until verified',()=>{
  assert.deepEqual(capOther('point',['few','city']),{unit:'few',capped:true});
  assert.deepEqual(capOther('point',['city','city']),{unit:'few',capped:true});
  assert.deepEqual(capOther('few',['city','city']),{unit:'few',capped:false});
  assert.deepEqual(capOther('few',['country','country']),{unit:'city',capped:true});
  assert.deepEqual(capOther('point',['few','city'],{verified:true}),{unit:'point',capped:false});
});

test('§8 greedy order: 81, 67, 59, 42, 34',()=>{
  const steps=suggestEdits(groups);
  assert.deepEqual(steps.map(step=>step.SAfter),[81,67,59,42,34]);
  assert.deepEqual(steps.map(step=>step.groupId),['regular','cafe','museum','museum','mart']);
  assert.equal(steps[0].photos,4);
  assert.equal(steps.at(-1).grade,'low');
});
