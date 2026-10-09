export function history(seq, messages, sessionId='content-session') {
  return {kind:'history',seq,observedAt:'2026-10-09T10:00:00Z',dataBase64:Buffer.from(JSON.stringify({version:1,sessionId,messages})).toString('base64')};
}
export function recording(observations) {
  return {schemaVersion:1,cli:{name:'cline',version:'3.0.69',profile:'cline-3.0.69-readline'},
    terminal:{rows:40,cols:120},sessionId:'content-session',executionId:'content-run',observations,
    provenance:{source:'controlled content fixture',sourceSha256:'synthetic',review:'No credentials; synthetic SDK contract probe, not company evidence',transformations:['synthetic content'],complete:false,truncated:false}};
}
export const ended=seq=>({kind:'process',seq,observedAt:'2026-10-09T10:00:00Z',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',children:[],childrenVerified:true,supervisorAlive:false});
