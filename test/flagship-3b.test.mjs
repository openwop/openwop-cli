// Batch-3b flagship groups: comments + sharing (org-scoped).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture() { let o='',e=''; return { io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}}, get stdout(){return o;}, get stderr(){return e;} }; }
const json = (b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base = (cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('comments group', () => {
  it('requires --org (exit 2)', async () => { const cap=capture(); assert.equal(await runCli(['comments','list'],base(cap,async()=>json({}))),2); });
  it('create POSTs resourceType/resourceId/body', async () => {
    const cap=capture(); let seen;
    await runCli(['comments','create','--org','o1','--resource-type','contact','--resource-id','c1','--body','hi'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,method:i?.method,body:JSON.parse(i.body)};return json({id:'m1'});}));
    assert.match(seen.path,/\/comments\/orgs\/o1\/comments$/); assert.equal(seen.method,'POST');
    assert.deepEqual(seen.body,{resourceType:'contact',resourceId:'c1',body:'hi'});
  });
});
describe('sharing group', () => {
  it('create POSTs a link; resolve reads public /shared/<token>', async () => {
    const cap=capture(); let cpath, rpath;
    await runCli(['sharing','create','--org','o1','--resource-type','doc','--resource-id','d1'],base(cap,async(u,i)=>{cpath=new URL(u).pathname;return json({token:'t1'});}));
    assert.match(cpath,/\/sharing\/orgs\/o1\/links$/);
    const cap2=capture();
    await runCli(['sharing','resolve','t1'],base(cap2,async(u)=>{rpath=new URL(u).pathname;return json({resource:{}});}));
    assert.match(rpath,/\/shared\/t1$/);
  });
});
