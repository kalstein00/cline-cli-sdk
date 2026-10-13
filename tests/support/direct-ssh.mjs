import childProcess from 'node:child_process';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';

// Only OpenSSH is substituted. Commands, public state and JSON parsing are real SDK code.
export function directRemote(t, options={}) {
  const commands=[], runs=new Map();
  let history=JSON.stringify({version:1,sessionId:'saved-chat',messages:[{id:'u1',role:'user',content:[{type:'text',text:'Prior conversation'}]}]});
  t.mock.method(childProcess,'spawn',(executable,args)=>{
    const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();
    p.kill=()=>queueMicrotask(()=>p.emit('close',null));
    let stdin='';p.stdin.on('data',v=>stdin+=v);
    p.stdin.on('finish',()=>{
      const command=args.at(-1);commands.push({executable,args,command,stdin});
      let stdout='',code=0;
      try {
        if(command==='uname -s')stdout='Linux\n';
        else if(command==='tmux -V')stdout=options.tmux ?? 'tmux 3.4\n';
        else if(command==='command -v cline')stdout='/installed/cline\n';
        else if(command.includes("'--help'")||command.endsWith(' --help'))stdout=options.help ?? '--cwd --auto-approve --tui --retries\n';
        else if(command.startsWith('test ')){
          if(command.includes('head -c')) {stdout=history;code=options.historyCode ?? 0;}
          else if(command.includes("'/missing'"))code=1;
        }
        else if(command.startsWith('printf '))stdout='/native/sessions';
        else if(command.startsWith('find '))stdout=options.sessions ?? 'saved-chat\0';
        else if(command.includes("'new-session'")){
          const id=command.match(/'sdk-[a-f0-9-]{36}'/)[0].slice(1,-1);
          const encoded=command.match(/'@cline_sdk_direct' '([^']+)'/)[1];runs.set(id,encoded);
          code=options.launchCode ?? 0;
        }
        else if(command.includes("'list-sessions'"))stdout=[...runs].map(([id,meta])=>id+'\t'+meta).join('\n');
        else if(command.includes("'list-panes'"))stdout=options.pane ?? '%0\t456\t80\t24\t0\t\n';
        else if(command.includes("'capture-pane'"))stdout=options.screen ?? 'Company custom CLI\n❯ Ask anything...\n';
        else throw Error('Unexpected command: '+command);
        if(options.intercept){const override=options.intercept(command);if(override){stdout=override.stdout ?? '';code=override.code ?? 0;if(override.stderr)p.stderr.write(override.stderr);}}
        p.stdout.end(stdout);queueMicrotask(()=>p.emit('close',code));
      }catch(error){queueMicrotask(()=>p.emit('error',error));}
    });return p;
  });
  return {commands,runs,setHistory:value=>{history=value;}};
}
