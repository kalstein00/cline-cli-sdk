const element = id => document.getElementById(id);
let current = {generation:0,snapshot:null,preflight:null,busy:false};
let sending=false, pending=null, requestError=false;
let transportConnected=true;
let restoringServer=false;
const drafts=new Map();
const draftKey=packet=>packet.snapshot?.sessionId ?? packet.executions?.find(e=>e.executionId===packet.selectedId)?.sessionId ?? packet.selectedId ?? 'new';
function selectionBlocked(packet) {return !transportConnected||sending||!!pending||packet.busy||packet.snapshot?.inputControl?.current===false||(packet.launchReserved&&!packet.snapshot?.executionId)||[packet.snapshot?.response,packet.snapshot?.messageDelivery,packet.snapshot?.resume].some(d=>['submitting','delivery-unknown'].includes(d?.state));}
function renderConversations(packet) {
  const nav=element('conversations'),groups=new Map();
  const expanded=new Set([...nav.querySelectorAll('details[open]')].map(details=>details.dataset.sessionId));
  for(const run of packet.executions ?? []){const key=run.sessionId ?? run.executionId;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);}
  nav.replaceChildren();
  for(const [key,runs] of groups){const group=document.createElement('section'),title=document.createElement('p');title.className='subtle';title.textContent=key;group.append(title);
    const historical=runs.filter(run=>run.supersededBy && runs.some(next=>next.executionId===run.supersededBy && next.remoteRoot===run.remoteRoot && next.sessionId===run.sessionId));
    const add=(run,parent,past=false)=>{const button=document.createElement('button');button.type='button';button.textContent=past?`이전 실행 · ${run.executionId.slice(-8)}`:run.title;button.title=run.executionId;button.dataset.executionId=run.executionId;button.setAttribute('aria-current',String(run.executionId===packet.selectedId));button.disabled=selectionBlocked(packet)||run.executionId===packet.selectedId;button.onclick=()=>changeSelection('select',{executionId:run.executionId});parent.append(button);};
    for(const run of runs.filter(run=>!historical.includes(run)))add(run,group);
    if(historical.length){const details=document.createElement('details'),summary=document.createElement('summary');details.dataset.sessionId=key;details.open=expanded.has(key);summary.textContent='이전 실행 기록';details.append(summary);for(const run of historical)add(run,details,true);group.append(details);}nav.append(group);
  }
  element('new').disabled=!packet.preflight?.ready||selectionBlocked(packet);element('list').disabled=!packet.preflight?.ready||sending||packet.busy;
  element('title').textContent=(packet.executions ?? []).find(e=>e.executionId===packet.selectedId)?.title ?? '새 대화';
}
async function changeSelection(action,input={}) {
  if(selectionBlocked(current))return;sending=true;element('error').hidden=true;render(current);
  try{await invoke(action,input);}catch(error){showError(error);}finally{sending=false;render(current);}
}
const settings=['host','cliPath','remoteRoot','cwd','dataDir','storageMode','sessionDirectory'];
try {const saved=JSON.parse(localStorage.getItem('cline-chat-settings') ?? '{}');for(const id of settings)if(typeof saved[id]==='string')element(id).value=saved[id];} catch {}
const timeline=element('timeline');
function canRespond(snapshot) {
  return transportConnected && current.capabilities?.responses && snapshot?.connection==='connected' && snapshot.historySync.current &&
    snapshot.interaction?.state==='awaiting-response' && snapshot.interaction.kind!=='unsupported' &&
    !['submitting','delivery-unknown'].includes(snapshot.response?.state) && !snapshot.stop && !sending && !pending && !current.busy;
}
function freeResponse(snapshot) {return !snapshot?.stop && !['completed','stopped','failed'].includes(snapshot?.execution) && snapshot?.interaction?.kind==='question' && current.capabilities?.freeText && snapshot.interaction.responseKinds?.includes('text');}
function renderInteractions(snapshot) {
  const container=element('interactions'),interaction=snapshot?.interaction;
  for(const card of [...container.children])if(card.dataset.kind==='unsupported'&&card.dataset.interactionId!==interaction?.id)card.remove();
  if(interaction) {
    let card=[...container.children].find(n=>n.dataset.interactionId===interaction.id);
    if(!card) {card=document.createElement('article');card.className='interaction';card.dataset.interactionId=interaction.id;card.dataset.kind=interaction.kind;card.dataset.sessionId=snapshot.sessionId;card.dataset.executionId=snapshot.executionId;
      const title=document.createElement('h3'),prompt=document.createElement('p'),args=document.createElement('pre'),buttons=document.createElement('div'),status=document.createElement('p');
      title.textContent=interaction.kind==='approval'?'도구 실행 승인':interaction.kind==='unsupported'?'지원하지 않는 상호작용':'Cline의 질문';
      prompt.className='prompt';args.className='arguments';buttons.className='choices';status.className='interaction-status';card.append(title,prompt,args,buttons,status);container.append(card);
    }
    card.querySelector('.prompt').textContent=interaction.prompt;
    const args=card.querySelector('.arguments');args.hidden=interaction.kind!=='approval';args.textContent=interaction.kind==='approval'?`${interaction.toolName}\n${JSON.stringify(interaction.toolInput,null,2)}`:'';
    const buttons=card.querySelector('.choices');
    if(card.dataset.choices!==JSON.stringify(interaction.choices)){buttons.replaceChildren();card.dataset.choices=JSON.stringify(interaction.choices);for(const answer of interaction.choices){const button=document.createElement('button');button.type='button';button.textContent=interaction.kind==='approval'?(answer==='Approve'?'승인':answer==='Deny'?'거절':answer):answer;button.onclick=()=>respondChoice(answer,interaction.id);buttons.append(button);}}
  }
  for(const card of container.children){
    const active=card.dataset.interactionId===interaction?.id && card.dataset.executionId===snapshot?.executionId;
    for(const button of card.querySelectorAll('button'))button.disabled=!active||!canRespond(snapshot);
    const response=snapshot?.response?.interactionId===card.dataset.interactionId?snapshot.response:null;
    if(response)card.dataset.delivery=response.state;
    const delivery=response?.state ?? card.dataset.delivery;
    card.querySelector('.interaction-status').textContent=delivery==='delivery-unknown'?'응답 전달 여부를 확인해야 합니다.':delivery==='submitting'?'응답 전송 중':delivery==='delivered'?'응답 전달 확인':delivery==='not-submitted'?'제출되지 않았습니다. 현재 질문을 확인하세요.':!active?'지난 단계':interaction?.kind==='unsupported'?'현재 CLI 화면을 안전하게 처리할 수 없습니다.':!snapshot?.historySync.current?'대화 기록 확인 중':snapshot?.connection!=='connected'?'연결 복구 후 응답할 수 있습니다.':'현재 질문에 응답하세요.';
  }
}
async function respondChoice(answer,interactionId) {
  const snapshot=current.snapshot;
  if(!canRespond(snapshot)||snapshot.interaction.id!==interactionId)return;
  pending={action:'respond',text:answer,fromComposer:false,requestId:crypto.randomUUID(),generation:current.generation};sending=true;requestError=false;element('error').hidden=true;render(current);
  try{await invoke('respond',{generation:pending.generation,requestId:pending.requestId,sessionId:snapshot.sessionId,executionId:snapshot.executionId,interactionId,revision:snapshot.revision,answer});}
  catch(error){requestError=true;showError(error);if(error.notSubmitted===true)pending=null;}
  finally{sending=false;render(current);}
}
function render(packet) {
  if(current.serverId && packet.serverId!==current.serverId)return;
  if (packet.generation < current.generation) return;
  if (packet.generation === current.generation && packet.snapshot && current.snapshot && packet.snapshot.revision < current.snapshot.revision) return;
  if(packet.generation>current.generation){drafts.set(draftKey(current),element('message').value);element('messages').replaceChildren();element('interactions').replaceChildren();element('message').value=drafts.get(draftKey(packet)) ?? '';element('error').hidden=true;requestError=false;}
  // A provisional execution key becomes its SID once history is confirmed.
  if(packet.generation===current.generation && current.selectedId && !current.snapshot?.sessionId && packet.snapshot?.sessionId){const saved=drafts.get(current.selectedId);if(saved!==undefined)drafts.set(packet.snapshot.sessionId,saved);}
  current=packet;
  const snapshot=packet.snapshot;
  if(snapshot?.executionId && snapshot.historySync.current)restoringServer=false;
  renderConversations(packet);
  if(snapshot?.executionId)try{localStorage.setItem('cline-chat-selected',snapshot.executionId);}catch{}
  const atBottom=timeline.scrollHeight-timeline.clientHeight-timeline.scrollTop < 80;
  const oldTop=timeline.scrollTop;
  element('connection').textContent=snapshot?.connection ?? '연결 전';
  const startHint=!packet.preflight?'연결 설정에서 연결 확인을 먼저 실행하세요.':!packet.preflight.ready?`연결 확인 필요 · ${packet.preflight.problems.join(' · ')}`:snapshot?.connection!=='connected'?'연결 복구 후 첫 메시지를 보낼 수 있습니다.':'첫 메시지는 원격 Cline의 새 작업을 시작합니다.';
  element('status').textContent=snapshot?.startup?.state==='provider-setup-required'?'CLI 초기 설정 필요':snapshot?.executionId ? `${snapshot.execution} · ${snapshot.sessionId ?? '대화 확인 중'}` : packet.preflight?.ready && snapshot?.connection==='connected' ? '새 대화를 시작할 수 있습니다.' : '연결 설정을 확인하세요.';
  element('preflight').textContent=packet.preflight ? packet.preflight.ready ? '연결 준비 완료' : packet.preflight.problems.join(' · ') : '';
  element('preflightDetails').textContent=packet.preflight ? [
    `CLI: ${packet.preflight.cliPath ?? '확인 불가'}`,`SHA-256: ${packet.preflight.cliHash ?? '확인 불가'}`,
    `경로 발견: ${packet.preflight.discovery ?? '확인 불가'}`,`도움말: ${packet.preflight.help?.state ?? '확인 불가'} (${packet.preflight.help?.exitCode ?? '종료 코드 불명'})`,
    packet.preflight.missingOptions === null ? '옵션 지원 확인 불가' : `누락 옵션: ${packet.preflight.missingOptions?.join(', ') || '없음'}`].join(' · ') : '';
  element('connect').disabled=!transportConnected||sending || (!!pending&&!restoringServer) || packet.launchReserved || !!snapshot?.executionId;
  element('disconnect').disabled=!transportConnected||sending||packet.busy||snapshot?.connection!=='connected';
  element('reconnect').disabled=!transportConnected||sending||packet.busy||!snapshot||snapshot.connection==='connected';
  element('reconfirm').disabled=!transportConnected||sending||packet.busy||snapshot?.connection!=='connected'||!snapshot?.executionId;
  element('stop').disabled=!transportConnected||sending||packet.busy||(!!pending && pending.action!=='start')||snapshot?.connection!=='connected'||!snapshot?.executionId||!!snapshot.stop||['completed','stopped','failed'].includes(snapshot.execution);
  element('stopStatus').textContent=snapshot?.stop?.state==='confirmed' && snapshot.stop.childrenVerified && snapshot.stop.remaining.length===0 && snapshot.execution==='stopped'?'중단 확인 · CLI와 추적 자식 종료':snapshot?.stop?.state==='stopping'?'중단 요청 처리 중':snapshot?.stop?'중단 여부 불명 · 종료 근거 확인 필요':'';
  const messages=element('messages');
  let changed=false;
  const visible=new Set();
  for (const [index,message] of (snapshot?.messages ?? []).entries()) {
    visible.add(message.id);
    let node=[...messages.children].find(node => node.dataset.messageId === message.id);
    if (!node) {
      node=document.createElement('article');node.dataset.messageId=message.id;node.dataset.role=message.role;
      const role=document.createElement('div');role.className='role';role.textContent=message.role === 'user' ? '나' : 'Cline';
      const text=document.createElement('p');text.className='text';node.append(role,text);changed=true;
    }
    const text=node.querySelector('.text');if(text.textContent!==message.text){text.textContent=message.text;changed=true;}
    const thoughts=(message.content ?? []).filter(part => ['thinking','redacted_thinking'].includes(part.type));
    const key=JSON.stringify(thoughts);
    if(node.dataset.thoughts !== key){
      node.querySelector('details')?.remove();node.dataset.thoughts=key;
      if(thoughts.length){const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('p');summary.textContent='생각 과정';body.className='text';body.textContent=thoughts.map(part=>part.type==='thinking'?part.thinking:'CLI에서 가려진 내용입니다.').join('\n');details.append(summary,body);node.append(details);}
    }
    if(messages.children[index] !== node)messages.insertBefore(node,messages.children[index] ?? null);
  }
  for(const node of [...messages.children])if(!visible.has(node.dataset.messageId)){node.remove();changed=true;}
  const preview=element('streaming'),stream=snapshot?.streaming;
  if(preview.hidden!==!stream?.text){preview.hidden=!stream?.text;changed=true;}
  const previewText=preview.querySelector('.text');
  if(previewText.textContent!==(stream?.text ?? '')){previewText.textContent=stream?.text ?? '';changed=true;}
  preview.dataset.turnId=stream?.turnId ?? '';
  preview.querySelector('.stream-note').textContent=stream?.truncated?'일부 미리보기입니다. 완료된 답변을 기다리고 있습니다.':'';
  element('empty').hidden=!!snapshot?.messages.length||!!stream?.text;
  if(pending && (pending.action==='stop' ? snapshot?.stop?.requestId===pending.requestId && snapshot.execution==='stopped' && snapshot.stop.state==='confirmed' && snapshot.stop.childrenVerified : pending.action==='resume' ? snapshot?.resume?.requestId===pending.requestId && snapshot.resume.state==='delivered' : pending.action==='respond' ? snapshot?.response?.requestId===pending.requestId && snapshot.response.state==='delivered' : pending.action==='message' ? snapshot?.messageDelivery?.requestId===pending.requestId && snapshot.messageDelivery.state==='delivered' && snapshot.messages.some(m=>m.id===snapshot.messageDelivery.messageId) : snapshot?.messages.some(message=>message.role==='user'&&message.text===pending.text&&!pending.baseline.includes(message.id)))) {
    if(pending.fromComposer!==false && element('message').value===pending.text)element('message').value='';pending=null;requestError=false;
  }
  if(pending?.action==='respond' && snapshot?.response?.requestId===pending.requestId && snapshot.response.state==='not-submitted'){pending=null;showError(Error('응답이 제출되지 않았습니다. 현재 질문을 확인하세요.'));}
  if(pending?.action==='message' && snapshot?.messageDelivery?.requestId===pending.requestId && snapshot.messageDelivery.state==='not-submitted'){pending=null;requestError=false;showError(Error('메시지가 제출되지 않았습니다. 초안을 확인한 뒤 직접 전송하세요.'));}
  if(pending?.action==='resume' && snapshot?.resume?.requestId===pending.requestId && snapshot.resume.state==='not-submitted'){pending=null;requestError=false;showError(Error('이미 재개된 대화입니다. 메시지는 제출되지 않았습니다. 현재 대화를 선택한 뒤 초안을 직접 전송하세요.'));}
  if(pending?.action==='start' && snapshot?.execution==='stopped' && snapshot.stop?.state==='confirmed' && snapshot.stop.childrenVerified && snapshot.stop.remaining.length===0){pending=null;requestError=false;}
  renderInteractions(snapshot);
  element('pending').hidden=!pending;
  element('pending').textContent=pending ? `${snapshot?.startup?.state==='provider-setup-required'?'CLI 초기 설정 필요 · 첫 요청 수신을 아직 확인하지 못했습니다.':requestError?'전달 여부를 확인해야 합니다. 자동 재전송하지 않습니다.':'전송 중'}\n${pending.text}` : '';
  const canStart=packet.preflight?.ready && snapshot?.connection==='connected' && !snapshot.executionId && !packet.selectedId;
  const canMessage=packet.capabilities?.sendMessage && snapshot?.messageInput?.ready;
  const canResume=packet.capabilities?.resume && snapshot?.connection==='connected' && snapshot.historySync.current && ['completed','stopped'].includes(snapshot.execution);
  const questionText=freeResponse(snapshot),canAnswer=questionText&&canRespond(snapshot);
  element('composerLabel').textContent=questionText?'현재 질문에 자유 응답':canResume?'종료된 대화에 재개 요청':'메시지';
  element('send').textContent=questionText?'질문 응답 보내기':canResume?'대화 재개하여 보내기':snapshot?.executionId?'메시지 보내기':'첫 메시지 보내기';
  element('send').disabled=!transportConnected||!(canStart||canMessage||canAnswer||canResume) || sending || packet.busy || (packet.launchReserved&&!snapshot?.executionId) || !!pending;
  const reasons={'ready':'다음 메시지 입력 준비 완료 · UTF-8 112바이트 이내의 한 줄','agent-busy':'Cline이 답변을 생성하거나 도구를 실행 중입니다.','interaction-pending':'대기 중인 질문이나 승인을 먼저 처리하세요.','delivery-pending':'이전 요청의 전달 상태를 확인 중입니다.','not-connected':'연결 복구 후 입력 상태를 다시 확인합니다.','history-unavailable':'대화 기록을 다시 확인 중입니다.','process-unconfirmed':'원격 프로세스를 확인 중입니다.','composer-unconfirmed':'빈 입력창을 확인 중입니다.','unsupported-profile':'이 CLI 프로필에서는 후속 입력을 지원하지 않습니다.'};
  element('hint').textContent=snapshot?.executionId ? (reasons[snapshot.messageInput?.reason] ?? '후속 입력 상태를 확인 중입니다.') : startHint;
  if(snapshot?.interaction)element('hint').textContent=questionText?'현재 질문 응답 · UTF-8 1,024바이트 이내의 한 줄':snapshot.interaction.kind==='unsupported'?'지원하지 않는 상호작용입니다. 일반 전송과 응답을 차단합니다.':'현재 질문/승인의 선택 버튼을 사용하세요.';
  if(packet.launchReserved && !snapshot?.executionId)element('hint').textContent='시작 여부를 확인해야 합니다. 새 요청을 자동 전송하지 않습니다.';
  if(snapshot && !snapshot.historySync.current && snapshot.executionId)element('hint').textContent='기록 확인 중입니다. 마지막 정상 대화를 유지합니다.';
  if(snapshot?.inputControl?.current===false)element('hint').textContent='입력 전달 기록을 확인할 수 없습니다. 기존 요청을 재전송하지 않습니다.';
  if(canResume)element('hint').textContent='같은 대화를 새 실행으로 재개합니다 · UTF-8 112바이트 이내의 한 줄';
  if(snapshot?.supersededBy)element('hint').textContent='이전 실행 기록입니다. 대화 목록에서 현재 대화를 선택하면 계속할 수 있습니다.';
  if(snapshot?.startup?.state==='provider-setup-required' && !snapshot.stop)element('hint').textContent='CLI 초기 설정 필요 · 현재 실행을 중단한 뒤, 인증이 설정된 CLI 데이터 디렉터리로 새 대화를 시작하세요.';
  if(changed){if(atBottom){timeline.scrollTop=timeline.scrollHeight;element('newMessages').hidden=true;}else{timeline.scrollTop=oldTop;element('newMessages').hidden=false;}}
}
async function invoke(action,input) {
  const started=current.generation,startedServer=current.serverId,maxGeneration=started+(['connect','select','new'].includes(action)?1:0);
  try {
    const response=await fetch(`/api/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverId:startedServer,generation:started,requestId:crypto.randomUUID(),...input})});
    const packet=await response.json();if(current.serverId!==startedServer||current.generation>maxGeneration||packet.generation<current.generation)return;render(packet);
    if(!response.ok)throw Object.assign(Error(`${packet.error}: ${packet.message ?? ''}`),{notSubmitted:packet.notSubmitted===true});
    return packet;
  }catch(error){if(current.serverId!==startedServer||current.generation>maxGeneration)return;throw error;}
}
function showError(error){element('error').hidden=false;element('error').textContent=error.message;}
element('connectForm').onsubmit=async event=>{
  event.preventDefault();if(sending)return;sending=true;element('error').hidden=true;render(current);
  try {
    localStorage.setItem('cline-chat-settings',JSON.stringify(Object.fromEntries(settings.map(id=>[id,element(id).value]))));
    await invoke('connect',{...Object.fromEntries(['host','cliPath','remoteRoot','identityFile','storageMode','sessionDirectory'].map(id=>[id,element(id).value])),executionId:localStorage.getItem('cline-chat-selected') ?? undefined});
  }catch(error){showError(error);}finally{sending=false;render(current);}
};
element('composer').onsubmit=async event=>{
  event.preventDefault();if(element('send').disabled || sending)return;
  const text=element('message').value;
  const answerMode=freeResponse(current.snapshot);
  const resumeMode=!!current.capabilities?.resume&&!answerMode;
  const followup=!!current.snapshot?.executionId&&!answerMode;
  if(answerMode && (!text||text.trim()!==text||new TextEncoder().encode(text).length>1024||/[\p{Cc}\p{Cs}]/u.test(text)||[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].some(({segment})=>new TextEncoder().encode(segment).length>64))){showError(Error('질문 응답은 UTF-8 1,024바이트 이내의 printable 한 줄입니다.'));return;}
  if(followup && (!text||text.trim()!==text||new TextEncoder().encode(text).length>112||/[\p{Cc}\p{Cs}]/u.test(text)||text.startsWith('/')||text.includes('@')||[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].some(({segment})=>new TextEncoder().encode(segment).length>64))){showError(Error('후속 메시지는 UTF-8 112바이트 이내의 한 줄입니다. 앞뒤 공백, 제어 문자, slash command, @ mention을 제외하세요.'));return;}
  if(!text.trim()||text.length>100000){showError(Error('비어 있지 않은 100,000자 이내의 첫 요청을 입력하세요.'));return;}
  pending={text,action:answerMode?'respond':resumeMode?'resume':followup?'message':'start',baseline:(current.snapshot?.messages??[]).map(m=>m.id),requestId:crypto.randomUUID(),generation:current.generation};sending=true;requestError=false;element('error').hidden=true;render(current);
  const attempted=pending;
  try{await invoke(pending.action,{requestId:pending.requestId,generation:pending.generation,...(answerMode?{answer:text,interactionId:current.snapshot.interaction.id,sessionId:current.snapshot.sessionId,executionId:current.snapshot.executionId,revision:current.snapshot.revision}:followup?{text,sessionId:current.snapshot.sessionId,executionId:current.snapshot.executionId,revision:current.snapshot.revision}:{cwd:element('cwd').value,dataDir:element('dataDir').value,prompt:text})});}
  catch(error){
    if(attempted.action==='resume' && current.snapshot?.resume?.requestId===attempted.requestId && current.snapshot.resume.state==='not-submitted')error=Object.assign(Error('이미 재개된 대화입니다. 현재 대화를 선택하세요.'),{notSubmitted:true});
    requestError=true;showError(error);if(error.notSubmitted===true){pending=null;requestError=false;showError(Error(`${error.message} · 메시지가 제출되지 않았습니다. 초안을 확인한 뒤 직접 전송하세요.`));}
  }
  finally{sending=false;render(current);}
};
element('message').onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229&&!event.shiftKey){event.preventDefault();element('composer').requestSubmit();}};
element('newMessages').onclick=()=>{timeline.scrollTop=timeline.scrollHeight;element('newMessages').hidden=true;};
element('new').onclick=()=>changeSelection('new');element('list').onclick=()=>changeSelection('list');
for(const action of ['disconnect','reconnect','reconfirm'])element(action).onclick=async()=>{if(sending||current.busy)return;sending=true;element('error').hidden=true;render(current);try{await invoke(action,{});}catch(error){showError(error);}finally{sending=false;render(current);}};
element('stop').onclick=async()=>{if(element('stop').disabled)return;const snapshot=current.snapshot;pending={action:'stop',fromComposer:false,text:'현재 작업 중단 요청',requestId:crypto.randomUUID(),generation:current.generation};sending=true;requestError=false;element('error').hidden=true;render(current);try{await invoke('stop',{requestId:pending.requestId,generation:pending.generation,sessionId:snapshot.sessionId,executionId:snapshot.executionId});}catch(error){requestError=true;showError(error);if(error.notSubmitted)pending=null;}finally{sending=false;render(current);}};
const events=new EventSource('/api/events');events.onmessage=event=>{const packet=JSON.parse(event.data);if(current.serverId&&packet.serverId!==current.serverId){restoringServer=true;current={...current,generation:-1,serverId:packet.serverId};}transportConnected=true;render(packet);};
events.onerror=()=>{transportConnected=false;render(current);element('connection').textContent='서버 연결 확인 중';for(const button of document.querySelectorAll('button'))button.disabled=true;};
render(current);
element('storageMode').onchange=()=>{element('dataDir').disabled=element('storageMode').value==='native';};
element('storageMode').onchange();
