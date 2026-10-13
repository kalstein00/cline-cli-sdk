import {createHash, randomUUID} from 'node:crypto';
import {sshTransport, shellArg, tmuxArg} from './ssh.js';
import {cliFeatures} from './capabilities.js';
import {DEFAULT_TERMINAL, validTerminalSize} from './terminal-geometry.js';
import {createDiagnosticCollector} from './diagnostics.js';
import {createReducer, SdkError, type Snapshot, type SdkEvent} from './reducer.js';
import type {LiveClient, LiveOptions, ManagedExecution, PreflightReport} from './live.js';

const profile = 'ssh-tmux-readonly';
const idPattern = /^sdk-[0-9a-f-]{36}$/;
const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const disabledReason = 'SSH/tmux mode has no atomic input receipt or verified descendant ownership. Use the CLI directly for interaction.';
const fail = (code: string, message: string): never => { throw new SdkError(code, message); };
function absolute(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !/[\r\n\0]/.test(value) && value.length < 4096;
}

export function createLiveClient(options: LiveOptions): LiveClient {
  const config = structuredClone(options.connection);
  const transport = sshTransport(config);
  const diagnostics = createDiagnosticCollector();
  const reducer = createReducer({mode: 'replay', observe: (obs, events, snapshot) => diagnostics.capture(obs, events, snapshot)});
  const listeners = new Set<(event: SdkEvent) => void>();
  let revision = 0;
  const publish = (event: SdkEvent) => {
    const current = {...event, revision: ++revision};
    for (const listener of listeners) { try { listener(structuredClone(current)); } catch {} }
  };
  reducer.subscribe(publish);
  let report: PreflightReport | null = null;
  let selected: ManagedExecution | null = null;
  let closed = false, busy = false, epoch = 0, sequence = 0;
  let connection: Snapshot['connection'] = 'closed';
  let remoteObservation: Snapshot['remoteObservation'];
  let refreshing: Promise<Snapshot> | null = null;
  const socket = 'cline-sdk-direct-' + createHash('sha256').update(config.remoteRoot ?? 'default').digest('hex').slice(0, 16);
  const tmux = (args: string[]) => ['tmux', '-L', socket, '-f', '/dev/null', ...args].map(tmuxArg).join(' ');
  const stamp = () => ({seq: ++sequence, observedAt: new Date().toISOString()});
  const snapshot = (): Snapshot => ({...reducer.snapshot(), mode: 'live', connection, revision,
    messageInput: {ready: false, reason: 'remote-input-disabled', maxBytes: 0},
    remoteObservation: remoteObservation && structuredClone(remoteObservation)});
  const observeRemote = (observation: Snapshot['remoteObservation']) => {
    if (JSON.stringify(remoteObservation) === JSON.stringify(observation)) return;
    remoteObservation = structuredClone(observation);
    const observed = stamp();
    publish({type: 'state.changed', sessionId: selected?.sessionId ?? null, executionId: selected?.executionId ?? null,
      interactionId: null, requestId: null, revision, observationSeq: observed.seq, observedAt: observed.observedAt,
      payload: {remoteObservation}});
  };
  const connected = () => {
    if (closed) fail('client-closed', 'This client is closed.');
    if (connection !== 'connected') fail('not-connected', 'Connect before reading or starting remote work.');
  };
  const changed = (action: Snapshot['connection'], reason?: string) => {
    connection = action;
    if (action !== 'replay') reducer.connection({kind: 'connection', ...stamp(), action, ...(reason ? {reason} : {})});
  };
  const run = async (command: string, limit?: number) => {
    const current = epoch;
    if (closed) fail('client-closed', 'This client is closed.');
    try {
      const result = await transport.run(command, limit);
      if (epoch !== current || closed) fail('connection-interrupted', 'The connection changed during the operation.');
      return result;
    } catch (error) {
      if (epoch === current && !closed) changed('disconnected', error instanceof SdkError ? error.code : 'ssh-failed');
      throw error;
    }
  };
  const checked = async (command: string, limit?: number) => {
    const result = await run(command, limit);
    if (result.code !== 0) fail('remote-command-failed', 'Remote command failed; no action is retried automatically.');
    return result.stdout;
  };
  const unsupported = async (): Promise<never> => {
    const error = new SdkError('remote-input-disabled', disabledReason);
    Object.assign(error, {notSubmitted: true});
    throw error;
  };
  const preflight = async (): Promise<PreflightReport> => {
    if (config.storageMode !== undefined && config.storageMode !== 'native')
      fail('unsupported-storage-mode', 'Direct SSH uses native CLI storage; isolated helper storage was removed.');
    if (config.cliPath !== undefined && !absolute(config.cliPath)) fail('invalid-connection', 'cliPath must be an absolute remote path.');
    if (config.sessionDirectory !== undefined && !absolute(config.sessionDirectory)) fail('invalid-connection', 'sessionDirectory must be an absolute remote path.');
    const platform = (await checked('uname -s', 1024)).trim();
    const tmuxResult = await run('tmux -V', 1024);
    const tmuxVersion = tmuxResult.code === 0 ? tmuxResult.stdout.trim() : null;
    const discovered = config.cliPath ?? (await run('command -v cline', 4096)).stdout.trim();
    const executable = absolute(discovered) && (await run(`test -f ${shellArg(discovered)} && test -x ${shellArg(discovered)}`, 1024)).code === 0;
    const helpResult = executable ? await run(`${shellArg(discovered)} --help`, 128 * 1024) : null;
    const helpText = helpResult ? (helpResult.stdout + '\n' + helpResult.stderr).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') : '';
    const flags = helpResult?.code === 0 ? [...new Set(helpText.match(/--[a-z][a-z-]*/g) ?? [])] : [];
    const missingOptions = helpResult?.code === 0 ? ['--cwd', '--auto-approve'].filter(flag => !flags.includes(flag)) : null;
    const directory = config.sessionDirectory ?? (await checked('printf \'%s\' "${CLINE_SESSION_DATA_DIR:-${CLINE_DATA_DIR:-${CLINE_DIR:-$HOME/.cline}/data}/sessions}"', 4096));
    const readable = absolute(directory) && (await run(`test -d ${shellArg(directory)} && test -r ${shellArg(directory)} && test -x ${shellArg(directory)}`, 1024)).code === 0;
    const match = /^tmux (\d+)\.(\d+)/.exec(tmuxVersion ?? '');
    const modernTmux = !!match && (Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 2);
    const problems = [platform !== 'Linux' && 'linux-required', !modernTmux && 'tmux-3.2-required',
      !executable && 'cli-not-executable', missingOptions === null && 'cli-help-unavailable',
      !!missingOptions?.length && 'cli-required-options-missing'].filter(Boolean) as string[];
    report = {storageMode: 'native', sessionDirectory: readable ? directory : null,
      platform, python: false, pty: modernTmux, processOwnership: false, tmux: tmuxVersion,
      cliPath: executable ? discovered : null, cliVersion: null, cliHash: null, cliFlags: flags, bootId: '',
      help: {state: helpResult?.code === 0 ? 'success' : 'unavailable', exitCode: helpResult?.code ?? null,
        channels: [...(helpResult?.stdout ? ['stdout'] : []), ...(helpResult?.stderr ? ['stderr'] : [])]},
      missingOptions, features: cliFeatures(false, flags, config.declaredFeatures), problems, ready: !problems.length,
      profile: {name: profile, supported: !problems.length, companyCompatibility: 'unverified'}};
    return structuredClone(report);
  };
  const sessionIds = async (): Promise<string[]> => {
    if (!report?.sessionDirectory) return [];
    // Filenames, not file contents, are used for the history picker. No recency guessing.
    const data = await checked(`find ${shellArg(report.sessionDirectory)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\0'`, 65536);
    const names = data.split('\0').filter(Boolean);
    if (names.length > 256) fail('session-list-limit', 'More than 256 saved sessions; choose a narrower sessionDirectory.');
    return names.filter(name => sessionPattern.test(name)).sort();
  };
  const tmuxExecutions = async (): Promise<ManagedExecution[]> => {
    connected();
    const result = await run(tmux(['list-sessions', '-F', '#{session_name}\t#{@cline_sdk_direct}']), 512 * 1024);
    // A missing server is normal before the first start. Other failures are not an empty inventory.
    if (result.code !== 0 && !(result.code === 1 && /^(no server running on |error connecting to .*\(No such file or directory\))/m.test(result.stderr)))
      fail('remote-command-failed', 'Cannot list tmux sessions.');
    const runs: ManagedExecution[] = [];
    for (const line of result.stdout.trim().split('\n')) {
      const [name, encoded] = line.split('\t');
      if (!idPattern.test(name) || !encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) continue;
      try {
        const meta = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        if (meta.version !== 1 || meta.executionId !== name || meta.socket !== socket || !validTerminalSize(meta.terminal)) continue;
        runs.push({executionId: name, remoteRoot: socket, sessionId: null, terminal: meta.terminal,
          identityConfirmed: false, readOnly: true, kind: 'tmux'});
      } catch {}
    }
    return runs;
  };
  const listManagedExecutions = async (): Promise<ManagedExecution[]> => {
    const runs = await tmuxExecutions();
    for (const sessionId of await sessionIds()) runs.push({executionId: 'history:' + sessionId, remoteRoot: socket,
      sessionId, identityConfirmed: false, readOnly: true, kind: 'history'});
    return runs;
  };
  const initialize = async () => {
    const current = epoch;
    remoteObservation = undefined;
    await reducer.initialize({kind: 'initialize', ...stamp(), cli: {name: 'cline', version: 'unknown', profile},
      terminal: selected!.terminal ?? DEFAULT_TERMINAL, executionId: selected!.executionId, sessionId: selected!.sessionId});
    if (epoch !== current || closed) fail('connection-interrupted', 'Connection changed during initialization.');
    changed('connected');
  };
  const refresh = (): Promise<Snapshot> => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      connected();
      if (!selected) fail('no-managed-execution', 'Select an execution or saved conversation first.');
      const target = selected!;
      if (target.kind === 'history') {
        const directory = report?.sessionDirectory;
        if (!directory || !target.sessionId || !sessionPattern.test(target.sessionId)) fail('history-unavailable', 'Saved history path is unavailable.');
        const folder = directory + '/' + target.sessionId;
        const file = folder + '/' + target.sessionId + '.messages.json';
        // Reject symlinked leaf paths, nonregular files and oversized reads. Parsing remains local.
        const result = await run(`test ! -L ${shellArg(folder)} && test ! -L ${shellArg(file)} && test -f ${shellArg(file)} && head -c 8388609 -- ${shellArg(file)}`, 8388610);
        if (result.code !== 0 || Buffer.byteLength(result.stdout) > 8388608) {
          await reducer.ingest({kind: 'history-failure', ...stamp(), reason: 'history-read-failed'});
        } else {
          const data = Buffer.from(result.stdout);
          try {
            await reducer.ingest({kind: 'history', ...stamp(), dataBase64: data.toString('base64'), sourceBytes: data.length,
              sourceSha256: createHash('sha256').update(data).digest('hex')});
          } catch (error) {
            if (!(error instanceof SdkError && error.code === 'invalid-history')) throw error;
          }
        }
        observeRemote({kind: 'history', limitation: 'Saved history is read-only and does not prove that an execution has completed.'});
      } else {
        if (!(await tmuxExecutions()).some(item => item.executionId === target.executionId))
          fail('execution-unconfirmed', 'Direct execution metadata is missing. Do not automatically start another task.');
        const format = '#{pane_id}\t#{pane_pid}\t#{pane_width}\t#{pane_height}\t#{pane_dead}\t#{pane_dead_status}';
        const result = await run(tmux(['list-panes', '-s', '-t', '=' + target.executionId, '-F', format]), 4096);
        const lines = result.stdout.trim().split('\n');
        if (result.code !== 0 || lines.length !== 1) fail('execution-unconfirmed', 'The selected tmux pane is missing or ambiguous.');
        const [pane, pid, cols, rows, dead, exit] = lines[0].split('\t');
        const terminal = {cols: Number(cols), rows: Number(rows)};
        if (!/^%\d+$/.test(pane) || !/^\d+$/.test(pid) || !validTerminalSize(terminal) || !['0', '1'].includes(dead))
          fail('execution-unconfirmed', 'Unexpected tmux pane observation.');
        const screen = await checked(tmux(['capture-pane', '-p', '-t', pane]), 1024 * 1024);
        // This text is for display only. It never authorizes input or proves completion.
        observeRemote({kind: 'tmux', launchState: 'tmux-created', terminal, terminalText: screen, paneAlive: dead === '0',
          paneExitCode: dead === '1' && /^\d+$/.test(exit) ? Number(exit) : null,
          limitation: 'Pane state does not verify CLI descendants or message delivery. Select saved JSON history separately.'});
      }
      return snapshot();
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (busy || refreshing) fail('operation-busy', 'Another operation is in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  return {
    preflight: () => exclusive(preflight),
    connect: () => exclusive(async () => { if (closed) fail('client-closed', 'This client is closed.');
      const current = epoch;
      changed('connecting');
      try {
        if (epoch !== current || closed) fail('connection-interrupted', 'Connection cancelled before preflight.');
        const result = await preflight();
        if (epoch !== current || closed) fail('connection-interrupted', 'Connection cancelled during preflight.');
        changed('connected'); return result;
      }
      catch (error) { if (!closed) changed('disconnected'); throw error; } }),
    disconnect() { epoch++; transport.cancel(); changed(closed ? 'closed' : 'disconnected'); },
    listManagedExecutions,
    attach: executionId => exclusive(async () => {
      connected();
      const item = (await listManagedExecutions()).find(item => item.executionId === executionId);
      if (!item) fail('unknown-execution', 'Select a listed direct tmux execution or saved conversation.');
      selected = item!; await initialize(); return refresh();
    }),
    start: request => exclusive(async () => {
      connected();
      request = structuredClone(request);
      const current = epoch;
      if (selected) fail('managed-execution-selected', 'Create another client to start a new execution.');
      if (!report?.ready || !report.cliPath) fail('prerequisites-unavailable', 'Preflight must confirm the required CLI options and tmux.');
      const terminal = request.terminal ?? DEFAULT_TERMINAL;
      if (!absolute(request.cwd) || /#[(\{]/.test(request.cwd) || typeof request.prompt !== 'string' || !request.prompt.trim() ||
          /\0/.test(request.prompt) || Buffer.byteLength(request.prompt) > 8192 || !validTerminalSize(terminal))
        fail('invalid-task', 'Use an existing absolute cwd, a prompt up to 8192 bytes without NUL, and bounded terminal dimensions.');
      if (request.dataDir || request.resultFormat || request.outputMode === 'json')
        fail('unsupported-direct-mode', 'Isolated storage and structured/JSON live output are disabled.');
      if (request.terminalMode !== undefined && !['tui', 'readline'].includes(request.terminalMode)) fail('invalid-task', 'Unknown terminal mode.');
      if (request.retryLimit !== undefined && (!Number.isInteger(request.retryLimit) || request.retryLimit < 0 || request.retryLimit > 100)) fail('invalid-task', 'Invalid retry limit.');
      const argv = [report!.cliPath!, '--cwd', request.cwd, '--auto-approve', 'false'];
      for (const [wanted, flag] of [[request.terminalMode === 'tui', '--tui'], [request.retryLimit !== undefined, '--retries']] as const) {
        if (wanted && !report!.cliFlags?.includes(flag)) fail('cli-option-unavailable', `CLI help does not expose ${flag}.`);
        if (wanted) { argv.push(flag); if (flag === '--retries') argv.push(String(request.retryLimit)); }
      }
      argv.push('--', request.prompt);
      const cwdResult = await run(`test -d ${shellArg(request.cwd)} && test -x ${shellArg(request.cwd)}`, 1024);
      if (cwdResult.code !== 0) fail('invalid-task', 'Working directory must already exist and be accessible.');
      const executionId = 'sdk-' + randomUUID();
      selected = {executionId, remoteRoot: socket, sessionId: null, terminal, readOnly: true, kind: 'tmux', identityConfirmed: false};
      await initialize();
      if (epoch !== current || connection !== 'connected') fail('connection-interrupted', 'Connection detached before launch.');
      const metadata = Buffer.from(JSON.stringify({version: 1, executionId, socket, terminal})).toString('base64');
      // The queue establishes remain-on-exit before launching even a short-lived CLI.
      // CLI arguments are passed to tmux as separate argv entries, never sh -c.
      const command = [tmux(['start-server']), tmux(['set-option', '-g', 'remain-on-exit', 'on']),
        tmux(['set-option', '-g', 'status', 'off']),
        tmux(['new-session', '-d', '-s', executionId, '-x', String(terminal.cols), '-y', String(terminal.rows), '-c', request.cwd, ...argv]),
        tmux(['set-option', '-t', '=' + executionId, '@cline_sdk_direct', metadata])];
      // One tmux command queue, not five independent clients (the empty server could exit).
      const prefix = ['tmux', '-L', socket, '-f', '/dev/null'].map(tmuxArg).join(' ');
      const queue = command.map(part => part.slice(prefix.length + 1)).join(" ';' ");
      try { await checked(prefix + ' ' + queue, 4096); }
      catch (error) { observeRemote({kind: 'tmux', launchState: 'unknown', limitation: 'Launch outcome is unknown. Do not automatically launch again.'});
        Object.assign(error as object, {executionId, deliveryUnknown: true}); throw error; }
      observeRemote({kind: 'tmux', launchState: 'tmux-created', limitation: 'tmux created the CLI pane. Message acceptance is not independently confirmed.'});
      return snapshot();
    }),
    refresh: () => { if (busy) fail('operation-busy', 'Another operation is in progress.'); return refresh(); },
    reconfirmDelivery: () => { if (busy) fail('operation-busy', 'Another operation is in progress.'); return refresh(); }, snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    capabilities: () => ({structuredResults: {json: false, schemaValidation: false, nativeSchema: false},
      features: report?.features ?? cliFeatures(false), outputModes: {terminal: !!report?.ready, json: false},
      replay: false, live: true, responses: false, freeText: false, resume: false, sendMessage: false, stop: false,
      transport: 'ssh-tmux', limitation: disabledReason, companyCompatibility: 'unverified'}),
    respond: unsupported, sendMessage: unsupported, resume: unsupported, stop: unsupported,
    async startDiagnostics(options) {
      const status = await diagnostics.start(options);
      if (status.state !== 'collecting') return status;
      diagnostics.partial('Direct SSH observations do not include a PTY event stream, process ownership, or input receipts.');
      if (selected) diagnostics.capture({kind: 'initialize', ...stamp(), cli: {name: 'cline', version: 'unknown', profile},
        terminal: selected.terminal ?? DEFAULT_TERMINAL, executionId: selected.executionId, sessionId: selected.sessionId}, [], reducer.snapshot());
      return diagnostics.status();
    },
    stopDiagnostics: diagnostics.stop, diagnostics: diagnostics.status,
    close() { if (closed) return; closed = true; epoch++; transport.cancel(); changed('closed'); void diagnostics.stop(); listeners.clear(); reducer.close(); },
  };
}
