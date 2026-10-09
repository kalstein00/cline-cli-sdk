import childProcess from 'node:child_process';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';

export const pinned = {
  platform:'Linux',python:true,pty:true,processOwnership:true,tmux:'tmux 3.4',
  cliPath:'/fixture/cline',cliVersion:'3.0.69',
  cliHash:'8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032',bootId:'boot-1',
};

// Replace only the external OpenSSH boundary; the SDK runs unchanged.
export function remote(t, responses) {
  t.mock.method(childProcess,'spawn',()=>{
    const process = new EventEmitter();
    process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.stdin = new PassThrough();
    process.kill=()=>queueMicrotask(()=>process.emit('close',130,null));
    let input='';
    process.stdin.on('data',data=>input+=data);
    process.stdin.on('finish',()=>{
      try {
        const response=responses.shift();
        if(response===undefined) throw new Error('Unexpected remote operation');
        const value=typeof response==='function'?response(JSON.parse(input)):response;
        process.stdout.end(JSON.stringify(value));
        queueMicrotask(()=>process.emit('close',0,null));
      } catch(error) {queueMicrotask(()=>process.emit('error',error));}
    });
    return process;
  });
}
