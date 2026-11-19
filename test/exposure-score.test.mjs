// The worked example of the rule document (§6 scenario 1 and §8): the numbers must come out as written there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score,sentences,suggestEdits,cover,repeatOf,weightOf } from '../lib/exposure-score.mjs';

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

test('§8 greedy order: 81, 67, 59, 42, 34',()=>{
  const steps=suggestEdits(groups);
  assert.deepEqual(steps.map(step=>step.SAfter),[81,67,59,42,34]);
  assert.deepEqual(steps.map(step=>step.groupId),['regular','cafe','museum','museum','mart']);
  assert.equal(steps[0].photos,4);
  assert.equal(steps.at(-1).grade,'low');
});
