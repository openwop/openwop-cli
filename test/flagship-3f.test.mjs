import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('documents group',()=>{
  it('create POSTs title/kind',async()=>{let seen;const cap=capture();
    await runCli(['documents','create','--org','o1','--title','Spec','--kind','report'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({id:'d1'});}));
    assert.match(seen.path,/\/documents\/orgs\/o1\/documents$/);assert.deepEqual(seen.body,{title:'Spec',kind:'report'});});
  it('templates create POSTs name/kind to /templates',async()=>{let path;const cap=capture();
    await runCli(['documents','templates','create','--org','o1','--name','T','--kind','report'],base(cap,async(u,i)=>{path=new URL(u).pathname;return json({id:'t1'});}));
    assert.match(path,/\/documents\/orgs\/o1\/templates$/);});
});
describe('projects group',()=>{
  it('create POSTs orgId+name',async()=>{let seen;const cap=capture();
    await runCli(['projects','create','--org','o1','--name','Apollo'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({id:'p1'});}));
    assert.match(seen.path,/\/projects$/);assert.deepEqual(seen.body,{orgId:'o1',name:'Apollo'});});
  it('members add POSTs ref to /{id}/members',async()=>{let path;const cap=capture();
    await runCli(['projects','members','add','p1','--ref','user:x'],base(cap,async(u,i)=>{path=new URL(u).pathname;return json({});}));
    assert.match(path,/\/projects\/p1\/members$/);});
});
