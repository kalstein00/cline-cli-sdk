import childProcess from 'node:child_process';
import {SdkError} from './reducer.js';
import type {ConnectionOptions} from './live.js';

/** Quote one POSIX shell argument. No remote executable source is transported. */
export function shellArg(value: string): string {
  if (value.includes('\0')) throw new SdkError('invalid-argument', 'NUL is not a shell argument.');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** tmux parses trailing semicolons even after the SSH shell has removed quotes. */
export function tmuxArg(value: string): string {
  return shellArg(value.endsWith(';') ? value.slice(0, -1) + '\\;' : value);
}

export function sshTransport(config: ConnectionOptions) {
  if (typeof config.host !== 'string' || !config.host || /^-/.test(config.host) || /[\s\0]/.test(config.host))
    throw new SdkError('invalid-connection', 'Specify an SSH host or configured alias.');
  if (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535))
    throw new SdkError('invalid-connection', 'Invalid SSH port.');
  for (const value of [config.identityFile, config.user, config.sshExecutable])
    if (value !== undefined && (!value || /[\r\n\0]/.test(value))) throw new SdkError('invalid-connection', 'Invalid SSH option.');
  const timeout = config.timeoutMs ?? 45000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300000)
    throw new SdkError('invalid-connection', 'SSH timeout must be 1–300000ms.');
  const active = new Set<ReturnType<typeof childProcess.spawn>>();
  let generation = 0;
  return {
    cancel() { generation++; for (const child of active) child.kill(); },
    async run(command: string, limit = 8 * 1024 * 1024): Promise<{stdout: string; stderr: string; code: number}> {
      const epoch = generation;
      const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=30'];
      if (config.identityFile) args.push('-i', config.identityFile, '-o', 'IdentitiesOnly=yes');
      if (config.user) args.push('-l', config.user);
      if (config.port) args.push('-p', String(config.port));
      args.push(config.host, command);
      return new Promise((resolve, reject) => {
        const child = childProcess.spawn(config.sshExecutable ?? 'ssh', args, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
        active.add(child);
        let bytes = 0, settled = false, stderr = '';
        const chunks: Buffer[] = [];
        const finish = (error?: Error, code?: number) => {
          if (settled) return;
          settled = true; clearTimeout(timer); active.delete(child);
          if (error) reject(error);
          else if (epoch !== generation) reject(new SdkError('connection-interrupted', 'The connection was detached.'));
          else if (code === 255 || code === undefined) reject(new SdkError('ssh-failed', 'SSH did not confirm the remote result.'));
          else resolve({stdout: Buffer.concat(chunks).toString('utf8'), stderr, code});
        };
        const timer = setTimeout(() => { finish(new SdkError('ssh-timeout', 'SSH timed out; remote work may still be running.')); child.kill(); }, timeout);
        child.stdout!.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit) { finish(new SdkError('remote-output-limit', 'Remote output exceeded the read limit.')); child.kill(); }
          else chunks.push(chunk);
        });
        // Drain stderr without reflecting potentially sensitive remote text in errors.
        child.stderr!.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length); });
        child.stdin!.on('error', () => {});
        child.once('error', () => finish(new SdkError('ssh-unavailable', 'OpenSSH could not be started.')));
        child.once('close', code => finish(undefined, code ?? undefined));
        child.stdin!.end();
      });
    },
  };
}
