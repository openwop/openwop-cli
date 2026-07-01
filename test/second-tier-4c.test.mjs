import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('evals',()=>{
  it('match POSTs modelA/modelB/winner',async()=>{let seen;const cap=capture();
    await runCli(['evals','match','--org','o1','--model-a','x','--model-b','y','--winner','a'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({});}));
    assert.match(seen.path,/\/evals\/orgs\/o1\/arena\/match$/);assert.deepEqual(seen.body,{modelA:'x',modelB:'y',winner:'a'});});
  it('requires --org (exit 2)',async()=>{const cap=capture();assert.equal(await runCli(['evals','leaderboard'],base(cap,async()=>json({}))),2);});
});
describe('twin',()=>{
  it('set PUTs scopes array to /agents/{id}/twin',async()=>{let seen;const cap=capture();
    await runCli(['twin','set','a1','--scopes','email,calendar'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,method:i?.method,body:JSON.parse(i.body)};return json({});}));
    assert.match(seen.path,/\/agents\/a1\/twin$/);assert.equal(seen.method,'PUT');assert.deepEqual(seen.body,{scopes:['email','calendar']});});
  it('grant POSTs agentId+scopes to twin-grants',async()=>{let seen;const cap=capture();
    await runCli(['twin','grant','--agent','a1','--scopes','email'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({});}));
    assert.match(seen.path,/\/profiles\/me\/twin-grants$/);assert.deepEqual(seen.body,{agentId:'a1',scopes:['email']});});
});
