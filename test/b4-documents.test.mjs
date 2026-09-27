import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const base=(cap,f)=>({io:cap.io,fetchImpl:f,cwd:process.cwd(),repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
// Record every non-discovery call.
function recorder(reply){const calls=[];const f=async(u,i={})=>{const url=new URL(u);if(url.pathname.includes('.well-known'))return json({},404);calls.push({method:i.method??'GET',path:url.pathname,search:url.search,body:i.body?JSON.parse(i.body):undefined});return typeof reply==='function'?reply(url,i):json(reply??{});};return{f,calls};}
const D='/v1/host/openwop-app/documents/orgs/o1';

describe('documents (b4)',()=>{
  it('list passes kind/status/owner filters and renders a table',async()=>{const cap=capture();const r=recorder({documents:[{documentId:'d1',title:'Plan',kind:'plan',format:'markdown',status:'draft'}]});
    const code=await runCli(['documents','list','--org','o1','--kind','plan','--status','draft','--owner-kind','project','--owner-id','p1'],base(cap,r.f));
    assert.equal(code,0);assert.match(r.calls[0].path,/\/documents\/orgs\/o1\/documents$/);
    assert.equal(r.calls[0].search,'?kind=plan&status=draft&ownerKind=project&ownerId=p1');assert.match(cap.stdout,/d1\s+Plan\s+plan/);});
  it('locate GETs /documents/locate/{id} (encoded)',async()=>{const cap=capture();const r=recorder({orgId:'o9'});
    await runCli(['documents','locate','a/b'],base(cap,r.f));assert.match(r.calls[0].path,/\/documents\/locate\/a%2Fb$/);assert.match(cap.stdout,/org o9/);});
  it('create sends title/kind/format/templateId/ownerSubject',async()=>{const cap=capture();const r=recorder({documentId:'d2'});
    await runCli(['documents','create','--org','o1','--title','T','--kind','report','--format','markdown','--template','t1','--owner-kind','project','--owner-id','p1'],base(cap,r.f));
    assert.equal(r.calls[0].method,'POST');assert.deepEqual(r.calls[0].body,{title:'T',kind:'report',format:'markdown',templateId:'t1',ownerSubject:{kind:'project',id:'p1'}});assert.match(cap.stdout,/Created document d2/);});
  it('update PATCHes status + promotedCanvasId',async()=>{const cap=capture();const r=recorder({});
    await runCli(['documents','update','d1','--org','o1','--status','approved','--promoted-canvas','c1'],base(cap,r.f));
    assert.equal(r.calls[0].method,'PATCH');assert.deepEqual(r.calls[0].body,{status:'approved',promotedCanvasId:'c1'});});
  it('from-canvas POSTs canvasId',async()=>{const cap=capture();const r=recorder({documentId:'d3',versionId:'v1',created:true});
    await runCli(['documents','from-canvas','c1','--org','o1'],base(cap,r.f));assert.equal(r.calls[0].path,`${D}/documents/from-canvas`);assert.deepEqual(r.calls[0].body,{canvasId:'c1'});assert.match(cap.stdout,/Created document d3/);});
  it('version + add-version',async()=>{let cap=capture();let r=recorder({});
    await runCli(['documents','version','d1','v1','--org','o1'],base(cap,r.f));assert.equal(r.calls[0].path,`${D}/documents/d1/versions/v1`);
    cap=capture();r=recorder({versionId:'v2'});
    await runCli(['documents','add-version','d1','--org','o1','--content','# hi','--idempotency-key','k1'],base(cap,r.f));
    assert.equal(r.calls[0].method,'POST');assert.equal(r.calls[0].path,`${D}/documents/d1/versions`);assert.deepEqual(r.calls[0].body,{content:'# hi',idempotencyKey:'k1'});});
  it('render sends format; ingest-to-kb sends collectionId; promote-html prints html',async()=>{let cap=capture();let r=recorder({});
    await runCli(['documents','render','d1','--org','o1','--format','docx'],base(cap,r.f));assert.deepEqual(r.calls[0].body,{format:'docx'});
    cap=capture();r=recorder({ok:true});await runCli(['documents','ingest-to-kb','d1','--org','o1','--collection','kc1'],base(cap,r.f));
    assert.equal(r.calls[0].path,`${D}/documents/d1/ingest-to-kb`);assert.deepEqual(r.calls[0].body,{collectionId:'kc1'});
    cap=capture();r=recorder({html:'<h1>x</h1>',title:'X'});await runCli(['documents','promote-html','d1','--org','o1'],base(cap,r.f));
    assert.equal(r.calls[0].method,'POST');assert.match(cap.stdout,/<h1>x<\/h1>/);});
  it('artifact-types, canvas-sources (q), delete-canvas',async()=>{let cap=capture();let r=recorder({artifactTypes:[{id:'report',label:'Report'}]});
    await runCli(['documents','artifact-types','--org','o1'],base(cap,r.f));assert.equal(r.calls[0].path,`${D}/artifact-types`);assert.match(cap.stdout,/report\s+Report/);
    cap=capture();r=recorder({canvases:[],total:0});await runCli(['documents','canvas-sources','--org','o1','--q','deck'],base(cap,r.f));assert.equal(r.calls[0].search,'?q=deck');
    cap=capture();r=recorder({});const refused=await runCli(['documents','delete-canvas','c1','--org','o1'],base(cap,r.f));assert.equal(refused,2);assert.equal(r.calls.length,0);
    await runCli(['documents','delete-canvas','c1','--org','o1','--yes'],base(cap,r.f));assert.equal(r.calls[0].method,'DELETE');assert.equal(r.calls[0].path,`${D}/canvases/c1`);});
  it('templates catalog/from-catalog/update(PUT partial)/assemble',async()=>{let cap=capture();let r=recorder({catalog:[]});
    await runCli(['documents','templates','catalog','--org','o1','--kind','brief'],base(cap,r.f));assert.equal(r.calls[0].path,`${D}/templates/catalog`);assert.equal(r.calls[0].search,'?kind=brief');
    cap=capture();r=recorder({templateId:'t9'});await runCli(['documents','templates','from-catalog','seed1','--org','o1'],base(cap,r.f));
    assert.equal(r.calls[0].method,'POST');assert.equal(r.calls[0].path,`${D}/templates/from-catalog/seed1`);
    cap=capture();r=recorder({});await runCli(['documents','templates','update','t1','--org','o1','--name','N','--parameters','[{"name":"topic"}]'],base(cap,r.f));
    assert.equal(r.calls[0].method,'PUT');assert.deepEqual(r.calls[0].body,{name:'N',parameters:[{name:'topic'}]});
    cap=capture();r=recorder({augmentedPrompt:'p'});await runCli(['documents','templates','assemble','t1','--org','o1','--params','{"topic":"x"}'],base(cap,r.f));
    assert.deepEqual(r.calls[0].body,{params:{topic:'x'}});assert.match(cap.stdout,/augmentedPrompt/);});
  it('artifacts get/revisions/revision/diff',async()=>{let cap=capture();let r=recorder({});const A='/v1/host/openwop-app/artifacts';
    await runCli(['documents','artifacts','get','art:1'],base(cap,r.f));assert.equal(r.calls[0].path,`${A}/art%3A1`);
    cap=capture();r=recorder({revisions:[{revisionId:'r1'}]});await runCli(['documents','artifacts','revisions','a1'],base(cap,r.f));assert.equal(r.calls[0].path,`${A}/a1/revisions`);assert.match(cap.stdout,/r1/);
    cap=capture();r=recorder({});await runCli(['documents','artifacts','revision','a1','r1'],base(cap,r.f));assert.equal(r.calls[0].path,`${A}/a1/revisions/r1`);
    cap=capture();r=recorder({});await runCli(['documents','artifacts','diff','a1','--from','r1','--to','r2'],base(cap,r.f));assert.equal(r.calls[0].path,`${A}/a1/diff`);assert.equal(r.calls[0].search,'?from=r1&to=r2');});
  it('--json prints the raw body',async()=>{const cap=capture();const r=recorder({templates:[{templateId:'t1'}]});
    await runCli(['--json','documents','templates','list','--org','o1'],base(cap,r.f));assert.deepEqual(JSON.parse(cap.stdout),{templates:[{templateId:'t1'}]});});
  it('403 → exit 4 with a legible message',async()=>{const cap=capture();const r=recorder(()=>json({error:'forbidden',message:'workspace:write required'},403));
    const code=await runCli(['documents','delete','d1','--org','o1','--yes'],base(cap,r.f));assert.equal(code,4);assert.match(cap.stderr,/HTTP 403( [a-z_]+)?: workspace:write required/);});
});
describe('docs (b4)',()=>{
  it('backfill POSTs /docs/orgs/{org}/backfill',async()=>{const cap=capture();const r=recorder({ingested:2});
    const code=await runCli(['docs','backfill','--org','o1'],base(cap,r.f));assert.equal(code,0);assert.equal(r.calls[0].method,'POST');
    assert.equal(r.calls[0].path,'/v1/host/openwop-app/docs/orgs/o1/backfill');assert.match(cap.stdout,/ingested/);});
  it('public reads without auth',async()=>{const cap=capture();let auth;const f=async(u,i={})=>{if(String(u).includes('.well-known'))return json({},404);auth=i.headers?.authorization;return json({docs:[{slug:'intro',title:'Intro'}]});};
    await runCli(['docs','public','o1'],base(cap,f));assert.equal(auth,undefined);assert.match(cap.stdout,/intro\s+Intro/);});
  it('backfill without --org is a usage error',async()=>{const cap=capture();const code=await runCli(['docs','backfill'],base(cap,async()=>json({})));assert.equal(code,2);});
});
