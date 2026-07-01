import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('strategy',()=>{
  it('create POSTs orgId+title',async()=>{let seen;const cap=capture();
    await runCli(['strategy','create','--org','o1','--title','GTM'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({id:'s1'});}));
    assert.match(seen.path,/\/strategy$/);assert.deepEqual(seen.body,{orgId:'o1',title:'GTM'});});
  it('context GETs /strategy/context',async()=>{let path;const cap=capture();
    await runCli(['strategy','context'],base(cap,async(u)=>{path=new URL(u).pathname;return json({});}));
    assert.match(path,/\/strategy\/context$/);});
});
describe('advisors',()=>{
  it('create POSTs orgId+name; by-handle GETs',async()=>{let cp,hp;
    let cap=capture(); await runCli(['advisors','create','--org','o1','--name','Panel'],base(cap,async(u,i)=>{cp={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({id:'b1'});}));
    assert.match(cp.path,/\/advisors\/boards$/);assert.deepEqual(cp.body,{orgId:'o1',name:'Panel'});
    cap=capture(); await runCli(['advisors','by-handle','panel'],base(cap,async(u)=>{hp=new URL(u).pathname;return json({});}));
    assert.match(hp,/\/advisors\/boards\/by-handle\/panel$/);});
});
describe('campaigns-orchestration',()=>{
  it('finalize refuses without --yes; POSTs campaignId with it',async()=>{
    let cap=capture(); assert.equal(await runCli(['campaigns-orchestration','finalize','c1'],base(cap,async()=>json({}))),2);
    let seen; cap=capture(); await runCli(['campaigns-orchestration','finalize','c1','--yes'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({});}));
    assert.match(seen.path,/\/campaign-orchestration\/finalize$/);assert.deepEqual(seen.body,{campaignId:'c1'});});
});
