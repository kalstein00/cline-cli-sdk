// Windows development ProxyCommand: discover/start WSL separately, then relay
// only SSH bytes over TCP. WSL launch diagnostics never enter SSH stdout.
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {createConnection,isIPv4} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const [distribution,portText]=process.argv.slice(2),port=Number(portText);
const cacheDirectory=join(tmpdir(),'cline-sdk-wsl-ssh');
const cacheName=createHash('sha256').update(distribution??'').digest('hex');
const cachePath=join(cacheDirectory,cacheName+'.json'),lockPath=cachePath+'.lock';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function cached() {
 try {const value=JSON.parse(await readFile(cachePath,'utf8'));return isIPv4(value.address)&&Number.isFinite(value.checkedAt)?value:null;}
 catch {return null;}
}
function ownerIsAlive(pid) {
 if(!Number.isInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true;}
 catch(error){return error.code!=='ESRCH';}
}
async function discover(previous) {
 await mkdir(cacheDirectory,{recursive:true});
 const deadline=Date.now()+15000;
 let lock;
 while(!lock){
  try {lock=await open(lockPath,'wx',0o600);}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   // Another process can see the lock between creation and its first write.
   // A crashed writer leaves an empty file: its age must not reset each read.
   let modifiedAt;
   try{modifiedAt=(await stat(lockPath)).mtimeMs;}catch(error){if(error.code==='ENOENT')continue;throw error;}
   let owner;try{owner=JSON.parse(await readFile(lockPath,'utf8'));}catch{owner={};}
   const createdAt=Number.isFinite(owner?.at)?owner.at:modifiedAt;
   if(Date.now()-createdAt>20000&&!ownerIsAlive(owner?.pid)){await unlink(lockPath).catch(()=>{});continue;}
   if(Date.now()>deadline)throw Error('WSL address discovery is busy; connection was not established.');
   await delay(100);
  }
 }
 try {
  await lock.writeFile(JSON.stringify({at:Date.now(),pid:process.pid}));
  const current=await cached();
  if(current&&(!previous||current.checkedAt>previous.checkedAt))return current;
  const address=await new Promise((resolve,reject)=>{
   const child=spawn('wsl.exe',['-d',distribution,'--exec','hostname','-I'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   const output=[],errors=[];
   const timer=setTimeout(()=>{child.kill();reject(Error('WSL address discovery timed out.'));},8000);
   child.stdout.on('data',b=>output.push(b));child.stderr.on('data',b=>errors.push(b));
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('close',code=>{
    clearTimeout(timer);
    const bytes=Buffer.concat(output);
    if(code!==0){
     // wsl.exe reports launch errors as UTF-16 on stdout; keep them on stderr.
     const text=bytes.includes(0)?bytes.toString('utf16le'):bytes.toString('utf8');
     reject(Error((text||Buffer.concat(errors).toString('utf8')||'WSL could not start.').trim().slice(0,1000)));return;
    }
    const value=bytes.toString('utf8').trim().split(/\s+/).find(isIPv4);
    if(!value){reject(Error('WSL did not report an IPv4 address.'));return;}
    resolve(value);
   });
  });
  const value={address,checkedAt:Date.now()},temporary=cachePath+'.'+randomUUID();
  await writeFile(temporary,JSON.stringify(value),{mode:0o600});
  await rename(temporary,cachePath);return value;
 }finally{await lock.close();await unlink(lockPath).catch(()=>{});}
}
async function connect(address) {
 return await new Promise((resolve,reject)=>{
  const socket=createConnection({host:address,port});
  const timer=setTimeout(()=>socket.destroy(Error('WSL SSH TCP connection timed out.')),2000);
  socket.once('error',error=>{clearTimeout(timer);reject(error);});
  socket.once('connect',()=>{clearTimeout(timer);resolve(socket);});
 });
}
function fail(error){process.stderr.write('wsl-ssh-proxy: '+error.message+'\n');process.exitCode=1;process.stdin.destroy();process.stdout.end();}

try {
 if(!distribution||/[\r\n\0]/.test(distribution)||!Number.isInteger(port)||port<1||port>65535)throw Error('Usage: node wsl-ssh-proxy.mjs <distribution> <port>');
 const previous=await cached();let socket;
 if(previous)try{socket=await connect(previous.address);}catch{/* Discover once before SSH authentication or any remote command. */}
 if(!socket){const endpoint=await discover(previous);socket=await connect(endpoint.address);}
 socket.on('error',fail);
 socket.on('close',()=>process.stdin.destroy());
 process.stdin.on('error',()=>socket.destroy());process.stdout.on('error',()=>socket.destroy());
 process.once('SIGINT',()=>socket.destroy());process.once('SIGTERM',()=>socket.destroy());
 process.stdin.pipe(socket);socket.pipe(process.stdout);
}catch(error){fail(error);}
