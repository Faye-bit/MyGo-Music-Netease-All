import test from 'node:test';
import assert from 'node:assert/strict';
import {setup, response, basic, song, list, deferred} from './helpers.mjs';

const complete = id => ({...song(id), al:{id:3,name:'Album',picUrl:`http://p1.music.126.net/cover-${id}.jpg`},privilege:{st:0,pl:320000}});
function feeds(call) {
  if(call.path==='/api/v3/discovery/recommend/songs')return response({code:200,data:{dailySongs:[complete(3),complete(1),complete(2)]}});
  if(call.path==='/api/v1/discovery/recommend/resource')return response({code:200,recommend:[list(7,{picUrl:'http://p1.music.126.net/personal.jpg'})]});
  if(call.path==='/api/personalized/playlist')return response({code:200,result:[list(8)]});
  if(call.path==='/api/v6/playlist/detail')return response({code:200,playlist:list(3136952023,{coverImgUrl:'http://p1.music.126.net/radar.jpg',trackIds:[],tracks:[]})});
  return basic(call);
}
const count = (s,path) => s.calls.filter(c=>c.path===path).length;

test('home leads with real ordered daily tracks, reuses data, and never consumes radio for artwork',async()=>{
  const s=await setup(feeds);
  const home=await s.plugin.home();
  assert.deepEqual(Array.from(home.sections[0].tracks,t=>t.id),['3','1','2']);
  assert.equal(home.sections[0].tracks[0].album.imageUrl,'https://p1.music.126.net/cover-3.jpg');
  assert.equal(home.sections[0].morePage,undefined); // native detail uses this exact section
  assert.equal(home.sections[1].links[0].imageUrl,'https://p1.music.126.net/radar.jpg');
  assert.equal(home.sections[3].playlists[0].id,'7');
  const detail=await s.plugin.browse({page:'daily'});
  assert.deepEqual(detail.sections[0].tracks,home.sections[0].tracks);
  await s.plugin.home();await s.plugin.stations();await s.plugin.browse({page:'recommendations'});
  assert.equal(count(s,'/api/v3/discovery/recommend/songs'),1);
  assert.equal(count(s,'/api/v1/discovery/recommend/resource'),1);
  assert.equal(count(s,'/api/v3/song/detail'),0);
  assert.equal(count(s,'/api/v1/radio/get'),0);
  assert.equal(home.sections[1].links.some(link=>link.title==='刷新首页推荐'),false);
  const coverNames=['roam','familiar','explore'];
  assert.deepEqual(Array.from(home.sections[2].stations,st=>new URL(st.imageUrl).pathname.split('/').pop()),coverNames.map(n=>n+'.png'));
  assert(home.sections[2].stations.every(st=>st.imageUrl.startsWith('file:///mock/MyGo%20Music/')));
  assert(home.sections[1].links.find(link=>link.page==='charts').imageUrl.endsWith('/assets/charts.png'));
});

test('anonymous home labels ordinary content and makes no private requests',async()=>{
  const s=await setup(feeds,{initial:null});
  const h=await s.plugin.home();
  assert.match(h.sections[0].empty,/登录/);
  assert.match(h.sections[3].title,/普通推荐（未登录）/);
  assert.equal(h.sections[3].playlists[0].id,'8');
  assert.deepEqual(s.calls.map(c=>c.path),['/api/personalized/playlist']);
  await assert.rejects(s.plugin.browse({page:'daily'}),e=>e.code==='signIn');
});

test('recommendation failures and empty results stay isolated and failed loads retry',async()=>{
  let broken=true;
  const s=await setup(c=>c.path==='/api/v1/discovery/recommend/resource'&&broken?response({code:429}):feeds(c));
  const h=await s.plugin.home();
  assert.equal(h.sections[0].tracks.length,3);assert.equal(h.sections[3].playlists.length,0);
  assert.match(h.sections[3].empty,/无法加载/);
  broken=false;assert.equal((await s.plugin.home()).sections[3].playlists.length,1);
  const empty=await setup(c=>c.path==='/api/v3/discovery/recommend/songs'?response({code:200,data:{dailySongs:[]}}):feeds(c));
  assert.match((await empty.plugin.home()).sections[0].empty,/没有返回/);
  const bad=await setup(c=>c.path==='/api/v3/discovery/recommend/songs'?response({code:200}):feeds(c));
  assert.match((await bad.plugin.home()).sections[0].empty,/无法加载/);
  const dailyDown=await setup(c=>c.path==='/api/v3/discovery/recommend/songs'?response({code:500}):feeds(c));
  const partial=await dailyDown.plugin.home();assert.equal(partial.sections[3].playlists.length,1);assert.equal(partial.sections[2].stations.length,3);
});

test('simultaneous home and daily loads merge requests and cap feed concurrency at two',async()=>{
  let active=0,max=0;
  const s=await setup(async c=>{
    if(c.path!=='/api/nuser/account/get') {active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;}
    return feeds(c);
  });
  await s.plugin.account();
  await Promise.all([s.plugin.home(),s.plugin.home(),s.plugin.browse({page:'daily'})]);
  assert.equal(max,2);
  assert.equal(count(s,'/api/v3/discovery/recommend/songs'),1);
  assert.equal(count(s,'/api/v1/discovery/recommend/resource'),1);
  assert.equal(count(s,'/api/v6/playlist/detail'),1);
});

test('only incomplete daily details are fetched once and original order survives',async()=>{
  const s=await setup(c=>c.path==='/api/v3/discovery/recommend/songs'?response({code:200,data:{dailySongs:[complete(9),song(4),complete(2),song(4)]}}):feeds(c));
  const h=await s.plugin.home();await s.plugin.browse({page:'daily'});
  assert.deepEqual(Array.from(h.sections[0].tracks,t=>t.id),['9','4','2']);
  const details=s.calls.filter(c=>c.path==='/api/v3/song/detail');
  assert.equal(details.length,1);assert.deepEqual(JSON.parse(details[0].params.c),[{id:4}]);
});

test('daily cache crosses China midnight by rereading server, without assuming changed data',async()=>{
  const s=await setup(feeds);
  await s.plugin.home();
  const now=1800000000000,day=86400000;
  const toMidnight=day-((now+8*3600000)%day);
  s.advance(toMidnight-1);await s.plugin.home();
  assert.equal(count(s,'/api/v3/discovery/recommend/songs'),1);
  s.advance(2);await s.plugin.home();
  assert.equal(count(s,'/api/v3/discovery/recommend/songs'),2);
});

test('playlist TTL and manual page/setting refresh invalidate recommendation caches',async()=>{
  const s=await setup(feeds);await s.plugin.home();s.advance(300001);await s.plugin.home();
  assert.equal(count(s,'/api/v1/discovery/recommend/resource'),2);
  assert.equal(count(s,'/api/v3/discovery/recommend/songs'),1);
  await s.plugin.browse({page:'home-refresh:test'});
  assert.equal(count(s,'/api/v3/discovery/recommend/songs'),2);
  await s.plugin.setSetting({key:'refreshHome',value:'refresh'});await s.plugin.home();
  assert.equal(count(s,'/api/v3/discovery/recommend/songs'),3);
});

test('refresh supersedes pending daily result and does not poison its replacement',async()=>{
  const started=deferred(),late=deferred();let first=true;
  const s=await setup(c=>{
    if(c.path==='/api/v3/discovery/recommend/songs'&&first){first=false;started.resolve();return late.promise;}
    return feeds(c);
  });
  const old=s.plugin.browse({page:'daily'});const rejected=assert.rejects(old,e=>e.code==='cancelled');await started.promise;
  await s.plugin.setSetting({key:'refreshHome',value:'now'});
  const fresh=await s.plugin.browse({page:'daily'});
  late.resolve(response({code:200,data:{dailySongs:[complete(99)]}}));await rejected;
  assert.equal(fresh.sections[0].tracks[0].id,'3');
  assert.equal((await s.plugin.browse({page:'daily'})).sections[0].tracks[0].id,'3');
});

test('sign-out cancels late recommendation and clears account-owned cached content',async()=>{
  const started=deferred(),late=deferred();
  const s=await setup(c=>{if(c.path==='/api/v3/discovery/recommend/songs'){started.resolve();return late.promise;}return feeds(c);});
  const old=s.plugin.home();const rejected=assert.rejects(old,e=>e.code==='cancelled');await started.promise;
  await s.plugin.signOut();late.resolve(response({code:200,data:{dailySongs:[complete(99)]}}));await rejected;
  const guest=await s.plugin.home();assert.equal(guest.sections[0].tracks.length,0);assert.equal(guest.sections[3].playlists[0].id,'8');
});

test('session expiry reaches sign-in flow instead of becoming a successful empty home',async()=>{
  const s=await setup(c=>c.path==='/api/v1/discovery/recommend/resource'?response({code:301}):feeds(c));
  await assert.rejects(s.plugin.home(),e=>['signIn','cancelled'].includes(e.code));
  assert.equal(s.storage.has('session'),false);
});

test('changed profile invalidates daily and radar caches before the next accepted home',async()=>{
  let user=1;
  const s=await setup(c=>c.path==='/api/nuser/account/get'?response({code:200,profile:{userId:user,nickname:`Listener ${user}`}}):feeds(c));
  await s.plugin.home();user=2;s.advance(60001);
  await assert.rejects(s.plugin.home(),e=>e.code==='cancelled');
  await s.plugin.home();
  assert.equal(count(s,'/api/v3/discovery/recommend/songs'),2);
  assert.equal(count(s,'/api/v6/playlist/detail'),2);
});

test('station artwork does not consume first batch; duplicates terminate after bounded retries',async()=>{
  const s=await setup(c=>c.path==='/api/v1/radio/get'?response({code:200,data:[complete(1),complete(1),complete(2)]}):feeds(c));
  await s.plugin.home();await s.plugin.stations();assert.equal(count(s,'/api/v1/radio/get'),0);
  const first=await s.plugin.stationNext({id:'DEFAULT'});assert.deepEqual(Array.from(first,t=>t.id),['1','2']);
  assert.equal((await s.plugin.stationNext({id:'DEFAULT'})).length,0);
  assert.equal(count(s,'/api/v1/radio/get'),4);
  await s.plugin.stationNext({id:'DEFAULT'});assert.equal(count(s,'/api/v1/radio/get'),4);
  assert.equal((await s.plugin.stationNext({id:'EXPLORE'})).length,2);
});

test('overlapping station requests serialize and skip previously returned songs',async()=>{
  let n=0;
  const s=await setup(c=>c.path==='/api/v1/radio/get'?response({code:200,data:++n===1?[complete(1),complete(2)]:[complete(2),complete(3)]}):feeds(c));
  const [a,b]=await Promise.all([s.plugin.stationNext({id:'DEFAULT'}),s.plugin.stationNext({id:'DEFAULT'})]);
  assert.deepEqual(Array.from(a,t=>t.id),['1','2']);assert.deepEqual(Array.from(b,t=>t.id),['3']);
});

test('switching via QR rejects old daily response and reads new account recommendations',async()=>{
  const started=deferred(),late=deferred();let user=1;
  const s=await setup(c=>{
    if(c.path.endsWith('/unikey'))return response({code:200,unikey:'mock-switch'});
    if(c.path.endsWith('/client/login')){user=2;return response({code:803},['MUSIC_U=mock-second']);}
    if(c.path==='/api/nuser/account/get')return response({code:200,profile:{userId:user,nickname:`Listener ${user}`}});
    if(c.path==='/api/v3/discovery/recommend/songs'){
      if(user===1){started.resolve();return late.promise;}
      return response({code:200,data:{dailySongs:[complete(22)]}});
    }
    return feeds(c);
  });
  const old=s.plugin.browse({page:'daily'});const rejected=assert.rejects(old,e=>e.code==='cancelled');await started.promise;
  await s.plugin.signIn();late.resolve(response({code:200,data:{dailySongs:[complete(11)]}}));await rejected;
  const current=await s.plugin.home();assert.equal(current.sections[0].tracks[0].id,'22');
  assert.equal(s.storage.get('session').profile.id,'2');
});

test('station permission errors do not retry and sign-out cancels late radio batch',async()=>{
  const denied=await setup(c=>c.path==='/api/v1/radio/get'?response({code:403}):feeds(c));
  await assert.rejects(denied.plugin.stationNext({id:'DEFAULT'}),e=>e.code==='unavailable');
  assert.equal(count(denied,'/api/v1/radio/get'),1);
  const started=deferred(),late=deferred();
  const s=await setup(c=>{if(c.path==='/api/v1/radio/get'){started.resolve();return late.promise;}return feeds(c);});
  const old=s.plugin.stationNext({id:'DEFAULT'});const rejected=assert.rejects(old,e=>e.code==='cancelled');
  await started.promise;await s.plugin.signOut();late.resolve(response({code:200,data:[complete(1)]}));await rejected;
});

test('large incomplete daily batch still respects two concurrent feed requests',async()=>{
  let active=0,max=0;
  const s=await setup(async c=>{
    active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;
    if(c.path==='/api/v3/discovery/recommend/songs')return response({code:200,data:{dailySongs:Array.from({length:401},(_,i)=>song(i+1))}});
    return feeds(c);
  });
  await s.plugin.account();const h=await s.plugin.home();
  assert.equal(h.sections[0].tracks.length,401);assert.equal(max,2);
  assert.equal(count(s,'/api/v3/song/detail'),2);
});
