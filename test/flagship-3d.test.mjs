import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
describe('chat-widget group',()=>{
  it('rotate-token POSTs to /{id}/rotate-token',async()=>{let path,m;const cap=capture();
    await runCli(['chat-widget','rotate-token','w1','--org','o1'],base(cap,async(u,i)=>{path=new URL(u).pathname;m=i?.method;return json({widget:{}});}));
    assert.match(path,/\/chat-widget\/orgs\/o1\/widgets\/w1\/rotate-token$/);assert.equal(m,'POST');});
  it('requires --org (exit 2)',async()=>{const cap=capture();assert.equal(await runCli(['chat-widget','list'],base(cap,async()=>json({}))),2);});
});
describe('marketplace group',()=>{
  it('install POSTs packName+version',async()=>{let body,path;const cap=capture();
    await runCli(['marketplace','install','--pack','acme.crm','--version','1.2.0'],base(cap,async(u,i)=>{path=new URL(u).pathname;body=JSON.parse(i.body);return json({ok:true});}));
    assert.match(path,/\/marketplace\/install$/);assert.deepEqual(body,{packName:'acme.crm',version:'1.2.0'});});
  it('review POSTs rating to org-scoped reviews',async()=>{let body,path;const cap=capture();
    await runCli(['marketplace','review','acme.crm','--org','o1','--rating','5','--comment','great'],base(cap,async(u,i)=>{path=new URL(u).pathname;body=JSON.parse(i.body);return json({});}));
    assert.match(path,/\/marketplace\/orgs\/o1\/listings\/acme\.crm\/reviews$/);assert.deepEqual(body,{rating:5,comment:'great'});});
});
