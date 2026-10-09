"""Minimal durable resume reservation; history remains CLI-owned and read-only."""
import base64, fcntl, hashlib, json, os, re

def launch_resume(request, root, handle, identity, boot_id, save):
    old_id = request['executionId']
    new_id = request['newExecutionId']
    req_id = request['requestId']
    prompt = request['prompt']
    if not re.fullmatch(r'run-[a-f0-9-]{36}',old_id) or not re.fullmatch(r'run-[a-f0-9-]{36}',new_id) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}',req_id):
        raise ValueError('Invalid resume identity')
    if not isinstance(prompt,str) or not 0 < len(prompt.encode()) <= 112 or prompt != prompt.strip() or prompt.startswith('/') or '@' in prompt or any(ord(c)<32 or ord(c)==127 for c in prompt):
        raise ValueError('Resume requires printable one-row text up to 112 UTF-8 bytes without slash commands or mentions')
    old = root / old_id
    with open(root / 'resume.lock','a') as lock:
        os.chmod(root / 'resume.lock',0o600)
        fcntl.flock(lock,fcntl.LOCK_EX)
        binding = dict(fromExecutionId=old_id,requestId=req_id,promptDigest=hashlib.sha256(prompt.encode()).hexdigest())
        receipt_path = old / 'resume.json'
        if receipt_path.exists():
            receipt = json.loads(receipt_path.read_text())
            if any(receipt.get(k) != v for k,v in binding.items()):
                raise ValueError('This execution already has a resume reservation; do not create another run')
            return dict(executionId=receipt['executionId'],sessionId=receipt['sessionId'],remoteRoot=str(root),terminalMode='tui',resume=receipt)
        status = handle(dict(request,action='status',cursor=0,fullScreen=False))
        meta = json.loads((old / 'meta.json').read_text())
        proc = status['process']
        stop = proc.get('stop')
        if meta.get('owner') != 'cline-cli-sdk' or meta.get('cliHash') != request['cliHash'] or not status.get('sessionId') or proc.get('alive') is not False or proc.get('identityConfirmed') is not True or proc.get('exitCode') is None or proc.get('supervisorAlive') is not False or proc.get('childrenVerified') is not True or proc.get('children') or (stop and (stop.get('state')!='confirmed' or not stop.get('childrenVerified') or stop.get('remaining'))) or (not stop and (proc['manifestStatus']!='completed' or proc['exitCode']!=0)):
            raise ValueError('Resume requires confirmed ended CLI, supervisor, children and conversation')
        sid = status['sessionId']
        for candidate in root.glob('run-*/meta.json'):
            if candidate.parent == old: continue
            other = json.loads(candidate.read_text())
            if other.get('sessionId') != sid: continue
            expected = other.get('identity')
            supervisor = other.get('supervisorIdentity')
            if other.get('exitCode') is None or (expected and identity(expected['pid']) == expected) or (supervisor and identity(supervisor['pid']) == supervisor):
                raise ValueError('This conversation has a live or pending managed execution; reconnect it')
        history = json.loads(base64.b64decode(status['history']['dataBase64']))
        receipt = dict(binding,executionId=new_id,sessionId=sid,state='reserved',baselineMessageCount=len(history['messages']),baselineLastMessageId=history['messages'][-1]['id'] if history['messages'] else None)
        save(receipt_path,receipt)  # uncertain launch reserves this identity permanently
        meta.update(sessionId=sid, resumedBy=new_id, ownedManifestStatus=proc['manifestStatus'])
        save(old / 'meta.json',meta)
        launched = handle(dict(request,action='start',executionId=new_id,cwd=meta['cwd'],dataDir=meta['dataDir'],terminalMode='tui',_resume=receipt))
        receipt['state']='started'
        save(receipt_path,receipt)
        return dict(launched,resume=receipt)

def settle_resume(request,run,meta,session_files):
    resume = meta.get('resume')
    if not resume or request['requestId'] != resume['requestId']:
        raise ValueError('Unknown resume reservation')
    sid,_,history_path=session_files(meta)
    if sid != resume['sessionId'] or not history_path: return dict(state='delivery-unknown')
    doc=json.loads(history_path.read_bytes())
    def text(message):
        raw='\n'.join(p['text'] for p in message['content'] if p['type']=='text')
        return raw[23:-13] if raw.startswith('<user_input mode="act">') and raw.endswith('</user_input>') else raw
    count=resume.get('baselineMessageCount',len(resume.get('baselineMessageIds',[])))
    last=resume.get('baselineLastMessageId') or (resume.get('baselineMessageIds') or [None])[-1]
    if len(doc['messages']) < count or (count and doc['messages'][count-1]['id'] != last):
        return dict(state='delivery-unknown')  # rewritten/compacted history cannot silently resolve delivery
    matched=[m for m in doc['messages'][count:] if m['role']=='user' and hashlib.sha256(text(m).encode()).hexdigest()==resume['promptDigest']]
    if len(matched)!=1:return dict(state='delivery-unknown')
    # Return raw history identity witness. The consumer still checks fresh process/session.
    return dict(state='delivered',messageId=matched[0]['id'],promptDigest=resume['promptDigest'],sessionId=sid,executionId=meta['executionId'])
