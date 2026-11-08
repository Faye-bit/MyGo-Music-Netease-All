import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash, createCipheriv, createDecipheriv} from 'node:crypto';

const source = await readFile(new URL('../plugin/index.js', import.meta.url), 'utf8');
export const signed = {cookies:{MUSIC_U:'mock-cookie'},profile:{id:'1',name:'Mock listener'}};
export const song = id => ({id:Number(id),name:`Song ${id}`,ar:[{id:2,name:'Artist'}],al:{id:3,name:'Album'},dt:240000});
export const list = (id, extra={}) => ({id:Number(id),name:`List ${id}`,creator:{userId:1,nickname:'Mock listener'},trackCount:0,...extra});
export const response = (data, cookies=[], status=200) => ({ok:status>=200&&status<300,status,headers:{getSetCookie:()=>cookies},json:async()=>data});
export function deferred() {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
export async function setup(handler, {initial=signed, timeout=false}={}) {
  const storage=new Map(initial ? [['session',structuredClone(initial)]] : []);
  const calls=[], prompts=[];
  let now=1800000000000, initialized=false;
  const FakeDate=class extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  const host={
    storage:{get:k=>{if(!initialized) throw Error('host called during module initialization'); return structuredClone(storage.get(k));},set:(k,v)=>storage.set(k,structuredClone(v)),remove:k=>storage.delete(k)},
    signInPrompt:p=>prompts.push(structuredClone(p)),
    crypto:{md5:s=>createHash('md5').update(s).digest('hex'),aesEcbEncrypt:(key,s)=>{const c=createCipheriv('aes-128-ecb',key,null);return Buffer.concat([c.update(s),c.final()]).toString('hex');}},
  };
  const context=vm.createContext({host,URL,URLSearchParams,AbortController,Date:FakeDate,
    setTimeout:(fn,ms)=>setTimeout(fn, ms===1500||ms===1000||timeout ? 0:ms),clearTimeout,
    fetch:async(address,init)=>{
      const url=new URL(address);
      let path=url.pathname, params=Object.fromEntries(url.searchParams);
      if(path.startsWith('/eapi/')) {
        const decipher=createDecipheriv('aes-128-ecb','e82ckenh8dichen8',null);
        const plain=Buffer.concat([decipher.update(Buffer.from(new URLSearchParams(init.body).get('params'),'hex')),decipher.final()]).toString();
        const [logical,json]=plain.split('-36cd479b6b5-');path=logical;params=JSON.parse(json);
      } else if(init.body) params=Object.fromEntries(new URLSearchParams(init.body));
      const call={path,params,init};calls.push(call);
      const result=await handler(call,{storage,prompts,calls});
      return result;
    },
  });
  const module=new vm.SourceTextModule(source,{context});
  await module.link(()=>{throw Error('runtime imports are forbidden');});
  await module.evaluate();initialized=true;
  return {plugin:module.namespace,storage,prompts,calls,advance:ms=>now+=ms};
}
export function basic({path,params}) {
  if(path==='/api/nuser/account/get')return response({code:200,profile:{userId:1,nickname:'Mock listener'}});
  if(path==='/api/v3/song/detail')return response({code:200,songs:JSON.parse(params.c).map(x=>song(x.id)),privileges:JSON.parse(params.c).map(x=>({id:x.id,st:0,pl:320000}))});
  throw Error(`Unexpected mock path ${path}`);
}
