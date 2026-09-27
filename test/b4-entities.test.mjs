import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';

function capture(){let o='',e='';return{io:{stdout:{write:s=>{o+=s;}},stderr:{write:s=>{e+=s;}}},get stdout(){return o;},get stderr(){return e;}};}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
const ctx=(cap,f,cwd=process.cwd())=>({io:cap.io,fetchImpl:f,cwd,repoRoot:process.cwd(),env:{OPENWOP_CONFIG_HOME:'/nonexistent-owp-test',OPENWOP_API_KEY:'k'}});
/** Record the entity-route calls (ignore discovery probes). */
function recorder(reply){const calls=[];const f=async(u,i={})=>{const url=new URL(u);if(!url.pathname.includes('entities'))return json({});
  calls.push({method:i.method??'GET',path:url.pathname,search:url.search,body:i.body?JSON.parse(i.body):undefined,auth:i.headers?.authorization});
  return typeof reply==='function'?reply(url,i):reply.clone();};return{f,calls};}

describe('entities types',()=>{
  it('list renders a table; --json passes through',async()=>{
    const {f,calls}=recorder(json({types:[{name:'recipe',displayName:'Recipe',status:'published',fields:[{key:'t'}]}]}));
    let cap=capture();assert.equal(await runCli(['entities','types','list','--project','p1'],ctx(cap,f)),0);
    assert.match(calls[0].path,/\/v1\/host\/openwop-app\/entities\/types$/);assert.equal(calls[0].search,'?projectId=p1');
    assert.match(cap.stdout,/recipe\s+Recipe\s+published\s+1/);
    cap=capture();await runCli(['--json','entities','types','list'],ctx(cap,f));
    assert.equal(JSON.parse(cap.stdout).types[0].name,'recipe');});
  it('create POSTs name/displayName/fields (+projectId)',async()=>{
    const {f,calls}=recorder(json({name:'recipe'},201));const cap=capture();
    assert.equal(await runCli(['entities','types','create','--name','recipe','--display-name','Recipe','--fields','[{"key":"title","type":"text"}]','--project','p1'],ctx(cap,f)),0);
    assert.equal(calls[0].method,'POST');assert.deepEqual(calls[0].body,{name:'recipe',displayName:'Recipe',fields:[{key:'title',type:'text'}],projectId:'p1'});
    assert.match(cap.stdout,/Created entity type recipe/);});
  it('update PATCHes status + publicRead, --clear-description sends null',async()=>{
    const {f,calls}=recorder(json({name:'r'}));const cap=capture();
    await runCli(['entities','types','update','r/x','--status','published','--public-read','{"enabled":true}','--clear-description'],ctx(cap,f));
    assert.equal(calls[0].method,'PATCH');assert.match(calls[0].path,/\/types\/r%2Fx$/);
    assert.deepEqual(calls[0].body,{description:null,status:'published',publicRead:{enabled:true}});});
  it('delete requires --yes',async()=>{
    const {f,calls}=recorder(new Response(null,{status:204}));let cap=capture();
    assert.equal(await runCli(['entities','types','delete','r'],ctx(cap,f)),2);assert.equal(calls.length,0);
    cap=capture();assert.equal(await runCli(['entities','types','delete','r','--yes'],ctx(cap,f)),0);assert.equal(calls[0].method,'DELETE');});
  it('query POSTs filters/sort/termId/limit/cursor',async()=>{
    const {f,calls}=recorder(json({entities:[{entityId:'e1',status:'published',values:{title:'x'}}],nextCursor:'c2'}));const cap=capture();
    await runCli(['entities','types','query','recipe','--filters','[{"field":"title","op":"eq","value":"x"}]','--sort-key','title','--sort-dir','desc','--term-id','t1','--limit','5','--cursor','c1'],ctx(cap,f));
    assert.match(calls[0].path,/\/types\/recipe\/query$/);
    assert.deepEqual(calls[0].body,{filters:[{field:'title',op:'eq',value:'x'}],sort:{key:'title',dir:'desc'},termId:'t1',limit:5,cursor:'c1'});
    assert.match(cap.stdout,/e1\s+published/);assert.match(cap.stdout,/next cursor: c2/);});
  it('export writes NDJSON to --output; import converts a JSON array to ndjson',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'owp-ent-'));
    const nd='{"entityId":"a","values":{}}\n{"entityId":"b","values":{}}\n';
    let {f,calls}=recorder(()=>new Response(nd,{status:200,headers:{'content-type':'application/x-ndjson'}}));let cap=capture();
    assert.equal(await runCli(['entities','types','export','recipe','--output','out.ndjson'],ctx(cap,f,dir)),0);
    assert.match(calls[0].path,/\/types\/recipe\/export$/);assert.equal(readFileSync(join(dir,'out.ndjson'),'utf8'),nd);assert.match(cap.stdout,/Exported 2/);
    writeFileSync(join(dir,'in.json'),JSON.stringify([{entityId:'a',values:{t:1}},{values:{t:2}}]));
    ({f,calls}=recorder(json({created:2})));cap=capture();
    assert.equal(await runCli(['entities','types','import','recipe','--file','in.json'],ctx(cap,f,dir)),0);
    assert.equal(calls[0].method,'POST');assert.equal(calls[0].body.ndjson,'{"entityId":"a","values":{"t":1}}\n{"values":{"t":2}}');});
});

describe('entities records',()=>{
  it('list passes limit/cursor; create POSTs values/entityId/termIds',async()=>{
    let {f,calls}=recorder(json({entities:[]}));let cap=capture();
    await runCli(['entities','list','recipe','--limit','10','--cursor','c'],ctx(cap,f));
    assert.equal(calls[0].search,'?limit=10&cursor=c');assert.match(cap.stdout,/No entities/);
    ({f,calls}=recorder(json({entityId:'e9'},201)));cap=capture();
    await runCli(['entities','create','recipe','--values','{"title":"P"}','--entity-id','e9','--term-ids','t1,t2','--status','draft'],ctx(cap,f));
    assert.match(calls[0].path,/\/types\/recipe\/entities$/);
    assert.deepEqual(calls[0].body,{values:{title:'P'},termIds:['t1','t2'],status:'draft',entityId:'e9'});assert.match(cap.stdout,/Created recipe entity e9/);});
  it('update PATCHes; get reads; create without --values is a usage error',async()=>{
    let {f,calls}=recorder(json({entityId:'e1'}));let cap=capture();
    await runCli(['entities','update','recipe','e:1','--body','{"values":{"a":1}}'],ctx(cap,f));
    assert.equal(calls[0].method,'PATCH');assert.match(calls[0].path,/\/entities\/e%3A1$/);assert.deepEqual(calls[0].body,{values:{a:1}});
    cap=capture();assert.equal(await runCli(['entities','create','recipe'],ctx(cap,f)),2);
  });
  it('403 → legible message + exit 4',async()=>{
    const {f}=recorder(json({error:'forbidden',message:'needs workspace:write'},403));const cap=capture();
    assert.equal(await runCli(['entities','delete','recipe','e1','--yes'],ctx(cap,f)),4);assert.match(cap.stderr,/HTTP 403( [a-z_]+)?: needs workspace:write/);});
});

describe('entities taxonomies/terms/relationships/locale',()=>{
  it('terms create/update/reorder/delete bodies',async()=>{
    let {f,calls}=recorder(json({slug:'s'}));let cap=capture();
    await runCli(['entities','terms','create','cuisine','--slug','thai','--label','Thai','--parent-id','asian'],ctx(cap,f));
    assert.deepEqual(calls[0].body,{slug:'thai',label:'Thai',parentId:'asian'});assert.match(calls[0].path,/\/taxonomies\/cuisine\/terms$/);
    await runCli(['entities','terms','update','cuisine','thai','--clear-parent'],ctx(cap,f));
    assert.equal(calls[1].method,'PATCH');assert.deepEqual(calls[1].body,{parentId:null});
    await runCli(['entities','terms','reorder','cuisine','--slugs','b,a'],ctx(cap,f));
    assert.match(calls[2].path,/\/terms\/reorder$/);assert.deepEqual(calls[2].body,{orderedSlugs:['b','a']});
    await runCli(['entities','terms','delete','cuisine','thai','--yes'],ctx(cap,f));
    assert.equal(calls[3].method,'DELETE');assert.match(calls[3].path,/\/terms\/thai$/);});
  it('taxonomies create + relationships create/delete + locale-context',async()=>{
    let {f,calls}=recorder(json({}));let cap=capture();
    await runCli(['entities','taxonomies','create','--name','cuisine','--display-name','Cuisine'],ctx(cap,f));
    assert.deepEqual(calls[0].body,{name:'cuisine',displayName:'Cuisine'});
    await runCli(['entities','relationships','create','--from','recipe','--to','chef','--cardinality','many-to-one','--on-delete','restrict'],ctx(cap,f));
    assert.deepEqual(calls[1].body,{fromTypeName:'recipe',toTypeName:'chef',cardinality:'many-to-one',onDelete:'restrict'});
    await runCli(['entities','relationships','delete','recipe','chef','--yes'],ctx(cap,f));
    assert.match(calls[2].path,/\/relationships\/recipe\/chef$/);
    ({f,calls}=recorder(json({enabled:true,baseLocale:'en',supportedLocales:['en','fr']})));cap=capture();
    await runCli(['entities','locale-context'],ctx(cap,f));assert.match(cap.stdout,/base en; supported: en, fr/);});
});

describe('entities public',()=>{
  it('list is anonymous and passes query params',async()=>{
    const {f,calls}=recorder(json({entities:[{entityId:'e1',values:{}}]}));const cap=capture();
    assert.equal(await runCli(['entities','public','list','t1','recipe','--locale','fr','--sort-key','title','--sort-dir','asc','--limit','3','--filters','[]'],ctx(cap,f)),0);
    assert.match(calls[0].path,/\/v1\/host\/openwop-app\/public-entities\/t1\/types\/recipe\/entities$/);
    const sp=new URLSearchParams(calls[0].search);assert.equal(sp.get('locale'),'fr');assert.equal(sp.get('sortKey'),'title');assert.equal(sp.get('filters'),'[]');
    assert.equal(calls[0].auth,undefined);});
  it('get reads one entity anonymously',async()=>{
    const {f,calls}=recorder(json({entityId:'e1'}));const cap=capture();
    await runCli(['--json','entities','public','get','t1','recipe','e1'],ctx(cap,f));
    assert.match(calls[0].path,/\/entities\/e1$/);assert.equal(calls[0].auth,undefined);assert.equal(JSON.parse(cap.stdout).entityId,'e1');});
});
