import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('notebooks',()=>{it('create POSTs orgId+title',async()=>{let seen;const cap=capture();
  await runCli(['notebooks','create','--org','o1','--title','Research'],base(cap,async(u,i)=>{seen={path:new URL(u).pathname,body:JSON.parse(i.body)};return json({id:'n1'});}));
  assert.match(seen.path,/\/notebooks$/);assert.deepEqual(seen.body,{orgId:'o1',title:'Research'});});});
describe('podcasts',()=>{it('retry POSTs to /episodes/{id}/retry',async()=>{let path,m;const cap=capture();
  await runCli(['podcasts','retry','e1'],base(cap,async(u,i)=>{path=new URL(u).pathname;m=i?.method;return json({});}));
  assert.match(path,/\/podcasts\/episodes\/e1\/retry$/);assert.equal(m,'POST');});});
describe('priority-matrix',()=>{it('ideas GETs /lists/{id}/ideas; create POSTs orgId+name',async()=>{
  let ip,cb;let cap=capture(); await runCli(['priority-matrix','ideas','l1'],base(cap,async(u)=>{ip=new URL(u).pathname;return json({});}));
  assert.match(ip,/\/priority-matrix\/lists\/l1\/ideas$/);
  cap=capture(); await runCli(['priority-matrix','create','--org','o1','--name','Q3'],base(cap,async(u,i)=>{cb=JSON.parse(i.body);return json({});}));
  assert.deepEqual(cb,{orgId:'o1',name:'Q3'});});});
