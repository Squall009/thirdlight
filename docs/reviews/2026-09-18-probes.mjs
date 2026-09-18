// Audit reproductions: assertions pin BUGGY behavior at be59d15, not desired behavior.
// Run as an unprivileged Linux user: node docs/reviews/2026-09-18-probes.mjs
// Uses disposable ~/.thirdlight-audit-* roots only; no production projects or services.
import { build } from 'esbuild';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(homedir(), '.thirdlight-audit-'));
try {
  const bundle = join(root, 'workspace.mjs');
  await build({entryPoints:[join(repo,'packages/workspace/src/index.ts')], bundle:true, platform:'node', format:'esm', outfile:bundle});
  const {openWorkspaceService, defaultWriteOps: real} = await import(pathToFileURL(bundle));
  let sequence = 0;
  const request = (revision) => ({op:'createEntity', projectId:'demo', expectedRevision:revision, requestId:`req-${(++sequence).toString(16).padStart(32,'0')}`, args:{kind:'box'}});
  const query = (s) => s.query({op:'queryProject', projectId:'demo'});
  const err = code => Object.assign(new Error(code), {code, errno:code});
  function setup(name, overrides={}) {
    const r = join(root,name);
    const s = openWorkspaceService({root:r, ops:{...real,...overrides}});
    assert.equal(s.createProject('demo','Demo').ok,true);
    const path=join(r,'projects/demo/scenes/main.json');
    const recovery=join(r,'projects/demo/.thirdlight/recovery');
    return {s,r,path,recovery};
  }
  {
    let armed=false;
    const t=setup('retry',{renameFile(from,to){if(armed && to.endsWith('/scenes/main.json')) {armed=false; writeFileSync(to,'FOREIGN EVIDENCE'); throw err('EIO');} return real.renameFile(from,to);}});
    armed=true;
    const result=t.s.runCommand(request(0));
    assert.equal(result.ok,true); assert.equal(readdirSync(t.recovery).length,0);
    console.log('RETRY_OVERWRITE',JSON.stringify({result:result.ok,foreignLost:!readFileSync(t.path,'utf8').includes('FOREIGN'),snapshots:0}));
  }
  {
    const t=setup('unreadable');
    writeFileSync(t.path,'UNREADABLE FOREIGN EVIDENCE'); chmodSync(t.path,0);
    try {
      const result=t.s.runCommand(request(0));
      assert.equal(result.error.code,'external_change_unresolved');
      const snapshot=readFileSync(join(t.recovery,readdirSync(t.recovery)[0]));
      const discard=t.s.discardExternalState('demo');
      assert.equal(discard.ok,true); assert.equal(snapshot.length,0);
      console.log('UNREADABLE_OVERWRITE',JSON.stringify({pendingHash:result.error.pendingChange.externalHash,snapshotBytes:snapshot.length,discard:discard.ok,foreignLost:!readFileSync(t.path,'utf8').includes('FOREIGN')}));
    } finally {chmodSync(t.path,0o644);}
  }
  {
    let armed=false;
    const t=setup('snapshot',{openTempFile(path){if(armed && path.includes('/recovery/'))throw err('ENOSPC');return real.openTempFile(path);}});
    armed=true; writeFileSync(t.path,'FOREIGN WITHOUT SNAPSHOT');
    const result=t.s.runCommand(request(0)); const discard=t.s.discardExternalState('demo');
    assert.equal(result.error.code,'external_change_unresolved'); assert.equal(discard.ok,true); assert.equal(readdirSync(t.recovery).length,0);
    console.log('SNAPSHOT_FAILURE',JSON.stringify({error:result.error.code,discard:discard.ok,snapshots:0,foreignLost:!readFileSync(t.path,'utf8').includes('FOREIGN')}));
  }
  {
    let armed=false;
    const t=setup('close',{closeFile(fd){real.closeFile(fd);if(armed)throw err('EIO');}});
    armed=true; const result=t.s.runCommand(request(0));
    assert.equal(result.ok,true);
    console.log('CLOSE_FAILURE_ACK',JSON.stringify({ok:result.ok,revision:query(t.s).revision}));
  }
  {
    let armed=false;
    const t=setup('accept',{fsyncDir(dir){if(armed && dir.endsWith('/scenes'))throw err('EIO');return real.fsyncDir(dir);}});
    assert.equal(t.s.runCommand(request(0)).ok,true);
    const external=JSON.parse(readFileSync(t.path,'utf8'));external.scene.revision=10;writeFileSync(t.path,JSON.stringify(external));
    assert.equal(t.s.runCommand(request(1)).error.code,'external_change_unresolved');
    armed=true; const result=t.s.acceptExternalState('demo');armed=false;
    const disk=JSON.parse(readFileSync(t.path,'utf8'));
    assert.equal(result.error.onDiskState,'new-undurable');assert.equal(disk.scene.revision,10);assert.equal(query(t.s).revision,1);
    console.log('ACCEPT_DIVERGENCE',JSON.stringify({error:result.error.onDiskState,diskRevision:disk.scene.revision,memoryRevision:query(t.s).revision,diskRetry:disk.retry.records.length}));
  }
  {
    let armed=false;
    const t=setup('release-envelope',{fsyncDir(dir){if(armed && dir.endsWith('/scenes'))throw err('EIO');return real.fsyncDir(dir);}});
    const req=request(0);assert.equal(t.s.runCommand(req).ok,true);
    armed=true;const result=t.s.releaseWorkspace('demo');armed=false;
    const disk=JSON.parse(readFileSync(t.path,'utf8'));const replay=t.s.runCommand(req);
    assert.equal(result.error.onDiskState,'new-undurable');assert.equal(disk.retry.records.length,0);assert.equal(replay.duplicated,true);
    console.log('RELEASE_ENVELOPE_DIVERGENCE',JSON.stringify({error:result.error.onDiskState,diskRetry:0,memoryReplay:replay.duplicated}));
  }
  {
    let armed=false;
    const t=setup('release-ownership',{fsyncDir(dir){if(armed && dir.endsWith('/.thirdlight'))throw err('EIO');return real.fsyncDir(dir);}});
    armed=true; const result=t.s.releaseWorkspace('demo');armed=false;
    const other=openWorkspaceService({root:t.r});
    const q2=query(other); const old=t.s.runCommand(request(0));
    assert.equal(result.error.onDiskState,'new-undurable');assert.equal(q2.ok,true);assert.equal(old.ok,true);
    console.log('RELEASE_OWNERSHIP_SPLIT',JSON.stringify({release:result.error.onDiskState,newOwner:q2.ok,oldOwnerStillWrites:old.ok,newOwnerRevision:query(other).revision,oldOwnerRevision:query(t.s).revision}));
  }
  {
    const t=setup('undefined');
    const req={...request(0),origin:undefined};
    const ack=t.s.runCommand(req);
    const digest=JSON.parse(readFileSync(t.path,'utf8')).retry.records[0].digest;
    t.s.dispose();const reopened=query(t.s);
    assert.equal(ack.ok,true);assert.equal(digest,null);assert.equal(reopened.error.reason,'retry_records_invalid');
    console.log('NULL_DIGEST',JSON.stringify({ok:ack.ok,digest,reopen:reopened.error.reason}));
  }
  {
    const t=setup('query-alias');
    const ack=t.s.runCommand(request(0));
    const one=t.s.query({op:'queryEntity',projectId:'demo',args:{entityId:ack.createdId}});
    one.entity.name='not-a-command';
    assert.equal(query(t.s).revision,1);
    assert.equal(t.s.runCommand(request(1)).ok,true);
    assert.equal(JSON.parse(readFileSync(t.path,'utf8')).scene.entities[1].name,'not-a-command');
    console.log('QUERY_ALIAS','non-command name edit persisted by unrelated command');
  }
  {
    const t=setup('ack-alias');const req=request(0);const ack=t.s.runCommand(req);
    ack.history.undoDepth=-1;
    assert.equal(t.s.runCommand(req).history.undoDepth,-1);
    assert.equal(t.s.runCommand(request(1)).ok,true);t.s.dispose();
    assert.equal(query(t.s).error.reason,'retry_records_invalid');
    console.log('ACK_ALIAS','mutating returned history corrupts retry records on next write');
  }
  {
    const t=setup('load-throw');assert.equal(t.s.runCommand(request(0)).ok,true);
    const env=JSON.parse(readFileSync(t.path,'utf8'));
    env.retry.records[0].result.change.type={toString:0};writeFileSync(t.path,JSON.stringify(env));
    assert.throws(()=>openWorkspaceService({root:t.r}),TypeError);
    console.log('STARTUP_THROW','JSON change.type={toString:0} throws TypeError from openWorkspaceService');
  }
  {
    const t=setup('bad-record');const req=request(0);const ack=t.s.runCommand(req);
    const env=JSON.parse(readFileSync(t.path,'utf8'));
    env.retry.records[0].result.projectId='another-project';
    env.retry.records[0].result.change.entity={id:ack.createdId};
    writeFileSync(t.path,JSON.stringify(env));t.s.dispose();
    const replay=t.s.runCommand(req);
    assert.equal(replay.ok,true);assert.equal(replay.projectId,'another-project');assert.equal(replay.change.entity.components,undefined);
    console.log('INVALID_RECORD_REPLAY',JSON.stringify({projectId:replay.projectId,entity:replay.change.entity}));
  }
  {
    const t=setup('error-json');
    const result=t.s.query({op:'queryEntities',projectId:'demo',args:{limit:1n}});
    assert.equal(result.ok,false);assert.throws(()=>JSON.stringify(result),TypeError);
    console.log('ERROR_JSON','BigInt found in query validation error prevents JSON serialization');
  }
} finally {rmSync(root,{recursive:true,force:true});}
