const { test } = require("node:test");
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const Module = require("node:module");
const path = require("node:path");
function load(file, overrides = {}) {
  const filename = path.resolve(__dirname, "../src/", file);
  const code = esbuild.buildSync({entryPoints:[filename],bundle:true,platform:"node",format:"cjs",
    write:false,external:["siyuan"],loader:{".scss":"empty"}}).outputFiles[0].text;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  const original = mod.require.bind(mod);
  mod.require = (id) => Object.hasOwn(overrides,id) ? overrides[id] : original(id);
  mod._compile(code, filename); return mod.exports;
}
const {readCommentIdentity, ownsComment, sameCommentActor} = load("author-identity.ts");
const signedIn = (id, name="同名") => ({state:"signed-in",userId:id,displayName:name});
test("manual signatures still work outside SciForge", async () => {
  assert.deepEqual(await readCommentIdentity(undefined," Alice "),
    {mode:"manual",state:"signed-in",actor:{author:"Alice"}});
});
test("host identity wins over any stored manual signature", async () => {
  const result = await readCommentIdentity({version:1,read:async()=>signedIn("user-a")},"Fake");
  assert.deepEqual(result.actor,{author:"同名",authorId:"sciforge:user-a"});
});
test("signed out, malformed, unsupported and failed bridges never fall back to a name", async () => {
  for (const read of [async()=>({state:"signed-out"}),async()=>({state:"signed-in",displayName:"A"}),
    async()=>{throw new Error("offline");},async()=>signedIn("user-a","")]) {
    const result = await readCommentIdentity({version:1,read},"Cached");
    assert.equal(result.mode,"sciforge");assert.equal(result.actor,undefined);
  }
  assert.equal((await readCommentIdentity({version:2,read:async()=>signedIn("x")},"Cached")).actor,undefined);
});
test("same-name users, legacy signatures, and manual spoofing do not own linked comments", () => {
  const a={author:"同名",authorId:"sciforge:a"},b={author:"同名",authorId:"sciforge:b"};
  assert.equal(ownsComment(a,b),false);
  assert.equal(ownsComment(a,{author:"同名"}),false);
  assert.equal(ownsComment({author:"同名"},a),false);
  assert.equal(ownsComment(a,{...a,author:"Renamed"}),true);
  assert.equal(ownsComment({author:"Legacy"},{author:"Legacy"}),true);
  assert.equal(sameCommentActor(a,b),false);
});

function fixture(managed = true, backend = {stored:{v:1,comments:{}},writes:0}) {
  let profile=signedIn("a"),readHook;
  const local=new Map([["extended-comments:author","Cached"]]);
  global.localStorage={getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,v)};
  global.window={confirm:()=>true};
  if(managed)window.sciforgeCommentIdentity={version:1,read:async()=>profile};
  const clientWindow=window,clientStorage=global.localStorage;
  const messages=[];
  class Plugin {constructor(){this.i18n={...require("../src/i18n/en.json"),accountChanged:"changed",editDenied:"denied",sciforgeLoginRequired:"login",saveFailed:"failed",saved:"saved",deleted:"deleted"};}}
  const sdk={Plugin,showMessage:m=>messages.push(m),fetchSyncPost:async(url,input)=>{
    if(url.endsWith("getBlockAttrs")) {if(readHook)readHook();return {code:0,data:{"custom-comments":JSON.stringify(backend.stored)}};}
    if(url.endsWith("setBlockAttrs")) {backend.stored=JSON.parse(input.attrs["custom-comments"]);backend.writes++;return {code:0,data:null};}
    throw new Error(url);
  }};
  const C=load("index.ts",{siyuan:sdk}).default,plugin=new C();window.__extendedCommentsPlugin=plugin;
  const text={value:"Real comment"},reply={value:"Real reply"};
  const panel={querySelector:q=>q===".tc-text"||q===".tc-edit-text"?text:null,querySelectorAll:()=>[]};
  plugin.orderedThreads=()=>plugin.threads;
  plugin.panelElement=()=>panel;plugin.renderDock=async()=>{};plugin.focusSoon=()=>{};
  plugin.activeRootId=()=>"doc";plugin.replyField=()=>reply;
  plugin.reloadThreads=async()=>{plugin.threads=Object.entries(backend.stored.comments).map(([key,c])=>({
    key,blockId:c.blockId,comment:c,replies:Object.entries(c.replies).map(([key,r])=>({key,blockId:c.blockId,reply:r}))}));};
  return {plugin,messages,text,setProfile:p=>{profile=p;},hook:fn=>{readHook=fn;},
    activate:()=>{global.window=clientWindow;global.localStorage=clientStorage;},
    get store(){return backend.stored;},get writes(){return backend.writes;}};
}

test("two independent clients share one document with distinct account attribution", async () => {
  const backend={stored:{v:1,comments:{}},writes:0};
  const a=fixture(true,backend),b=fixture(true,backend);b.setProfile(signedIn("b"));
  a.activate();await a.plugin.refreshIdentity();
  a.plugin.pending={blockId:"shared-block",quote:"shared document"};await a.plugin.saveCompose();
  const key=Object.keys(backend.stored.comments)[0];
  b.activate();await b.plugin.refreshIdentity();await b.plugin.reloadThreads();
  assert.equal(b.plugin.threads[0].comment.authorId,"sciforge:a");
  await b.plugin.saveReply(key);
  assert.equal(Object.values(backend.stored.comments[key].replies)[0].authorId,"sciforge:b");
  const before=JSON.stringify(backend.stored);
  await b.plugin.saveEdit(key);await b.plugin.deleteComment(key);
  assert.equal(JSON.stringify(backend.stored),before);
  a.activate();await a.plugin.reloadThreads();
  assert.equal(a.plugin.threads[0].replies[0].reply.authorId,"sciforge:b");
  assert.equal(a.plugin.threads[0].comment.author,"同名");
  b.activate();b.setProfile({state:"signed-out"});await b.plugin.refreshIdentity();
  const writes=backend.writes;await b.plugin.saveReply(key);
  assert.equal(backend.writes,writes);
});
test("production compose/reply writes carry host IDs; UI removes manual author switching", async () => {
  const f=fixture();await f.plugin.refreshIdentity();
  f.plugin.pending={blockId:"block",quote:"quote"};await f.plugin.saveCompose();
  const key=Object.keys(f.store.comments)[0];assert.ok(key);
  assert.equal(f.store.comments[key].authorId,"sciforge:a");
  assert.equal(f.store.comments[key].author,"同名");
  await f.plugin.saveReply(key);
  const reply=Object.values(f.store.comments[key].replies)[0];assert.equal(reply.authorId,"sciforge:a");
  const html=f.plugin.panelHtml("同名");assert.ok(!html.includes('data-action="author"'));
});
test("production edit/delete deny a same-name different account and keep old attribution", async () => {
  const f=fixture();await f.plugin.refreshIdentity();f.plugin.pending={blockId:"b",quote:"q"};await f.plugin.saveCompose();
  const key=Object.keys(f.store.comments)[0],before=JSON.stringify(f.store);
  f.setProfile(signedIn("b"));await f.plugin.refreshIdentity();
  await f.plugin.saveEdit(key);await f.plugin.deleteComment(key);
  assert.equal(JSON.stringify(f.store),before);assert.ok(f.messages.includes("denied"));
  f.plugin.pending={blockId:"b",quote:"new"};await f.plugin.saveCompose();
  assert.equal(Object.values(f.store.comments).at(-1).authorId,"sciforge:b");
});
test("logout clears drafts and prevents writes using a cached manual name", async () => {
  const f=fixture();await f.plugin.refreshIdentity();f.plugin.pending={blockId:"b",quote:"q"};
  f.setProfile({state:"signed-out"});await f.plugin.refreshIdentity();assert.equal(f.plugin.pending,null);
  f.plugin.pending={blockId:"b",quote:"q"};await f.plugin.saveCompose();assert.equal(f.writes,0);
});
test("an account switch during document read cancels the pending production write", async () => {
  const f=fixture();await f.plugin.refreshIdentity();f.plugin.pending={blockId:"b",quote:"q"};
  f.hook(()=>f.setProfile(signedIn("b")));await f.plugin.saveCompose();assert.equal(f.writes,0);
});
test("standalone browser compose keeps manual attribution without a forged host ID", async () => {
  const f=fixture(false);f.plugin.pending={blockId:"b",quote:"q"};await f.plugin.saveCompose();
  const c=Object.values(f.store.comments)[0];assert.equal(c.author,"Cached");assert.equal(c.authorId,undefined);
});

test("linked author remains owner after rename; reply edit/delete enforce the ID", async () => {
 const f=fixture();await f.plugin.refreshIdentity();f.plugin.pending={blockId:"b",quote:"q"};await f.plugin.saveCompose();
 const key=Object.keys(f.store.comments)[0];await f.plugin.saveReply(key);
 const r=Object.keys(f.store.comments[key].replies)[0];
 f.setProfile(signedIn("b"));await f.plugin.refreshIdentity();
 await f.plugin.saveReplyEdit(r);await f.plugin.deleteReply(r);
 assert.ok(f.store.comments[key].replies[r]);
 f.setProfile(signedIn("a","New name"));await f.plugin.refreshIdentity();
 f.text.value="Changed";await f.plugin.saveEdit(key);
 assert.equal(f.store.comments[key].text,"Changed");assert.equal(f.store.comments[key].author,"同名");
 await f.plugin.deleteReply(r);assert.equal(Object.keys(f.store.comments[key].replies).length,0);
 await f.plugin.setResolution(key,true);assert.equal(f.store.comments[key].resolution.byId,"sciforge:a");
});
test("a legacy same-name comment is visible but cannot be claimed by a cloud account", async () => {
 const f=fixture(false);f.plugin.pending={blockId:"b",quote:"q"};await f.plugin.saveCompose();
 const key=Object.keys(f.store.comments)[0];
 window.sciforgeCommentIdentity={version:1,read:async()=>signedIn("a","Cached")};
 await f.plugin.refreshIdentity();const before=JSON.stringify(f.store);
 await f.plugin.saveEdit(key);await f.plugin.deleteComment(key);assert.equal(JSON.stringify(f.store),before);
});
