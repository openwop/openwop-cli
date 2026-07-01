import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('forms group',()=>{
  it('create POSTs title + parsed fields',async()=>{let seen;const cap=capture();
    await runCli(['forms','create','--org','o1','--title','Intake','--fields-json','[{"k":"email"}]'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,method:i?.method,body:JSON.parse(i.body)};return json({id:'f1'});}));
    assert.match(seen.path,/\/forms\/orgs\/o1\/forms$/);assert.deepEqual(seen.body,{title:'Intake',fields:[{k:'email'}]});});
  it('status POSTs to /{id}/status',async()=>{let path;const cap=capture();
    await runCli(['forms','status','f1','--org','o1','--status','published'],base(cap,async(u)=>{path=new URL(u).pathname;return json({});}));
    assert.match(path,/\/forms\/f1\/status$/);});
});
describe('email group',()=>{
  it('templates create POSTs name/subject/body',async()=>{let seen;const cap=capture();
    await runCli(['email','templates','create','--org','o1','--name','Welcome','--subject','Hi','--body','Hello'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({id:'t1'});}));
    assert.match(seen.path,/\/email\/orgs\/o1\/templates$/);assert.deepEqual(seen.body,{name:'Welcome',subject:'Hi',body:'Hello'});});
  it('campaigns send refuses without --yes (exit 2)',async()=>{const cap=capture();
    assert.equal(await runCli(['email','campaigns','send','c1','--org','o1'],base(cap,async()=>json({}))),2);});
  it('campaigns send with --yes POSTs to /send',async()=>{let path;const cap=capture();
    await runCli(['email','campaigns','send','c1','--org','o1','--yes'],base(cap,async(u)=>{path=new URL(u).pathname;return json({});}));
    assert.match(path,/\/campaigns\/c1\/send$/);});
});
