"""Durable same-run composer reservation; conversation history is read-only."""
import hashlib, json, re

def reserve_message(request, run, meta, ledger_lock, input_binding, session_files, read_history, idle):
    req_id=request.get('requestId','')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}',req_id) or not re.fullmatch(r'[a-f0-9]{64}',request.get('answerDigest','')):
        raise ValueError('Invalid message identity')
    binding={key:request.get(key) for key in ('sessionId','executionId','interactionId','revision','toolId','kind','answerDigest')}
    if binding['kind']!='composer' or type(binding['revision']) is not int:
        raise ValueError('Invalid composer binding')
    with ledger_lock(run) as ledger:
        prior=ledger.get(req_id)
        if prior:
            if prior['binding']!=binding: raise ValueError('Request identity conflict')
            return dict(state=prior['state'],fresh=False)
        if len(ledger)>=256: raise ValueError('Message request limit reached')
        if any(not value.get('resolution') and value['state'] in ('reserved','queued','written') for value in ledger.values()):
            return dict(state='rejected',reason='input-pending',fresh=False,notSubmitted=True)
        cursor=json.loads((run/'buffer.json').read_text())['cursor']
        reason=input_binding(run,meta,dict(request,inputType='composer-text'),cursor) or idle(run,meta,empty=True)
        if reason: return dict(state='rejected',reason=reason,fresh=False,notSubmitted=True)
        sid,_,path=session_files(meta)
        history=json.loads(read_history(path))
        if sid!=binding['sessionId'] or history.get('sessionId')!=sid or history.get('version')!=1:
            return dict(state='rejected',reason='history-changed',fresh=False,notSubmitted=True)
        ledger[req_id]=dict(binding=binding,state='reserved',message=True,baselineMessageCount=len(history['messages']),baselineLastMessageId=history['messages'][-1]['id'] if history['messages'] else None)
        return dict(state='reserved',fresh=True)

def settle_message(request, run, meta, ledger_lock, session_files, read_history):
    with ledger_lock(run) as ledger:
        record=ledger.get(request.get('requestId'))
        if not record or not record.get('message'): raise ValueError('Unknown message reservation')
        steps=record.get('steps',{})
        if record['state']=='rejected' and (not steps or (list(steps)==['0'] and steps['0']['state']=='rejected')):
            # The lock also excludes late enqueue; a rejected first step cannot write.
            witness=dict(state='not-submitted',promptDigest=record['binding']['answerDigest'],sessionId=record['binding']['sessionId'],executionId=meta['executionId'],reason=record.get('reason'))
            record.update(resolution='not-submitted',witness=witness)
            return witness
        sid,_,path=session_files(meta)
        if sid!=record['binding']['sessionId'] or not path: return dict(state='delivery-unknown')
        doc=json.loads(read_history(path))
        if doc.get('sessionId')!=sid or doc.get('version')!=1: return dict(state='delivery-unknown')
        count=record['baselineMessageCount']
        if len(doc['messages'])<count or (count and doc['messages'][count-1]['id']!=record['baselineLastMessageId']):
            return dict(state='delivery-unknown')
        def text(message):
            raw='\n'.join(p['text'] for p in message['content'] if p['type']=='text')
            return raw[23:-13] if raw.startswith('<user_input mode="act">') and raw.endswith('</user_input>') else raw
        digest=record['binding']['answerDigest']
        matches=[m for m in doc['messages'][count:] if m['role']=='user' and hashlib.sha256(text(m).encode()).hexdigest()==digest]
        if len(matches)!=1: return dict(state='delivery-unknown')
        witness=dict(state='delivered',messageId=matches[0]['id'],promptDigest=digest,sessionId=sid,executionId=meta['executionId'])
        if not record.get('resolution') and record['state'] not in ('queued','written'): return dict(state='delivery-unknown')
        record.update(resolution='delivered',witness=witness)
        return witness
