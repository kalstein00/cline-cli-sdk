"""Task-owned Linux PTY supervisor. CLI history/settings are never modified."""
import base64, collections, datetime, errno, fcntl, hashlib, json, os
from pathlib import Path
import pty, select, shlex, signal, stat, struct, subprocess, sys, termios, time
from contextlib import contextmanager

LIMIT = 512 * 1024

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def identity(pid, allow_zombie=False):
    try:
        value = Path(f'/proc/{pid}/stat').read_text()
        fields = value[value.rfind(')') + 2:].split()
        if fields[0] == 'Z' and not allow_zombie:
            return None
        return dict(pid=pid, startTime=fields[19], bootId=boot_id())
    except (OSError, ValueError, IndexError):
        return None

def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value), encoding='utf8')
    os.chmod(temporary, 0o600)
    temporary.replace(path)

def private(path):
    path = Path(path).expanduser().absolute()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Management directory must be owned by this user with mode 0700')
    return path

@contextmanager
def request_ledger(run):
    with open(run / 'requests.lock', 'a') as lock:
        os.chmod(run / 'requests.lock', 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            try:
                values = json.loads((run / 'requests.json').read_text())
            except FileNotFoundError:
                values = {}
            yield values
            save(run / 'requests.json', values)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

def input_binding(run, meta, request, cursor):
    expected = meta.get('identity')
    if request.get('executionId') != meta['executionId'] or not expected or request.get('processIdentity') != expected or identity(expected['pid']) != expected:
        return 'process-identity-changed'
    if request.get('expectedCursor') != cursor:
        return 'terminal-observation-changed'
    sid, _, history_path = session_files(meta)
    if sid != request.get('sessionId'):
        return 'session-changed'
    if history_path:
        try:
            if hashlib.sha256(history_path.read_bytes()).hexdigest() != request.get('historyHash'):
                return 'history-observation-changed'
        except OSError:
            return 'history-unavailable'
    else:
        return 'history-unavailable'
    return None

def session_files(meta):
    sessions = Path(meta['dataDir']) / 'sessions'
    expected = meta.get('sessionId')
    candidates = [sessions / expected / (expected + '.json')] if expected else list(sessions.glob('*/*.json'))
    def modified(path):
        try:
            return path.stat().st_mtime
        except OSError:
            return 0
    for path in sorted(candidates, key=modified, reverse=True):
        if path.name.endswith(('.messages.json', '.compaction.json')):
            continue
        try:
            manifest = json.loads(path.read_bytes())
            sid = manifest['session_id']
            if sid in meta.get('priorSessions', []) and not expected:
                continue
            if manifest.get('pid') != (meta.get('identity') or {}).get('pid'):
                continue
            return sid, manifest, sessions / sid / (sid + '.messages.json')
        except (OSError, ValueError, KeyError):
            continue
    return None, None, None

def serve(run):
    meta = json.loads((run / 'meta.json').read_text())
    fifo = run / 'input.fifo'
    os.mkfifo(fifo, 0o600)
    fifo_fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
    seq = 0
    ring = collections.deque()
    ring_bytes = 0
    def event(kind, **fields):
        nonlocal seq, ring_bytes
        seq += 1
        frame = dict(kind=kind, seq=seq, observedAt=now(), **fields)
        ring.append(frame)
        ring_bytes += len(json.dumps(frame))
        while ring_bytes > LIMIT and len(ring) > 1:
            ring_bytes -= len(json.dumps(ring.popleft()))
        save(run / 'buffer.json', dict(cursor=seq, first=ring[0]['seq'], observations=list(ring)))
    meta['supervisorIdentity'] = identity(os.getpid())
    try:
        pid, master = pty.fork()
    except OSError:
        meta.update(exitCode=127, endedAt=now(), startupFailed=True)
        save(run / 'meta.json', meta)
        return
    if pid == 0:
        os.chdir(meta['cwd'])
        os.environ['TERM'] = 'xterm-256color'
        os.environ['CLINE_NO_AUTO_UPDATE'] = '1'
        os.execv(meta['cliPath'], meta['argv'])
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', meta['terminal']['rows'], meta['terminal']['cols'], 0, 0))
    meta['identity'] = identity(pid, allow_zombie=True)
    meta['startedAt'] = now()
    meta.pop('argv', None)
    save(run / 'meta.json', meta)
    status = None
    input_buffer = b''
    try:
        while True:
            readable, _, _ = select.select([master, fifo_fd], [], [], .1)
            # Drain already-ready output before checking a queued response's cursor.
            if master in readable:
                try:
                    payload = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    payload = b''
                if not payload:
                    _, status = os.waitpid(pid, 0)
                    break
                event('pty', dataBase64=base64.b64encode(payload).decode())
                sys.stdout.buffer.write(payload)
                sys.stdout.buffer.flush()
            if fifo_fd in readable:
                input_buffer += os.read(fifo_fd, 65536)
                while b'\n' in input_buffer:
                    line, input_buffer = input_buffer.split(b'\n', 1)
                    try:
                        request = json.loads(line)
                        with request_ledger(run) as ledger:
                            record = ledger.get(request.get('requestId'))
                            if not record or record['state'] != 'queued':
                                continue
                            reason = input_binding(run, meta, request, seq)
                            if reason:
                                record.update(state='rejected', reason=reason, updatedAt=now())
                                continue
                            payload = base64.b64decode(request['dataBase64'], validate=True)
                            offset = 0
                            while offset < len(payload):
                                offset += os.write(master, payload[offset:])
                            record.update(state='written', updatedAt=now())
                            event('input', requestId=request['requestId'], interactionId=request['interactionId'], byteCount=len(payload))
                    except (ValueError, KeyError, OSError):
                        # A reserved request with no conclusive write witness remains uncertain.
                        continue
                if len(input_buffer) > 8192:
                    input_buffer = b''
    finally:
        if status is not None:
            meta['exitCode'] = os.waitstatus_to_exitcode(status)
            meta['endedAt'] = now()
            save(run / 'meta.json', meta)
        os.close(master)
        os.close(fifo_fd)

def handle(request):
    os.umask(0o077)
    root = private(request.get('root') or '~/.local/state/cline-cli-sdk')
    action = request['action']
    if action == 'list':
        executions = []
        for candidate in root.glob('run-*'):
            try:
                if candidate.is_symlink() or candidate.stat().st_uid != os.getuid() or candidate.stat().st_mode & 0o077:
                    continue
                meta = json.loads((candidate / 'meta.json').read_text())
                if meta.get('owner') != 'cline-cli-sdk' or meta.get('executionId') != candidate.name:
                    continue
                expected = meta.get('identity')
                actual = identity(expected['pid']) if expected else None
                same_boot = meta.get('bootId') == boot_id()
                sid, _, _ = session_files(meta)
                executions.append(dict(executionId=candidate.name, remoteRoot=str(root), sessionId=sid,
                    alive=bool(same_boot and expected and actual == expected),
                    identityConfirmed=bool(same_boot and expected and (actual is None or actual == expected)),
                    terminal=meta['terminal'], cliHash=meta.get('cliHash')))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return dict(executions=executions)
    if action == 'start':
        cwd = Path(request['cwd'])
        if not cwd.is_absolute() or not cwd.is_dir():
            raise ValueError('Remote working directory must be an existing absolute directory')
        run_id = request['executionId']
        if not run_id.startswith('run-') or not all(c.isalnum() or c == '-' for c in run_id):
            raise ValueError('Invalid execution identity')
        run = root / run_id
        run.mkdir(mode=0o700)
        data = Path(request.get('dataDir') or run / 'cli-data').expanduser().absolute()
        data.mkdir(parents=True, exist_ok=True, mode=0o700)
        # User explicitly supplies isolated authentication in dataDir. No config reads/copies.
        prior = [p.name for p in (data / 'sessions').glob('*') if p.is_dir()]
        executable = request['cliPath']
        h = hashlib.sha256()
        with open(executable, 'rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                h.update(chunk)
            if h.hexdigest() != request['cliHash']:
                raise ValueError('CLI fingerprint changed after preflight')
        helper = root / 'supervisor.py'
        helper.write_bytes(base64.b64decode(request['sourceBase64']))
        os.chmod(helper, 0o600)
        socket = str(root / 'tmux.sock')
        argv = [executable, '--data-dir', str(data), '--cwd', str(cwd), '--auto-approve', 'false', request['prompt']]
        if request.get('retryLimit') is not None:
            if type(request['retryLimit']) is not int or not 1 <= request['retryLimit'] <= 10:
                raise ValueError('Retry limit must be an integer from 1 to 10')
            argv[-1:-1] = ['--retries', str(request['retryLimit'])]
        meta = dict(schemaVersion=1, owner='cline-cli-sdk', executionId=run_id, sessionId=None, cwd=str(cwd), dataDir=str(data), priorSessions=prior,
                    cliPath=executable, cliHash=request['cliHash'], argv=argv, terminal=dict(rows=40, cols=120),
                    bootId=boot_id(), tmuxSocket=socket, tmuxSession=run_id, identity=None, exitCode=None)
        # Prompt is launch-only: don't retain it in minimal control metadata after startup.
        save(run / 'meta.json', meta)
        command = ' '.join(shlex.quote(v) for v in [sys.executable, str(helper), '--serve', str(run)])
        result = subprocess.run(['tmux', '-S', socket, 'new-session', '-d', '-s', run_id, '-x', '120', '-y', '40', command], capture_output=True, text=True)
        if result.returncode:
            raise ValueError('Unable to start task-owned tmux session: ' + result.stderr.strip())
        return dict(executionId=run_id, remoteRoot=str(root), sessionId=None)
    run = root / request['executionId']
    if run.parent != root or not request['executionId'].startswith('run-'):
        raise ValueError('Invalid execution path')
    meta = json.loads((run / 'meta.json').read_text())
    if meta['executionId'] != request['executionId']:
        raise ValueError('Execution identity mismatch')
    if action == 'bind-phase':
        with open(run / 'phase.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                phase = json.loads((run / 'phase.json').read_text())
            except FileNotFoundError:
                phase = dict(epoch=0, active=False)
            fingerprint = request.get('fingerprint')
            if fingerprint is None:
                phase['active'] = False
            elif not phase.get('active') or phase.get('fingerprint') != fingerprint:
                if len(fingerprint) != 64 or any(c not in '0123456789abcdef' for c in fingerprint):
                    raise ValueError('Invalid phase fingerprint')
                epoch = phase['epoch'] + 1
                phase = dict(epoch=epoch, fingerprint=fingerprint, active=True,
                    id=f"{meta['executionId']}:phase:{epoch}:{fingerprint[:16]}")
            save(run / 'phase.json', phase)
        return dict(phase=phase)
    if action == 'settle-response':
        resolution = request.get('resolution')
        if resolution not in ('delivered', 'not-submitted'):
            raise ValueError('Invalid response resolution')
        with request_ledger(run) as ledger:
            record = ledger.get(request.get('requestId'))
            if not record:
                raise ValueError('Unknown response request')
            if resolution == 'not-submitted' and record['state'] not in ('reserved', 'rejected'):
                raise ValueError('A possibly written input cannot be marked unsubmitted')
            if resolution == 'delivered' and record['state'] not in ('queued', 'written'):
                raise ValueError('An unsubmitted input cannot be marked delivered')
            if resolution == 'not-submitted' and record['state'] == 'reserved':
                # Cancel under the same lock used by late enqueue attempts.
                record.update(state='rejected', reason='reservation-cancelled')
            record.update(resolution=resolution, resolvedAt=now())
        return dict(settled=True)
    if action == 'reserve-response':
        request_id = request.get('requestId', '')
        if not request_id or len(request_id) > 128 or not all(c.isalnum() or c in '._:-' for c in request_id):
            raise ValueError('Invalid response request identity')
        binding = {key: request.get(key) for key in ('sessionId', 'executionId', 'interactionId', 'revision', 'toolId', 'kind', 'answerDigest')}
        with request_ledger(run) as ledger:
            prior = ledger.get(request_id)
            if prior:
                if prior['binding'] != binding:
                    raise ValueError('Request identity conflict')
                return dict(requestId=request_id, state=prior['state'], reason=prior.get('reason'))
            if len(ledger) >= 256:
                raise ValueError('Response request limit reached')
            buffer = json.loads((run / 'buffer.json').read_text())
            reason = input_binding(run, meta, request, buffer['cursor'])
            record = dict(binding=binding, state='rejected' if reason else 'reserved', reason=reason, createdAt=now())
            ledger[request_id] = record
            return dict(requestId=request_id, state=record['state'], reason=reason)
    if action == 'respond':
        request_id = request.get('requestId', '')
        if not request_id or len(request_id) > 128 or not all(c.isalnum() or c in '._:-' for c in request_id):
            raise ValueError('Invalid response request identity')
        payload = base64.b64decode(request.get('dataBase64', ''), validate=True)
        if request.get('kind') == 'approval':
            valid = payload in (b'y\r', b'n\r')
        else:
            valid = request.get('kind') in ('question', 'recovery') and len(payload) == 2 and payload[0:1] in [bytes([c]) for c in range(49, 58)] and payload[1:] == b'\r'
        if not valid:
            raise ValueError('Only verified approval or choice input is allowed')
        binding = {key: request.get(key) for key in ('sessionId', 'executionId', 'interactionId', 'revision', 'toolId', 'kind', 'answerDigest')}
        with request_ledger(run) as ledger:
            prior = ledger.get(request_id)
            if prior:
                if prior['binding'] != binding:
                    raise ValueError('Request identity conflict')
                if prior['state'] != 'reserved':
                    return dict(requestId=request_id, state=prior['state'], reason=prior.get('reason'))
            if len(ledger) >= 256:
                raise ValueError('Response request limit reached')
            phase = ('sessionId', 'executionId', 'toolId', 'kind')
            if any(value['state'] in ('queued', 'written') and all(value['binding'].get(key) == binding.get(key) for key in phase) for value in ledger.values()):
                return dict(requestId=request_id, state='rejected', reason='interaction-already-submitted')
            buffer = json.loads((run / 'buffer.json').read_text())
            reason = input_binding(run, meta, request, buffer['cursor'])
            record = dict(binding=binding, state='queued', createdAt=prior.get('createdAt') if prior else now())
            ledger[request_id] = record
            if reason:
                record.update(state='rejected', reason=reason)
                return dict(requestId=request_id, state='rejected', reason=reason)
            frame = {key: request.get(key) for key in ('requestId', 'sessionId', 'executionId', 'interactionId', 'expectedCursor', 'historyHash', 'processIdentity', 'dataBase64')}
            line = (json.dumps(frame) + '\n').encode('utf8')
            if len(line) > 4096:
                raise ValueError('Input control frame exceeded atomic FIFO limit')
            try:
                fd = os.open(run / 'input.fifo', os.O_WRONLY | os.O_NONBLOCK)
                try:
                    os.write(fd, line)
                finally:
                    os.close(fd)
            except OSError:
                record.update(state='rejected', reason='input-fifo-unavailable')
                return dict(requestId=request_id, state='rejected', reason=record['reason'])
            return dict(requestId=request_id, state='queued')
    if action == 'status':
        cursor = request.get('cursor', 0)
        try:
            buffer = json.loads((run / 'buffer.json').read_text())
        except (OSError, ValueError):
            buffer = dict(cursor=cursor, first=cursor + 1, observations=[])
        observations = [frame for frame in buffer['observations'] if frame['seq'] > cursor and frame['kind'] == 'pty']
        sid, manifest, history_path = session_files(meta)
        history = None
        history_error = None
        if history_path:
            try:
                payload = history_path.read_bytes()
                history = dict(dataBase64=base64.b64encode(payload).decode(), sha256=hashlib.sha256(payload).hexdigest())
            except OSError as exc:
                history_error = type(exc).__name__
        expected = meta.get('identity')
        actual = identity(expected['pid']) if expected else None
        same_boot = meta['bootId'] == boot_id()
        alive = bool(same_boot and expected and actual == expected)
        confirmed = bool(same_boot and ((expected and (actual == expected or actual is None)) or (meta.get('startupFailed') and meta.get('supervisorIdentity'))))
        screen = None
        if alive and (request.get('fullScreen') or cursor < buffer['first'] - 1):
            target = meta['tmuxSession'] + ':0.0'
            try:
                geometry = subprocess.check_output(['tmux','-S',meta['tmuxSocket'],'display-message','-p','-t',target,'#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}'], timeout=5, text=True).strip()
                cols, rows, x, y = map(int, geometry.split(','))
                if cols != meta['terminal']['cols'] or rows != meta['terminal']['rows'] or not (0 <= x < cols and 0 <= y < rows):
                    raise ValueError('Terminal geometry changed')
                payload = subprocess.check_output(['tmux','-S',meta['tmuxSocket'],'capture-pane','-p','-e','-t',target],timeout=5)
                if len(payload) > LIMIT:
                    raise ValueError('Screen snapshot exceeded bounded read')
                restored = b'\x1b[0m\x1b[2J\x1b[H' + b'\r\n'.join(payload.splitlines()[:rows]) + f'\x1b[{y+1};{x+1}H'.encode()
                screen = dict(dataBase64=base64.b64encode(restored).decode(), cols=cols, rows=rows, cursorX=x, cursorY=y)
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        try:
            phase = json.loads((run / 'phase.json').read_text())
        except FileNotFoundError:
            phase = dict(epoch=0, active=False)
        try:
            requests = json.loads((run / 'requests.json').read_text())
        except FileNotFoundError:
            requests = {}
        return dict(executionId=meta['executionId'], sessionId=sid, observations=observations, cursor=buffer['cursor'],
                    gap=cursor < buffer['first'] - 1, history=history, historyError=history_error, screen=screen, phase=phase,
                    process=dict(kind='process', identity=expected, alive=alive, identityConfirmed=confirmed,
                                 exitCode=meta.get('exitCode'), manifestStatus=manifest.get('status') if manifest else None,
                                 requestedStop=any(value['state']=='written' and value['binding']['kind']=='recovery' and value['binding']['answerDigest']==hashlib.sha256(b'Stop this run').hexdigest() for value in requests.values())),
                    requests=[dict(requestId=key, state=value['state'], reason=value.get('reason'), binding=value['binding'], createdAt=value.get('createdAt'), resolution=value.get('resolution')) for key,value in requests.items()],
                    management=dict(remoteRoot=str(root), terminal=meta['terminal'], bootId=meta['bootId'], phaseSupported=True, responseReservation=True))
    raise ValueError('Unsupported supervisor action')

if len(sys.argv) >= 3 and sys.argv[1] == '--serve':
    serve(Path(sys.argv[2]))
else:
    try:
        print(json.dumps(handle(json.load(sys.stdin))))
    except Exception as exc:
        print(json.dumps(dict(error=type(exc).__name__, message=str(exc))))
        sys.exit(0)
