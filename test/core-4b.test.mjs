import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('agent-allowlists',()=>{
  it('set PUTs allowlist; 403 → exit 4',async()=>{let seen;let cap=capture();
    await runCli(['agent-allowlists','set','a1','--allowlist-json','["t1"]'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,method:i?.method,body:JSON.parse(i.body)};return json({});}));
    assert.match(seen.path,/\/agent-allowlists\/admin\/agents\/a1$/);assert.equal(seen.method,'PUT');assert.deepEqual(seen.body,{allowlist:['t1']});
    cap=capture(); assert.equal(await runCli(['agent-allowlists','list'],base(cap,async()=>json({error:'no'},403))),4);});
});
describe('agent-packs',()=>{
  it('install POSTs name+version',async()=>{let seen;const cap=capture();
    await runCli(['agent-packs','install','--name','core.openwop.agents.iris','--version','1.0.0'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({});}));
    assert.match(seen.path,/\/registry\/agent-packs\/install$/);assert.deepEqual(seen.body,{name:'core.openwop.agents.iris',version:'1.0.0'});});
});
describe('agent-ops',()=>{
  it('run posts steps+dryRun',async()=>{let seen;const cap=capture();
    await runCli(['agent-ops','run','--step','a','--step','b','--dry-run'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({});}));
    assert.match(seen.path,/\/example-data\/run$/);assert.deepEqual(seen.body,{steps:['a','b'],dryRun:true});});
  it('clear refuses without --yes',async()=>{const cap=capture();assert.equal(await runCli(['agent-ops','clear'],base(cap,async()=>json({}))),2);});
});
