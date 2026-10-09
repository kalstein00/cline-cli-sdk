import {createClient} from '@cline-cli-sdk/sdk';
import {randomUUID} from 'node:crypto';
const connection={host:process.env.CLINE_SDK_HOST??'wsl',cliPath:process.env.CLINE_SDK_CLI_PATH,remoteRoot:process.env.CLINE_SDK_REMOTE_ROOT,responseTimeoutMs:60000};
const cwd=process.env.CLINE_SDK_WORKSPACE,dataDir=process.env.CLINE_SDK_DATA_DIR;
if(!cwd||!dataDir)throw Error('Set CLINE_SDK_WORKSPACE and isolated CLINE_SDK_DATA_DIR.');
const sleep=()=>new Promise(ok=>setTimeout(ok,250));
async function until(c,condition){const deadline=Date.now()+240000;while(Date.now()<deadline){await c.refresh();if(condition(c.snapshot()))return c.snapshot();await sleep();}throw Error('Acceptance observation deadline');}
for(const scenario of ['completed','stopped']){
 const c=createClient({mode:'live',connection});
 try{
 await c.connect();
 await c.start({cwd,dataDir,terminalMode:scenario==='completed'?'readline':'tui',prompt:scenario==='completed'?'Reply exactly RESUME_INITIAL_DONE. Do not call any tools.':'Call ask_question with question STOP_BEFORE_RESUME and options WAIT,HOLD. Wait for answer. No other tools.'});
 let old=await until(c,s=>scenario==='completed'?s.execution==='completed':s.interaction?.kind==='question');
 if(scenario==='stopped'){const result=await c.stop({executionId:old.executionId,requestId:randomUUID()});if(result.state!=='confirmed'||!result.childrenVerified)throw Error('Stop not confirmed');old=await until(c,s=>s.execution==='stopped'&&s.executionEvidence?.supervisorAlive===false);}
 else old=await until(c,s=>s.execution==='completed'&&s.executionEvidence?.supervisorAlive===false&&s.executionEvidence.childrenVerified);
 console.log(JSON.stringify({scenario,oldExecutionId:old.executionId,sessionId:old.sessionId,state:old.execution,childrenVerified:old.executionEvidence.childrenVerified}));
 const prompt='Ask ask_question: RESUME_FOLLOWUP, options RED,BLUE. Print RESUME_RESULT:<answer>. No other tools.';
 const resumed=await c.resume({executionId:old.executionId,requestId:randomUUID(),prompt});
 console.log(JSON.stringify({scenario,resume:resumed.resume,oldMessages:old.messages.length,newMessages:resumed.messages.length}));
 const q=await until(c,s=>s.interaction?.kind==='question'&&s.interaction.prompt==='RESUME_FOLLOWUP');
 const answer=scenario==='completed'?'2 custom identifier':'한글 응답 가나다 😀 café';
 const result=await c.respond({sessionId:q.sessionId,executionId:q.executionId,interactionId:q.interaction.id,revision:q.revision,requestId:randomUUID(),answer});
 if(result.state!=='delivered')throw Error('Followup answer not delivered');
 const final=await until(c,s=>s.messages.some(m=>m.role==='assistant'&&m.text.includes('RESUME_RESULT:'+answer)));
 console.log(JSON.stringify({scenario,result,assistant:final.messages.at(-1).text,executionId:final.executionId,sessionId:final.sessionId}));
 // TUI keeps its composer alive: explicitly stop this example's own execution.
 const stop=await c.stop({executionId:final.executionId,requestId:randomUUID()});
 console.log(JSON.stringify({scenario,cleanup:stop}));
 } finally {c.close();}
}
