const element = id => document.getElementById(id);
let current = {generation:0,snapshot:null,preflight:null,busy:false};
let sending=false, pending=null, requestError=false;
const settings=['host','cliPath','remoteRoot','cwd','dataDir'];
try {const saved=JSON.parse(localStorage.getItem('cline-chat-settings') ?? '{}');for(const id of settings)if(typeof saved[id]==='string')element(id).value=saved[id];} catch {}
const timeline=element('timeline');
function render(packet) {
  if (packet.generation < current.generation) return;
  if (packet.generation === current.generation && packet.snapshot && current.snapshot && packet.snapshot.revision < current.snapshot.revision) return;
  current=packet;
  const snapshot=packet.snapshot;
  const atBottom=timeline.scrollHeight-timeline.clientHeight-timeline.scrollTop < 80;
  const oldTop=timeline.scrollTop;
  element('connection').textContent=snapshot?.connection ?? '연결 전';
  element('status').textContent=snapshot?.executionId ? `${snapshot.execution} · ${snapshot.sessionId ?? '대화 확인 중'}` : '새 대화를 시작할 수 있습니다.';
  element('preflight').textContent=packet.preflight ? packet.preflight.ready ? '연결 준비 완료' : packet.preflight.problems.join(' · ') : '';
  element('connect').disabled=sending || !!pending || packet.launchReserved || !!snapshot?.executionId;
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
  element('empty').hidden=!!snapshot?.messages.length;
  if(pending && snapshot?.messages.some(message=>message.role==='user'&&message.text===pending.text)) {
    if(element('message').value===pending.text)element('message').value='';pending=null;requestError=false;
  }
  element('pending').hidden=!pending;
  element('pending').textContent=pending ? `${requestError?'전달 여부를 확인해야 합니다. 자동 재전송하지 않습니다.':'전송 중'}\n${pending.text}` : '';
  const canStart=packet.preflight?.ready && snapshot?.connection==='connected' && !snapshot.executionId;
  element('send').disabled=!canStart || sending || packet.busy || packet.launchReserved || !!pending;
  const reasons={'ready':'다음 메시지 입력 준비 완료 (전송은 다음 구현 단계에서 지원합니다).','agent-busy':'Cline이 답변을 생성하거나 도구를 실행 중입니다.','interaction-pending':'대기 중인 질문이나 승인을 먼저 처리하세요.','delivery-pending':'이전 요청의 전달 상태를 확인 중입니다.','not-connected':'연결 복구 후 입력 상태를 다시 확인합니다.','history-unavailable':'대화 기록을 다시 확인 중입니다.','process-unconfirmed':'원격 프로세스를 확인 중입니다.','composer-unconfirmed':'빈 입력창을 확인 중입니다.','unsupported-profile':'이 CLI 프로필에서는 후속 입력을 지원하지 않습니다.'};
  element('hint').textContent=snapshot?.executionId ? (reasons[snapshot.messageInput?.reason] ?? '후속 입력 상태를 확인 중입니다.') : '첫 메시지는 원격 Cline의 새 작업을 시작합니다.';
  if(packet.launchReserved && !snapshot?.executionId)element('hint').textContent='시작 여부를 확인해야 합니다. 새 요청을 자동 전송하지 않습니다.';
  if(snapshot && !snapshot.historySync.current && snapshot.executionId)element('hint').textContent='기록 확인 중입니다. 마지막 정상 대화를 유지합니다.';
  if(changed){if(atBottom){timeline.scrollTop=timeline.scrollHeight;element('newMessages').hidden=true;}else{timeline.scrollTop=oldTop;element('newMessages').hidden=false;}}
}
async function invoke(action,input) {
  const response=await fetch(`/api/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({generation:current.generation,requestId:crypto.randomUUID(),...input})});
  const packet=await response.json();render(packet);
  if(!response.ok)throw Object.assign(Error(`${packet.error}: ${packet.message ?? ''}`),{notSubmitted:packet.notSubmitted===true});
  return packet;
}
function showError(error){element('error').hidden=false;element('error').textContent=error.message;}
element('connectForm').onsubmit=async event=>{
  event.preventDefault();if(sending)return;sending=true;element('error').hidden=true;render(current);
  try {
    localStorage.setItem('cline-chat-settings',JSON.stringify(Object.fromEntries(settings.map(id=>[id,element(id).value]))));
    await invoke('connect',Object.fromEntries(['host','cliPath','remoteRoot','identityFile'].map(id=>[id,element(id).value])));
  }catch(error){showError(error);}finally{sending=false;render(current);}
};
element('composer').onsubmit=async event=>{
  event.preventDefault();if(element('send').disabled || sending)return;
  const text=element('message').value;
  if(!text.trim()||text.length>100000){showError(Error('비어 있지 않은 100,000자 이내의 첫 요청을 입력하세요.'));return;}
  pending={text,requestId:crypto.randomUUID(),generation:current.generation};sending=true;requestError=false;element('error').hidden=true;render(current);
  try{await invoke('start',{requestId:pending.requestId,generation:pending.generation,cwd:element('cwd').value,dataDir:element('dataDir').value,prompt:text});}
  catch(error){requestError=true;showError(error);if(error.notSubmitted===true)pending=null;}
  finally{sending=false;render(current);}
};
element('message').onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229&&!event.shiftKey){event.preventDefault();element('composer').requestSubmit();}};
element('newMessages').onclick=()=>{timeline.scrollTop=timeline.scrollHeight;element('newMessages').hidden=true;};
const events=new EventSource('/api/events');events.onmessage=event=>render(JSON.parse(event.data));
events.onerror=()=>{element('connection').textContent='서버 연결 확인 중';element('send').disabled=true;};
render(current);
