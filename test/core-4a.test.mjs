import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('reviews',()=>{
  it('action POSTs to /reviews/{id}/actions/{action}',async()=>{let path,m;const cap=capture();
    await runCli(['reviews','action','rv1','approve','--note','ok'],base(cap,async(u,i)=>{path=new URL(u).pathname;m=i?.method;return json({});}));
    assert.match(path,/\/reviews\/rv1\/actions\/approve$/);assert.equal(m,'POST');});
});
describe('workspaces (tenancy)',()=>{
  it('list GETs /me/workspaces; switch POSTs /workspaces/{id}/switch',async()=>{let lp,sp;
    let cap=capture(); await runCli(['workspaces','list'],base(cap,async(u)=>{lp=new URL(u).pathname;return json({workspaces:[]});}));
    assert.match(lp,/\/me\/workspaces$/);
    cap=capture(); await runCli(['workspaces','switch','w1'],base(cap,async(u)=>{sp=new URL(u).pathname;return json({});}));
    assert.match(sp,/\/workspaces\/w1\/switch$/);});
});
describe('agent-profile',()=>{
  it('set PUTs parsed profile JSON',async()=>{let seen;const cap=capture();
    await runCli(['agent-profile','set','a1','--profile-json','{"role":"triage"}'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,method:i?.method,body:JSON.parse(i.body)};return json({});}));
    assert.match(seen.path,/\/agents\/a1\/profile$/);assert.equal(seen.method,'PUT');assert.deepEqual(seen.body,{role:'triage'});});
});
