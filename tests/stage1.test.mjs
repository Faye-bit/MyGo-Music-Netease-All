import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,response,deferred,signed,song,list,basic} from './helpers.mjs';
const json=v=>JSON.parse(JSON.stringify(v));
const rejectCode=code=>e=>e.code===code;
const qr=(code,cookies=[])=>response({code},cookies);
const loginHandler=({path},state)=>{
  if(path.endsWith('/unikey'))return response({code:200,unikey:'mock-key'});
  if(path.endsWith('/client/login'))return qr(803,['MUSIC_U=mock-new; Path=/; HttpOnly']);
  return basic({path});
};

test('standalone module exports the installed 22 capabilities plus a cancellation setting; no host call on load',async()=>{
  const {plugin}=await setup(basic);
  assert.deepEqual(Object.keys(plugin).sort(),['account','signIn','signOut','search','album','artist','playlists','playlist','addToPlaylist','removeFromPlaylist','liked','isLiked','like','home','browse','stations','stationNext','stream','lyrics','comments','shows','show','setSetting'].sort());
});

test('QR login waits for scan and confirmation, verifies profile, then persists',async()=>{
  let polls=0;
  const s=await setup((call,state)=>{
    assert.equal(state.storage.has('session'),false);
    if(call.path.endsWith('/client/login'))return ++polls<3?qr(polls===1?801:802):qr(803,['MUSIC_U=mock-new; Path=/','__csrf=mock-csrf; Path=/']);
    return loginHandler(call,state);
  },{initial:null});
  const profile=await s.plugin.signIn();
  assert.equal(profile.id,'1');
  assert.equal(s.storage.get('session').cookies.MUSIC_U,'mock-new');
  assert(s.prompts.some(p=>p.text.includes('已扫码')));
  assert.equal((await s.plugin.account()).id,'1');
});

test('QR expiry and missing valid cookie never persist a session',async()=>{
  for(const code of [800,803]){
    const s=await setup(call=>call.path.endsWith('/unikey')?response({code:200,unikey:'mock'}):qr(code),{initial:null});
    await assert.rejects(s.plugin.signIn(),code===800?rejectCode('expired'):/有效会话/);
    assert.equal(s.storage.has('session'),false);
  }
});

test('QR timeout includes delayed success and never persists',async()=>{
  let s;
  s=await setup(call=>{
    if(call.path.endsWith('/unikey'))return response({code:200,unikey:'mock'});
    s.advance(180001);return qr(803,['MUSIC_U=mock-new']);
  },{initial:null});
  await assert.rejects(s.plugin.signIn(),rejectCode('timeout'));
  assert.equal(s.storage.has('session'),false);
});

test('explicit cancel rejects late poll success; original session stays valid',async()=>{
  const polling=deferred(), result=deferred();
  const s=await setup(call=>{
    if(call.path.endsWith('/client/login')){polling.resolve();return result.promise;}
    return loginHandler(call);
  });
  const pending=s.plugin.signIn();
  await polling.promise;
  await s.plugin.browse({page:'cancel-sign-in'});
  result.resolve(qr(803,['MUSIC_U=must-not-save']));
  await assert.rejects(pending,rejectCode('cancelled'));
  assert.equal(s.storage.get('session').cookies.MUSIC_U,'mock-cookie');
});

test('sign-out during QR generation prevents a late QR prompt',async()=>{
  const key=deferred();
  const s=await setup(()=>key.promise,{initial:null});
  const pending=s.plugin.signIn();s.plugin.signOut();key.resolve(response({code:200,unikey:'mock'}));
  await assert.rejects(pending,rejectCode('cancelled'));
  assert.equal(s.prompts.some(p=>p.qr),false);
  assert.equal(s.storage.has('session'),false);
});

test('profile verification arriving after sign-out cannot sign in',async()=>{
  const started=deferred(), profile=deferred();
  const s=await setup(call=>{
    if(call.path==='/api/nuser/account/get'){started.resolve();return profile.promise;}
    return loginHandler(call);
  },{initial:null});
  const pending=s.plugin.signIn();await started.promise;s.plugin.signOut();
  profile.resolve(response({code:200,profile:{userId:2,nickname:'Other'}}));
  await assert.rejects(pending,rejectCode('cancelled'));
  assert.equal(s.storage.has('session'),false);
});

test('a new login wins over an older pending login',async()=>{
  const old=deferred();let keys=0;
  const s=await setup(call=>{
    if(call.path.endsWith('/unikey')&&++keys===1)return old.promise;
    return loginHandler(call);
  },{initial:null});
  const first=s.plugin.signIn();
  await s.plugin.signIn();
  old.resolve(response({code:200,unikey:'obsolete'}));
  await assert.rejects(first,rejectCode('cancelled'));
  assert.equal(s.storage.get('session').cookies.MUSIC_U,'mock-new');
});

test('session restores through host storage in a fresh runtime',async()=>{
  const a=await setup(loginHandler,{initial:null});await a.plugin.signIn();
  const b=await setup(basic,{initial:a.storage.get('session')});
  assert.equal((await b.plugin.account()).id,'1');
  assert.equal(b.calls.length,1);
});

test('content permissions keep the login; account auth failure clears it',async()=>{
  for(const code of [401,403]){
    const s=await setup(()=>response({code}));
    await assert.rejects(s.plugin.stream({id:'1'}),rejectCode('unavailable'));
    assert(s.storage.has('session'));
  }
  const s=await setup(()=>response({code:401}));
  assert.equal(await s.plugin.account(),null);
  assert.equal(s.storage.has('session'),false);
});

test('session expiry cookies and HTTP account 401 clear the local session',async()=>{
  for(const handler of [()=>response({code:200,profile:{userId:1}},['MUSIC_U=; Max-Age=0']),()=>response({},[],401)]){
    const s=await setup(handler);assert.equal(await s.plugin.account(),null);assert.equal(s.storage.has('session'),false);
  }
});

test('late old-account responses cannot replace cookies or results',async()=>{
  const result=deferred();
  const s=await setup(()=>result.promise);
  const pending=s.plugin.search({query:'mock',kind:'albums'});s.plugin.signOut();
  result.resolve(response({code:200,result:{albums:[],albumCount:0}},['MUSIC_U=obsolete']));
  await assert.rejects(pending,rejectCode('cancelled'));assert.equal(s.storage.has('session'),false);
});

test('network, timeout and rate limit are classified; no blind read/write retry',async()=>{
  const net=await setup(()=>{throw Error('sensitive raw error');});
  await assert.rejects(net.plugin.search({query:'x'}),e=>e.code==='network'&&!e.message.includes('sensitive'));
  const timeout=await setup(({init})=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('abort')))),{timeout:true});
  await assert.rejects(timeout.plugin.search({query:'x'}),rejectCode('timeout'));
  const limit=await setup(()=>response({},[],429));
  await assert.rejects(limit.plugin.stream({id:'1'}),rejectCode('rateLimit'));assert.equal(limit.calls.length,1);
});

test('playlist directory handles short pages with more, overlaps and over 2000 entries',async()=>{
  const originals=Array.from({length:2405},(_,i)=>list(i+1,{creator:{userId:i%2?2:1},subscribed:!!(i%2)}));
  const offsets=[];
  const s=await setup(call=>{
    if(call.path!='/api/user/playlist')return basic(call);
    const offset=Number(call.params.offset);offsets.push(offset);
    const items=originals.slice(offset,offset+137);
    return response({code:200,playlist:items,more:offset+items.length<originals.length});
  });
  const result=await s.plugin.playlists();
  assert.deepEqual(json(result.map(x=>x.id)),originals.map(x=>String(x.id)));
  assert.equal(offsets[1],137);assert.equal(result[0].mine,true);assert.equal(result[1].saved,true);
});

test('repeating or empty pagination with more never reports a complete list',async()=>{
  for(const items of [[],[list(1)]]){
    const s=await setup(call=>call.path==='/api/user/playlist'?response({code:200,playlist:items,more:true}):basic(call));
    await assert.rejects(s.plugin.playlists(),/分页未前进/);
    assert(s.calls.length<=3);
  }
});

test('1203-track playlist is complete, ordered, and details use at most two workers',async()=>{
  const ids=Array.from({length:1203},(_,i)=>i+1);let active=0,max=0;
  const s=await setup(async call=>{
    if(call.path==='/api/v6/playlist/detail')return response({code:200,playlist:list(5,{trackCount:ids.length,trackIds:ids.map(id=>({id}))})});
    if(call.path==='/api/v3/song/detail'){
      active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;
      const batch=JSON.parse(call.params.c).map(x=>x.id);
      return response({code:200,songs:batch.reverse().map(song)});
    }
    return basic(call);
  });
  const result=await s.plugin.playlist({id:'5'});
  assert.deepEqual(result.tracks.map(x=>x.id),ids.map(String));assert.equal(max,2);
  assert.doesNotMatch(result.description,/未完整同步/);
});

test('missing detail entries retain their ordered slot and are marked unavailable',async()=>{
  const s=await setup(call=>call.path==='/api/v6/playlist/detail'?response({code:200,playlist:list(5,{trackCount:3,trackIds:[{id:1},{id:2},{id:3}]})}):response({code:200,songs:[song(3),song(1)]}));
  const result=await s.plugin.playlist({id:'5'});
  assert.deepEqual(result.tracks.map(x=>x.id),['1','2','3']);assert.equal(result.tracks[1].unavailable,true);
});

test('truncated ID list and safety bound display loaded/total with incomplete status',async()=>{
  for(const count of [3,10001]){
    const ids=Array.from({length:count===3?2:count},(_,i)=>({id:i+1}));
    const s=await setup(call=>call.path==='/api/v6/playlist/detail'?response({code:200,playlist:list(5,{trackCount:count,trackIds:ids})}):basic(call));
    const result=await s.plugin.playlist({id:'5'});
    assert.equal(result.tracks.length,count===3?2:10000);
    assert.match(result.description,/未完整同步/);assert(result.description.includes(`${result.tracks.length}/${count}`));
  }
});

test('likes refresh on first page, page by 30, and preserve unavailable tracks',async()=>{
  let reads=0;
  const s=await setup(call=>call.path==='/api/song/like/get'?response({code:200,ids:++reads===1?Array.from({length:32},(_,i)=>i+1):[99]}):basic(call));
  const first=await s.plugin.liked({offset:0}), next=await s.plugin.liked({offset:30});
  assert.equal(first.tracks.length,30);assert.equal(first.more,true);assert.equal(next.tracks.length,2);assert.equal(next.more,false);assert.equal(reads,1);
  assert.deepEqual((await s.plugin.liked({offset:0})).tracks.map(t=>t.id),['99']);
});

test('like and unlike require cloud read-back and serialize conflicting writes',async()=>{
  let ids=[];const writes=[];
  const s=await setup(call=>{
    if(call.path==='/api/radio/like'){writes.push(call.params.like);ids=call.params.like==='true'?[1]:[];return response({code:200});}
    if(call.path==='/api/song/like/get')return response({code:200,ids});
    return basic(call);
  });
  await Promise.all([s.plugin.like({id:'1',on:true}),s.plugin.like({id:'1',on:false})]);
  assert.deepEqual(writes,['true','false']);assert.deepEqual(json(await s.plugin.isLiked({ids:['1','program:2:3']})),{'1':false,'program:2:3':false});
});

test('successful write response with wrong likes is unconfirmed, not retried',async()=>{
  const s=await setup(call=>call.path==='/api/radio/like'?response({code:200}):call.path==='/api/song/like/get'?response({code:200,ids:[]}):basic(call));
  await assert.rejects(s.plugin.like({id:'1',on:true}),rejectCode('unconfirmed'));
  assert.equal(s.calls.filter(x=>x.path==='/api/radio/like').length,1);
});

test('playlist add/delete verifies complete cloud IDs and sends unique track IDs once',async()=>{
  let ids=[1];const writes=[];
  const s=await setup(call=>{
    if(call.path==='/api/playlist/manipulate/tracks'){
      const changed=JSON.parse(call.params.trackIds);writes.push(changed);
      ids=call.params.op==='add'?[...new Set([...ids,...changed])]:ids.filter(x=>!changed.includes(x));return response({code:200});
    }
    if(call.path==='/api/v6/playlist/detail')return response({code:200,playlist:list(5,{trackCount:ids.length,trackIds:ids.map(id=>({id}))})});
    return basic(call);
  });
  await s.plugin.addToPlaylist({id:'5',trackIds:['2','2','3']});
  await s.plugin.removeFromPlaylist({id:'5',trackIds:['2','3']});
  assert.deepEqual(ids,[1]);assert.deepEqual(writes,[[2,3],[2,3]]);
});

test('unconfirmed, duplicate and interrupted writes never receive blind retries',async()=>{
  for(const mode of ['unconfirmed','duplicate','network']){
    let writes=0;
    const s=await setup(call=>{
      if(call.path==='/api/playlist/manipulate/tracks'){writes++;if(mode==='network')throw Error('network');return response({code:mode==='duplicate'?502:200});}
      if(call.path==='/api/v6/playlist/detail')return response({code:200,playlist:list(5,{trackCount:mode==='duplicate'?1:0,trackIds:mode==='duplicate'?[{id:1}]:[]})});
      return basic(call);
    });
    await assert.rejects(s.plugin.addToPlaylist({id:'5',trackIds:['1']}),rejectCode(mode));assert.equal(writes,1);
  }
});

test('sign-out cancels pending and queued cloud writes without issuing the queued one',async()=>{
  const started=deferred(), result=deferred();let writes=0;
  const s=await setup(call=>{
    if(call.path==='/api/radio/like'){writes++;started.resolve();return result.promise;}
    return basic(call);
  });
  const first=s.plugin.like({id:'1',on:true});await started.promise;
  const second=s.plugin.like({id:'2',on:true});s.plugin.signOut();result.resolve(response({code:200}));
  await assert.rejects(first,rejectCode('cancelled'));await assert.rejects(second,rejectCode('cancelled'));assert.equal(writes,1);
});

test('stream deduplicates same-account requests and stores only safe metadata',async()=>{
  const result=deferred();
  const s=await setup(()=>result.promise);
  const first=s.plugin.stream({id:'1',quality:'high'}),second=s.plugin.stream({id:'1',quality:'high'});
  result.resolve(response({code:200,data:[{id:1,code:200,url:'https://m1.music.126.net/mock.mp3?token=secret',type:'mp3',level:'exhigh',br:320000}]}));
  await Promise.all([first,second]);assert.equal(s.calls.length,1);
  const summary=s.storage.get('streamSummary');assert.deepEqual(Object.keys(summary).sort(),['requested','actual','type','bitRate','time'].sort());
  assert.doesNotMatch(JSON.stringify(summary),/secret|cookie|126.net/);
});

test('preview, empty URL, invalid host and permission errors never record a valid stream',async()=>{
  for(const extra of [{freeTrialInfo:{}},{url:null},{url:'https://other.example/file.mp3'},{code:404}]){
    const s=await setup(()=>response({code:200,data:[{id:1,code:200,url:'https://m1.music.126.net/mock.mp3',...extra}]}));
    await assert.rejects(s.plugin.stream({id:'1'}),rejectCode('unavailable'));assert.equal(s.storage.has('streamSummary'),false);
  }
});

test('sign-out clears all account-owned summaries, liked cache and the pending stream result',async()=>{
  const started=deferred();
  const s=await setup(()=>started.promise);s.storage.set('syncSummary',{});s.storage.set('streamSummary',{});
  const pending=s.plugin.stream({id:'1'});s.plugin.signOut();
  started.resolve(response({code:200,data:[{id:1,url:'https://m1.music.126.net/mock.mp3'}]}));
  await assert.rejects(pending,rejectCode('cancelled'));
  for(const key of ['session','syncSummary','streamSummary'])assert.equal(s.storage.has(key),false);
});

test('search, album, artist, lyrics fallback, comment and podcast identities remain compatible',async()=>{
  const s=await setup(call=>{
    const {path}=call;
    if(path==='/api/cloudsearch/pc')return response({code:200,result:{songs:[song(1)],songCount:1}});
    if(path==='/api/v1/album/3')return response({code:200,album:{id:3},songs:[song(1)]});
    if(path==='/api/v1/artist/2')return response({code:200,artist:{id:2},hotSongs:[song(1)]});
    if(path==='/api/artist/albums/2')return response({code:200,hotAlbums:[{id:3}],more:false});
    if(path==='/api/song/lyric')return response({code:200,lrc:{lyric:''}});
    if(path==='/api/song/lyric/v1')return response({code:200,lrc:{lyric:'[00:01]Mock lyric'}});
    if(path.includes('/resource/comments/'))return response({code:200,comments:[{commentId:1,content:'Mock',user:{nickname:'Reader'}}],total:1,more:false});
    if(path==='/api/djradio/get/subed')return response({code:200,djRadios:[{id:10,name:'Show'}],hasMore:false});
    if(path==='/api/djradio/v2/get')return response({code:200,data:{id:10,name:'Show'}});
    if(path==='/api/dj/program/byradio')return response({code:200,programs:[{id:20,mainSong:{id:30}}],more:false});
    return basic(call);
  });
  assert.equal((await s.plugin.search({query:'mock'})).tracks[0].id,'1');
  assert.equal((await s.plugin.album({id:'3'})).tracks[0].id,'1');
  assert.equal((await s.plugin.artist({id:'2'})).albums[0].id,'3');
  assert.match((await s.plugin.lyrics({id:'1'})).lrc,/Mock lyric/);
  assert.equal((await s.plugin.shows())[0].id,'10');
  assert.equal((await s.plugin.show({id:'10'})).episodes[0].id,'program:20:30');
  assert.equal((await s.plugin.comments({trackId:'program:20:30'})).total,1);
  assert(s.calls.some(c=>c.path.endsWith('A_DJ_1_20')));
  await assert.rejects(s.plugin.like({id:'program:20:30',on:true}),rejectCode('unsupported'));
});

test('all existing discovery, chart and station routes remain available',async()=>{
  const s=await setup(call=>{
    if(call.path==='/api/personalized/playlist')return response({code:200,result:[list(5)]});
    if(call.path==='/api/toplist/detail')return response({code:200,list:[list(5)]});
    if(call.path==='/api/v3/discovery/recommend/songs')return response({code:200,data:{dailySongs:[song(1)]}});
    if(call.path==='/api/v1/discovery/recommend/resource')return response({code:200,recommend:[list(5)]});
    if(call.path==='/api/v6/playlist/detail')return response({code:200,playlist:list(3136952023,{trackCount:1,trackIds:[{id:1}]})});
    if(call.path==='/api/v1/radio/get')return response({code:200,data:[song(1)]});
    return basic(call);
  });
  assert((await s.plugin.home()).sections.length>=3);
  for(const page of ['charts','daily','recommendations','radar'])assert((await s.plugin.browse({page})).sections.length);
  assert.equal((await s.plugin.stations()).length,3);
  assert.equal((await s.plugin.stationNext({id:'DEFAULT'}))[0].id,'1');
});

test('cancellation setting stops a late result even when browse pages are cached',async()=>{
  const started=deferred(), result=deferred();
  const s=await setup(call=>{
    if(call.path.endsWith('/client/login')){started.resolve();return result.promise;}
    return loginHandler(call);
  },{initial:null});
  const pending=s.plugin.signIn();await started.promise;
  s.plugin.setSetting({key:'cancelLogin',value:'stop'});
  result.resolve(qr(803,['MUSIC_U=must-not-save']));
  await assert.rejects(pending,rejectCode('cancelled'));assert.equal(s.storage.has('session'),false);
});

test('stream refusal retries once, but never retries a content or rate error',async()=>{
  const s=await setup(()=>response({code:460}));
  await assert.rejects(s.plugin.stream({id:'1'}),/仍拒绝/);
  assert.equal(s.calls.length,2);
});

test('late likes from an old account do not populate a new account cache',async()=>{
  const started=deferred(), old=deferred();let likes=0;
  const s=await setup(call=>{
    if(call.path==='/api/song/like/get'){
      if(++likes===1){started.resolve();return old.promise;}
      return response({code:200,ids:[2]});
    }
    return loginHandler(call);
  });
  const pending=s.plugin.isLiked({ids:['1','2']});await started.promise;
  await s.plugin.signIn();old.resolve(response({code:200,ids:[1]}));
  await assert.rejects(pending,rejectCode('cancelled'));
  assert.deepEqual(json(await s.plugin.isLiked({ids:['1','2']})),{'1':false,'2':true});
});

test('repeated playlist IDs retain first position without duplicates',async()=>{
  const s=await setup(call=>{
    if(call.path==='/api/user/playlist')return Number(call.params.offset)===0?
      response({code:200,playlist:[list(1),list(2)],more:true}):
      response({code:200,playlist:[list(2),list(3)],more:false});
    return basic(call);
  });
  assert.deepEqual(json((await s.plugin.playlists()).map(p=>p.id)),['1','2','3']);
});

test('liked music playlist is fixed; first-page refresh is read only',async()=>{
  const s=await setup(call=>{
    if(call.path==='/api/user/playlist')return response({code:200,playlist:[list(5,{specialType:5})],more:false});
    if(call.path==='/api/song/like/get')return response({code:200,ids:[]});
    return basic(call);
  });
  const page=await s.plugin.browse({page:'sync'});
  assert.match(page.description,/喜欢 0 首/);
  assert.equal(page.sections.find(x=>x.title==='自建歌单').playlists[0].fixed,true);
  assert.equal(s.calls.some(x=>x.path.includes('/manipulate/')||x.path==='/api/radio/like'),false);
});

test('a playlist load past its call budget fails before publishing a partial success',async()=>{
  const ids=Array.from({length:1001},(_,i)=>({id:i+1}));let s;
  s=await setup(call=>{
    if(call.path==='/api/v6/playlist/detail'){
      s.advance(25001);return response({code:200,playlist:list(5,{trackCount:1001,trackIds:ids})});
    }
    return basic(call);
  });
  await assert.rejects(s.plugin.playlist({id:'5'}),rejectCode('timeout'));
});

test('expired session on a protected action reaches the host re-login flow',async()=>{
  const s=await setup(()=>response({code:301}));
  await assert.rejects(s.plugin.liked({offset:0}),rejectCode('signIn'));
  assert.equal(s.storage.has('session'),false);
});
