import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,response,deferred} from './helpers.mjs';

const audio = (extra={}) => ({id:1,code:200,url:'https://m1.music.126.net/audio?secret=token',type:'mp3',level:'exhigh',br:320000,size:9000000,expi:1200,...extra});
const reply = extra => response({code:200,data:[audio(extra)]});
const plain = value => JSON.parse(JSON.stringify(value));

for (const [quality,level,type,actual] of [
  ['standard','standard','mp3','standard'],['high','exhigh','mp3','high'],
  ['higher','higher','mp3','high'],['exhigh','exhigh','mp3','high'],
  ['lossless','lossless','flac','lossless'],['hires','hires','flac','lossless'],
]) test(`maps ${quality} to ${level}, retaining actual metadata`,async()=>{
  const s=await setup(()=>reply({type,level}));
  const result=await s.plugin.stream({id:'1',quality});
  assert.equal(s.calls[0].params.level,level);
  assert.equal(s.calls[0].params.encodeType,type==='flac'?'flac':'mp3');
  assert.equal(result.quality,actual);
  const meta=s.storage.get('streamSummary');
  assert.equal(meta.requestedLevel,level);assert.equal(meta.actualLevel,level);
  assert.equal(meta.size,9000000);assert.equal(meta.expi,1200);
  assert.equal('sampleRate' in meta,false);assert.equal('bitDepth' in meta,false);
});

test('server complete downgrade preserves actual quality and does not request again',async()=>{
  const s=await setup(()=>reply({level:'standard',br:128000}));
  const result=await s.plugin.stream({id:'1',quality:'lossless'});
  assert.equal(result.quality,'standard');assert.equal(s.calls.length,1);
  const meta=s.storage.get('streamSummary');
  assert.equal(meta.requestedLevel,'lossless');assert.equal(meta.actualLevel,'standard');
});

test('unknown levels never inherit requested lossless or invent Hi-Res',async()=>{
  for(const extra of [{level:undefined,br:0},{level:'future',br:128000},{level:'hires',type:'mp3',br:320000},{level:undefined,type:'flac'}]) {
    const s=await setup(()=>reply(extra));const result=await s.plugin.stream({id:'1',quality:'hires'});
    assert.equal(s.storage.get('streamSummary').actualLevel,'unknown');
    assert.equal(result.quality,extra.type==='flac'?'lossless':extra.br>128000?'high':'standard');
  }
});

test('provided sample rate and bit depth survive diagnostics without credentials',async()=>{
  const s=await setup(()=>reply({type:'flac',level:'hires',sampleRate:96000,bitDepth:24}));
  await s.plugin.stream({id:'1',quality:'lossless'});
  const meta=s.storage.get('streamSummary');assert.equal(meta.sampleRate,96000);assert.equal(meta.bitDepth,24);
  assert.doesNotMatch(JSON.stringify(meta),/token|cookie|126.net|"id"/);
  const page=await s.plugin.browse({page:'diagnostics'});
  assert.match(page.description,/实际档位 hires/);assert.match(page.description,/96000/);assert.match(page.description,/缓存/);
});

test('same effective level merges but different levels request independently',async()=>{
  const hold=deferred();const s=await setup(()=>hold.promise);
  const a=s.plugin.stream({id:'1',quality:'high'}),b=s.plugin.stream({id:'1',quality:'exhigh'}),c=s.plugin.stream({id:'1',quality:'standard'});
  assert.equal(s.calls.length,2);hold.resolve(reply());await Promise.all([a,b,c]);
});

test('resolved addresses are never reused on subsequent requests, including after expiry',async()=>{
  let count=0;const s=await setup(()=>reply({url:`https://m1.music.126.net/${++count}.mp3`}));
  const first=await s.plugin.stream({id:'1'});s.advance(1300000);
  const second=await s.plugin.stream({id:'1'});
  assert.notEqual(first.url,second.url);assert.equal(s.calls.length,2);
});

test('preview, missing format, bad addresses and expired results fail without downgrade',async()=>{
  for(const extra of [{freeTrialInfo:{}},{url:null},{url:'bad'},{url:'https://a.music.126.net.evil.org/a'},
    {url:'https://user:secret@m1.music.126.net/a'},{url:'https://m1.music.126.net:444/a'},
    {type:undefined},{type:'unsupported'},{expi:0},{expi:-1},{code:404}]) {
    const s=await setup(()=>reply(extra));
    await assert.rejects(s.plugin.stream({id:'1',quality:'hires'}),e=>e.code==='unavailable');
    assert.equal(s.calls.length,1);assert.equal(s.storage.has('streamSummary'),false);
  }
});

test('content, authentication, rate, risk and network failures never trigger quality probing',async()=>{
  for(const code of [301,401,403,405,429,460,-460,500]) {
    const s=await setup(()=>response({code}));await assert.rejects(s.plugin.stream({id:'1',quality:'lossless'}));
    assert.equal(s.calls.length,1);assert.equal(s.storage.has('streamSummary'),false);
  }
  const s=await setup(()=>{throw Error('private transport text');});
  await assert.rejects(s.plugin.stream({id:'1'}),e=>e.code==='network'&&!e.message.includes('private'));
  assert.equal(s.calls.length,1);
});

test('failed pending streams are released for an explicit retry',async()=>{
  let calls=0;const s=await setup(()=>++calls===1?response({code:429}):reply());
  await assert.rejects(s.plugin.stream({id:'1'}));await s.plugin.stream({id:'1'});assert.equal(calls,2);
});

test('sign-out cancels a delayed stream without repopulating metadata',async()=>{
  const hold=deferred();const s=await setup(()=>hold.promise);
  const old=s.plugin.stream({id:'1',quality:'hires'});s.plugin.signOut();hold.resolve(reply({level:'hires',type:'flac'}));
  await assert.rejects(old,e=>e.code==='cancelled');assert.equal(s.storage.has('streamSummary'),false);
});

test('unknown preferences fail before a network request',async()=>{
  const s=await setup(()=>reply());for(const quality of ['ultra','__proto__','toString',''])await assert.rejects(s.plugin.stream({id:'1',quality}));
  assert.equal(s.calls.length,0);
});

test('invalid numeric metadata is sanitized and optional absent values stay absent',async()=>{
  const s=await setup(()=>reply({br:-1,size:'bad',gain:'secret',peak:-2,sampleRate:-1,bitDepth:'24'}));
  const result=plain(await s.plugin.stream({id:'1'}));
  assert.equal(result.bitRate,0);assert.equal(result.size,0);assert.equal(result.gain,0);assert.equal(result.peak,0);
  const meta=s.storage.get('streamSummary');assert.equal('sampleRate' in meta,false);assert.equal('bitDepth' in meta,false);
});
