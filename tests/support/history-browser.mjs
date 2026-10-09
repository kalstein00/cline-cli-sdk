import cp from 'node:child_process';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
const root = new URL('../../', import.meta.url);
const stages = process.argv[2];
if (!stages)
    throw Error('Pass an absolute test-owned stage file path');
const record = JSON.parse(fs.readFileSync(new URL('fixtures/history-sync/recovery.json', root), 'utf8'));
let executionId;
const initial = record.observations.filter(o => o.seq <= 18);
const good = initial.filter(o => o.kind === 'history').at(-1).dataBase64;
const nextHistory = record.observations.find(o => o.seq === 20).dataBase64;
const pinned = { platform: 'Linux', python: true, pty: true, tmux: 'tmux 3.4', processOwnership: true, cliPath: '/fixture/cline', cliVersion: '3.0.69', cliHash: '8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032', bootId: 'fixture-boot' };
const native = cp.spawn;
cp.spawn = (...args) => {
    if (args[0] !== 'ssh' && args[0] !== 'ssh.exe')
        return native(...args);
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = new PassThrough();
    p.kill = () => { };
    let input = '';
    p.stdin.on('data', data => input += data);
    p.stdin.on('finish', () => {
        const request = JSON.parse(input);
        let out;
        if (!request.action)
            out = pinned;
        else if (request.action === 'start') {
            executionId = request.executionId;
            out = { executionId, remoteRoot: '/fixture/control' };
        }
        else if (request.action === 'status') {
            const stage = fs.readFileSync(stages, 'utf8').trim();
            const failure = ['read-failed', 'file-changed', 'missing'].includes(stage);
            const dataBase64 = stage === 'partial' ? Buffer.from('{"version":1,"messages":[').toString('base64') : stage === 'updated' ? nextHistory : good;
            out = { executionId: request.executionId, sessionId: record.sessionId, cursor: 18, observations: initial.filter(o => o.kind === 'pty' && o.seq > request.cursor),
                history: failure ? null : { dataBase64, sha256: crypto.createHash('sha256').update(Buffer.from(dataBase64, 'base64')).digest('hex') }, historyError: failure ? stage : null,
                process: { kind: 'process', identity: { pid: 42, startTime: '100', bootId: 'fixture-boot' }, alive: true, identityConfirmed: true, exitCode: null, manifestStatus: 'pending' } };
        }
        else if (request.action === 'respond' || request.action === 'reserve-response' || request.action === 'stop') {
            console.log('Rejected fixture input attempt: ' + request.action);
            out = { error: 'fixture-no-input', message: 'This reviewed fault source cannot send CLI input' };
        }
        else if (request.action === 'list')
            out = { executions: [] };
        else
            out = { error: 'fixture-unsupported', message: 'Unsupported test source action' };
        p.stdout.end(JSON.stringify(out));
        queueMicrotask(() => p.emit('close', 0, null));
    });
    return p;
};
process.env.CLINE_SDK_PORT ??= '4185';
await import(new URL('examples/web/server.mjs', root));
console.log('Ticket10 reviewed external OpenSSH fault source; no actual remote CLI/input/auth');
