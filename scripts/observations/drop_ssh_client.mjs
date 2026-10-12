// Terminate only the SSH client created by this observation, leaving its remote
// tmux session alone. This models a client process loss, not a physical outage.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const target = process.argv[2];
if (!target || !/^[a-zA-Z0-9_-]+$/.test(target)) {
  throw new Error('Expected the name of an observation tmux session');
}
const started = Date.now();
const outputHash = createHash('sha256');
let outputBytes = 0;
let intentionallyKilled = false;
let attached = false;
let killRequestedAt;
let exitedAt;
const stderr = [];
const outputPreview = [];
const child = spawn('ssh', [
  '-tt', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=30', 'wsl',
  'env', 'TERM=xterm-256color', 'tmux', '-L', 'cline-sdk-observe', 'attach-session', '-t', target,
], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let killTimer;
child.stdout.on('data', chunk => {
  outputBytes += chunk.length;
  outputHash.update(chunk);
  if (outputBytes < 8192) outputPreview.push(chunk);
  if (!attached) {
    attached = true;
    killTimer = setTimeout(() => {
      intentionallyKilled = true;
      killRequestedAt = new Date().toISOString();
      if (process.platform === 'win32') {
        // SSH's ProxyCommand otherwise retains inherited pipes after ssh dies.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        child.kill();
      }
    }, 1500);
  }
});
child.stderr.on('data', chunk => stderr.push(chunk));
const deadline = setTimeout(() => child.kill(), 45000);
child.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', () => { exitedAt = new Date().toISOString(); });
child.on('close', (code, signal) => {
  clearTimeout(deadline);
  clearTimeout(killTimer);
  console.log(JSON.stringify({
    target, localSshPid: child.pid, startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started, attached, intentionallyKilled,
    killRequestedAt, exitedAt,
    outputBytes, outputSha256: outputHash.digest('hex'), code, signal,
    stderr: Buffer.concat(stderr).toString('utf8').slice(-2000),
    failureOutput: intentionallyKilled ? undefined : Buffer.concat(outputPreview).toString('utf8').slice(-2000),
  }));
  if (!attached || !intentionallyKilled) process.exitCode = 1;
});
