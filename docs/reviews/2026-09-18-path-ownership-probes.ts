// Observational audit probes for be59d15; outputs describe bugs, not expected fixes.
// Disposable ext4 home-directory roots only. Run unprivileged; no real services killed.
import * as fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openWorkspaceService, defaultWriteOps as ops} from '@thirdlight/workspace';
const roots:string[]=[]; const idA='tb-'+'a'.repeat(32), idB='tb-'+'b'.repeat(32);
function root(){let r=fs.mkdtempSync(join(homedir(),'.tl07-focus-'));roots.push(r);return r;}
function svc(r:string, extra:any={}){return openWorkspaceService({root:r,backendId:idA,utcNow:()=>new Date(Date.now()+10000).toISOString().replace(/\.\d{3}Z$/,'Z'),...extra});}
function q(s:any,id='demo'){return s.query({op:'queryProject',projectId:id});}
function cmd(s:any,n=1){return s.runCommand({op:'setTransform',projectId:'demo',requestId:'req-'+n.toString(16).padStart(32,'0'),expectedRevision:0,args:{entityId:'cam-main',transform:{position:[n,0.5,4]}}});}
function log(name:string,data:any){console.log(name,JSON.stringify(data));}
function manifest(id:string){return {schemaVersion:1,engineVersion:'0.1.0',id,name:'Demo',createdAt:'2026-09-17T00:00:00Z',scenes:[{id:'scene-main',path:'scenes/main.json'}]};}
function partial(r:string,id:string){const d=join(r,'projects',id);fs.mkdirSync(join(d,'scenes'),{recursive:true});fs.writeFileSync(join(d,'project.json'),JSON.stringify(manifest(id)));return d;}
try {
// Startup containment bypass: not a request-path test.
{const r=root(), ext=root();partial(ext,'demo');fs.mkdirSync(join(r,'projects'));fs.symlinkSync(join(ext,'projects','demo'),join(r,'projects','demo'),'dir');const s=svc(r);log('SCAN_SYMLINK',{report:s.lastScan,externalWritten:fs.existsSync(join(ext,'projects/demo/scenes/main.json')),query:q(s)});}
// Internal path symlinks also escape during a regular command.
{const r=root(), ext=root(),s=svc(r);s.createProject('demo','D');const d=join(r,'projects/demo');fs.renameSync(join(d,'scenes'),join(ext,'scenes'));fs.symlinkSync(join(ext,'scenes'),join(d,'scenes'),'dir');log('SCENES_SYMLINK',{command:cmd(s),externalRevision:JSON.parse(fs.readFileSync(join(ext,'scenes/main.json'),'utf8')).scene.revision});}
// Bounded report must not bound actual scan.
{const r=root();for(let n=0;n<101;n++)partial(r,'p'+n.toString().padStart(3,'0'));const s=svc(r);log('SCAN_CAP',{total:s.lastScan.total,reported:s.lastScan.entries.length,firstWritten:fs.existsSync(join(r,'projects/p000/scenes/main.json')),lastWritten:fs.existsSync(join(r,'projects/p100/scenes/main.json'))});}
// No-op create must inspect disk without acquiring ownership.
{const r=root(),s=svc(r);s.createProject('demo','D');const t=svc(r,{backendId:idB});log('CREATE_LIVE_OWNER',t.createProject('demo','Other'));s.releaseWorkspace('demo');log('CREATE_RELEASED_SELF',s.createProject('demo','Other'));const own=join(r,'projects/demo/.thirdlight/ownership.json'), before=fs.readFileSync(own,'utf8');log('CREATE_RELEASED_OTHER',{result:t.createProject('demo','Other'),ownershipChanged:fs.readFileSync(own,'utf8')!==before});}
// Invalid existing envelope must not cause writes (including ownership).
{const r=root(),s=svc(r);s.createProject('demo','D');const d=join(r,'projects/demo');fs.unlinkSync(join(d,'.thirdlight/ownership.json'));fs.writeFileSync(join(d,'scenes/main.json'),'{ broken');const t=svc(r,{backendId:idB});log('CREATE_INVALID_WRITES',{result:t.createProject('demo','Other'),ownershipCreated:fs.existsSync(join(d,'.thirdlight/ownership.json'))});}
// Unreadable != absent: mode 000 record is overwritten by a second backend.
{const r=root(),s=svc(r);s.createProject('demo','D');const p=join(r,'projects/demo/.thirdlight/ownership.json');fs.chmodSync(p,0);const t=svc(r,{backendId:idB});const result=q(t);fs.chmodSync(p,0o644);log('UNREADABLE_OWNER',{result,owner:JSON.parse(fs.readFileSync(p,'utf8')).backendId,firstStillOpen:q(s).ok});}
// /proc inspection EACCES is unknown not dead.
{const r=root(),proc=root(),s=svc(r);s.createProject('demo','D');const pd=join(proc,String(process.pid));fs.mkdirSync(pd);fs.writeFileSync(join(pd,'stat'),'irrelevant');fs.chmodSync(pd,0);const t=svc(r,{backendId:idB,procRoot:proc});const query=q(t);const takeover=t.takeoverWorkspace('demo');fs.chmodSync(pd,0o755);log('PROC_EACCES',{query,takeover,realOwnerStillAlive:q(s).ok});}
// Interleave a second claimant after A evaluated absent, before A's rename.
{const r=root(),seed=svc(r);seed.createProject('demo','D');fs.unlinkSync(join(r,'projects/demo/.thirdlight/ownership.json'));let b:any,bResult:any;let fired=false;const a=svc(r,{ops:{...ops,renameFile(from:string,to:string){if(to.endsWith('/ownership.json')&&!fired){fired=true;b=svc(r,{backendId:idB});bResult=q(b);}ops.renameFile(from,to);}}});const aResult=q(a);log('CLAIM_RACE',{a:aResult.ok,b:bResult.ok,bStillOpen:q(b).ok,owner:JSON.parse(fs.readFileSync(join(r,'projects/demo/.thirdlight/ownership.json'),'utf8')).backendId});}
// Pruning name order loses the newest within the same UTC second.
{const r=root(),s=svc(r,{stamp:()=> '20260918T120000Z'});s.createProject('demo','D');const dir=join(r,'projects/demo'), env=join(dir,'scenes/main.json'), rec=join(dir,'.thirdlight/recovery');const values=Array.from({length:17},(_,i)=>'foreign-'+i).sort((a,b)=>hash(b).localeCompare(hash(a)));let result:any;for(let i=0;i<values.length;i++){fs.writeFileSync(env,values[i]);result=cmd(s,i+1);if(i<16)s.discardExternalState('demo');}const files=fs.readdirSync(rec);log('RECOVERY_NEWEST_PRUNED',{error:result.error.code,count:files.length,newest:values[16],newestRetained:files.some(n=>fs.readFileSync(join(rec,n),'utf8')===values[16]),discard:s.discardExternalState('demo')});}
// Error echoes on envelope-level query failures.
{const s=svc(root());log('QUERY_ECHO',s.query({op:'queryProject',projectId:'demo',extra:true}));}
} finally {for(const r of roots)fs.rmSync(r,{recursive:true,force:true});}
function hash(v:string){return createHash('sha256').update(v).digest('hex');}
