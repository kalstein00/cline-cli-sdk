"""Task-owned Linux PTY supervisor. CLI history/settings are never modified."""
import base64, collections, datetime, errno, fcntl, hashlib, json, os
from pathlib import Path
import pty, select, shlex, signal, stat, struct, subprocess, sys, termios, time

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
    try:
        while True:
            readable, _, _ = select.select([master, fifo_fd], [], [], .1)
            if fifo_fd in readable:
                payload = os.read(fifo_fd, 65536)
                offset = 0
                while offset < len(payload):
                    offset += os.write(master, payload[offset:])
                event('input', dataBase64=base64.b64encode(payload).decode())
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
                # tmux restores screen on reconnection without a full raw-log replay.
                sys.stdout.buffer.write(payload)
                sys.stdout.buffer.flush()
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
        meta = dict(schemaVersion=1, executionId=run_id, sessionId=None, cwd=str(cwd), dataDir=str(data), priorSessions=prior,
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
        return dict(executionId=meta['executionId'], sessionId=sid, observations=observations, cursor=buffer['cursor'],
                    gap=cursor < buffer['first'] - 1, history=history, historyError=history_error,
                    process=dict(kind='process', identity=expected, alive=alive, identityConfirmed=confirmed,
                                 exitCode=meta.get('exitCode'), manifestStatus=manifest.get('status') if manifest else None),
                    management=dict(remoteRoot=str(root), terminal=meta['terminal'], bootId=meta['bootId']))
    raise ValueError('Unsupported supervisor action')

if len(sys.argv) >= 3 and sys.argv[1] == '--serve':
    serve(Path(sys.argv[2]))
else:
    try:
        print(json.dumps(handle(json.load(sys.stdin))))
    except Exception as exc:
        print(json.dumps(dict(error=type(exc).__name__, message=str(exc))))
        sys.exit(0)
