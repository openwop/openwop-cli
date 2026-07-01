import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('kb group',()=>{
  it('collections create POSTs name',async()=>{let seen;const cap=capture();
    await runCli(['kb','collections','create','--org','o1','--name','Docs'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({id:'k1'});}));
    assert.match(seen.path,/\/kb\/orgs\/o1\/collections$/);assert.deepEqual(seen.body,{name:'Docs'});});
  it('search POSTs query+topK to /{id}/search',async()=>{let seen;const cap=capture();
    await runCli(['kb','search','k1','--org','o1','--query','hello','--top-k','3'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({results:[]});}));
    assert.match(seen.path,/\/collections\/k1\/search$/);assert.deepEqual(seen.body,{query:'hello',topK:3});});
  it('docs add POSTs title+text (wire field is text, not content)',async()=>{let seen;const cap=capture();
    await runCli(['kb','docs','add','k1','--org','o1','--title','Doc','--text','hello world'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({id:'d1'});}));
    assert.match(seen.path,/\/collections\/k1\/documents$/);assert.deepEqual(seen.body,{title:'Doc',text:'hello world'});});
  it('an unhandled 401 maps to exit 4 (central auth default, not 2)',async()=>{const cap=capture();
    const code=await runCli(['kb','docs','list','k1','--org','o1'],base(cap,async()=>json({message:'Sign in to access your account.'},401)));
    assert.equal(code,4);});
  it('an unhandled 403 maps to exit 4 (central auth default, not 2)',async()=>{const cap=capture();
    const code=await runCli(['kb','docs','list','k1','--org','o1'],base(cap,async()=>json({message:'forbidden'},403)));
    assert.equal(code,4);});
});
describe('cms group',()=>{
  it('pages create POSTs title+slug',async()=>{let seen;const cap=capture();
    await runCli(['cms','pages','create','--org','o1','--title','Home','--slug','home'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({id:'p1'});}));
    assert.match(seen.path,/\/cms\/orgs\/o1\/pages$/);assert.deepEqual(seen.body,{title:'Home',slug:'home'});});
  it('publish POSTs to /{id}/publish',async()=>{let path,m;const cap=capture();
    await runCli(['cms','publish','p1','--org','o1'],base(cap,async(u,i)=>{path=new URL(u).pathname;m=i?.method;return json({});}));
    assert.match(path,/\/pages\/p1\/publish$/);assert.equal(m,'POST');});
});
