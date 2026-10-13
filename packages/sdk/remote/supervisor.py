"""Task-owned Linux PTY supervisor. CLI history/settings are never modified."""
import base64, collections, datetime, errno, fcntl, hashlib, json, os
from pathlib import Path
import pty, select, shlex, signal, stat, struct, subprocess, sys, termios, time
from contextlib import contextmanager

LIMIT = 512 * 1024

class WorkingDirectoryError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

def working_directory(value):
    path = Path(value)
    if not path.is_absolute():
        raise WorkingDirectoryError('working-directory-invalid', '원격 작업 디렉터리는 절대 경로여야 합니다.')
    try:
        info = path.stat()
    except FileNotFoundError:
        raise WorkingDirectoryError('working-directory-not-found', '원격 작업 디렉터리가 없습니다.')
    except (PermissionError, OSError):
        raise WorkingDirectoryError('working-directory-access-denied', '원격 작업 디렉터리에 접근할 수 없습니다.')
    if not stat.S_ISDIR(info.st_mode):
        raise WorkingDirectoryError('working-directory-not-directory', '입력한 원격 경로가 디렉터리가 아닙니다.')
    if not os.access(path, os.X_OK):
        raise WorkingDirectoryError('working-directory-access-denied', '원격 작업 디렉터리에 접근할 권한이 없습니다.')
    return path

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
                raise ValueError('Input ledger is missing; inputs remain blocked')
            yield values
            save(run / 'requests.json', values)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

def valid_terminal_size(size):
    return (isinstance(size, dict) and type(size.get('cols')) is int and type(size.get('rows')) is int
            and 20 <= size['cols'] <= 500 and 5 <= size['rows'] <= 200)


def terminal_geometry(meta):
    target = meta['tmuxSession'] + ':0.0'
    raw = subprocess.check_output(['tmux','-S',meta['tmuxSocket'],'display-message','-p','-t',target,'#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}'], timeout=5, text=True).strip()
    cols, rows, x, y = map(int, raw.split(','))
    if not valid_terminal_size(dict(cols=cols, rows=rows)) or not (0 <= x < cols and 0 <= y < rows):
        raise ValueError('Invalid terminal geometry')
    return cols, rows, x, y


def sync_terminal_size(master, run, meta):
    """Propagate the outer tmux PTY size to the CLI's nested PTY."""
    try:
        size = os.get_terminal_size(sys.stdout.fileno())
        current = dict(rows=size.lines, cols=size.columns)
        if valid_terminal_size(current) and current != meta['terminal']:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', current['rows'], current['cols'], 0, 0))
            meta['terminal'] = current
            save(run / 'meta.json', meta)
    except OSError:
        pass


def modal_witness(meta):
    if meta.get('terminalMode') != 'tui':
        return None
    try:
        cols, rows, x, y = terminal_geometry(meta)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    result = subprocess.run(['tmux', '-S', meta['tmuxSocket'], 'capture-pane', '-p', '-t', meta['tmuxSession']], capture_output=True, timeout=5)
    if result.returncode:
        return None
    lines = result.stdout.decode('utf8', errors='strict').splitlines()
    try:
        if len(result.stdout) > LIMIT or len(lines) != rows or terminal_geometry(meta)[:2] != (cols, rows):
            return None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    if any('Press Enter to open, any other key to close' in line for line in lines):
        return None
    titles = [i for i, line in enumerate(lines) if line.strip() in ('Cline is asking a question', 'Cline needs permission')]
    if not titles:
        return None
    # Custom layouts can put choices or drafts in any trailing row. Include the
    # complete visible modal; footer-only changes conservatively require a refresh.
    payload = json.dumps([cols, rows, [line.rstrip() for line in lines[titles[-1]:]]], ensure_ascii=False).encode('utf8')
    return dict(sha256=hashlib.sha256(payload).hexdigest(), dataBase64=base64.b64encode(result.stdout).decode(), rows=rows, cols=cols)

def composer_witness(meta):
    if meta.get('terminalMode') != 'tui':
        return None
    target = meta['tmuxSession'] + ':0.0'
    try:
        cols, rows, x, y = terminal_geometry(meta)
        raw = subprocess.check_output(['tmux','-S',meta['tmuxSocket'],'capture-pane','-p','-t',target], timeout=5)
        lines = raw.decode('utf8').splitlines()
        if len(raw) > LIMIT or len(lines) != rows or not 0 < y < rows-1 or x < 2 or terminal_geometry(meta) != (cols, rows, x, y):
            return None
        rule = lambda line: len(line.strip()) >= 20 and set(line.strip()) == {'─'}
        # Focus identifies the input row; footer height and labels are CLI-specific.
        if not rule(lines[y-1]) or not rule(lines[y+1]) or not lines[y].startswith('❯ '):
            return None
        payload = json.dumps([lines[y-1:y+2], cols, rows, x, y], ensure_ascii=False).encode('utf8')
        return dict(sha256=hashlib.sha256(payload).hexdigest(), dataBase64=base64.b64encode(raw).decode(), rows=rows, cols=cols, cursorX=x, cursorY=y)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None

def message_idle(run, meta, empty=False):
    sid, manifest, path = session_files(meta)
    resumed_owner = resume_owner(meta) if not manifest else None
    if meta.get('terminalMode')!='tui' or meta.get('outputMode')=='json' or not sid or not path or (not resumed_owner and (not manifest or manifest.get('status')!='idle')):
        return 'agent-not-idle'
    if resumed_owner and not completed_resume_turn(meta, path):
        return 'agent-busy'
    expected=meta.get('identity')
    if not expected or identity(expected['pid'])!=expected or not meta.get('supervisorIdentity') or identity(meta['supervisorIdentity']['pid'])!=meta['supervisorIdentity']:
        return 'process-unconfirmed'
    try:
        ownership=json.loads((run/'ownership.json').read_text())
        phase=json.loads((run/'phase.json').read_text()) if (run/'phase.json').exists() else {}
        owner = session_owner(meta, manifest.get('pid')) if manifest else resumed_owner
        if ownership.get('trackingError') or busy_children(meta, ownership, owner) or (run/'stop-request.json').exists() or phase.get('active'):
            return 'agent-busy'
    except (OSError,ValueError): return 'process-unconfirmed'
    if modal_witness(meta): return 'modal-active'
    witness=composer_witness(meta)
    if not witness: return 'composer-unconfirmed'
    if empty:
        line=base64.b64decode(witness['dataBase64']).decode().splitlines()[witness['cursorY']][2:].rstrip()
        if line not in ('','Ask anything...'): return 'composer-not-empty'
    return None

def input_binding(run, meta, request, cursor):
    expected = meta.get('identity')
    if request.get('executionId') != meta['executionId'] or not expected or request.get('processIdentity') != expected or identity(expected['pid']) != expected:
        return 'process-identity-changed'
    if meta.get('terminalMode') == 'tui':
        input_type = request.get('inputType')
        if isinstance(input_type,str) and input_type.startswith('composer-') and request.get('requestId') != (meta.get('resume') or {}).get('requestId'):
            reason=message_idle(run,meta)
            if reason: return reason
        witness = composer_witness(meta) if isinstance(input_type, str) and input_type.startswith('composer-') else modal_witness(meta)
        if not witness or not request.get('modalHash') or request['modalHash'] != witness['sha256']:
            return 'terminal-modal-changed'
        # Reservation binds an empty destination before any payload exists. Actual
        # respond/FIFO writes carry a validated payload and must also fit this row.
        if input_type == 'composer-text' and 'dataBase64' in request and witness['cursorX'] + len(base64.b64decode(request['dataBase64'], validate=True)) > witness['cols'] - 6:
            return 'composer-width-exceeded'
    elif request.get('expectedCursor') != cursor:
        return 'terminal-observation-changed'
    sid, _, history_path = session_files(meta)
    if sid != request.get('sessionId'):
        return 'session-changed'
    if history_path:
        try:
            if hashlib.sha256(read_history(history_path)).hexdigest() != request.get('historyHash'):
                return 'history-observation-changed'
        except (OSError, ValueError):
            return 'history-unavailable'
    else:
        return 'history-unavailable'
    return None

def read_history(path, limit=16 * 1024 * 1024):
    # Read only. A whole payload must belong to one unchanged inode and version.
    def version(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    # Nonblocking open plus regular-file validation prevents a corrupt candidate
    # FIFO/device from blocking discovery before its size can be inspected.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('history-not-regular-file')
        if before.st_size > limit:
            raise ValueError('history-too-large')
        payload = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    if version(before) != version(after) or version(after) != version(path.stat()) or len(payload) != after.st_size:
        raise ValueError('file-changed')
    return payload

def session_cache(meta):
    try:
        cache = json.loads((Path(meta['tmuxSocket']).parent / meta['executionId'] / 'session.json').read_bytes())
        if cache.get('executionId') == meta['executionId'] and cache.get('identity') == meta.get('identity'):
            return cache
    except (OSError, ValueError, KeyError):
        pass
    return {}

def session_owner(meta, pid):
    """A launcher child is a CLI only when its manifest and exact ownership agree."""
    expected = meta.get('identity')
    if pid is None:
        return None
    if expected and pid == expected['pid']:
        actual = identity(pid)
        if actual == expected or (actual is None and meta.get('exitCode') is not None and expected['bootId'] == boot_id()):
            return expected
        return None
    try:
        run = Path(meta['tmuxSocket']).parent / meta['executionId']
        ownership = json.loads((run / 'ownership.json').read_bytes())
        if (ownership.get('cliIdentity') == expected and
                ownership.get('supervisorIdentity') == meta.get('supervisorIdentity') and
                not ownership.get('trackingError') and meta['bootId'] == boot_id()):
            for child in ownership.get('owned', []):
                if child['pid'] == pid and identity(pid) == child:
                    return child
        # Retain the established child's final manifest after confirmed exit.
        # A reused PID, new boot or superseded execution never authorizes it.
        cached = session_cache(meta).get('sessionOwner')
        if (cached and cached['pid'] == pid and cached['bootId'] == boot_id() and
                identity(pid) is None and meta.get('exitCode') is not None and not meta.get('resumedBy')):
            return cached
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None

def busy_children(meta, ownership, owner):
    """Only a verified private daemon is idle infrastructure, never tool children."""
    infrastructure = [meta.get('identity'), owner]
    if meta.get('storageMode') == 'native':
        run = Path(meta['tmuxSocket']).parent / meta['executionId']
        try:
            daemon_pid = json.loads((run / 'hub.json').read_bytes()).get('pid')
            for child in ownership.get('owned', []):
                if child['pid'] != daemon_pid or identity(daemon_pid) != child:
                    continue
                proc = Path('/proc') / str(daemon_pid)
                argv = (proc / 'cmdline').read_bytes().split(b'\0')
                env = (proc / 'environ').read_bytes().split(b'\0')
                if (b'--cline-hub-daemon' in argv and
                        os.fsencode('CLINE_HUB_DISCOVERY_PATH=' + str(run / 'hub.json')) in env and
                        os.fsencode('CLINE_HUB_PATHNAME=/' + meta['executionId']) in env and
                        identity(daemon_pid) == child):
                    infrastructure.append(child)
        except (OSError, ValueError, TypeError):
            pass
    return [child for child in ownership.get('owned', []) if child not in infrastructure]

def session_files(meta):
    sessions = Path(meta.get('sessionDirectory') or (Path(meta['dataDir']) / 'sessions'))
    expected = meta.get('sessionId')
    if not expected:
        expected = session_cache(meta).get('sessionId')
    if expected:
        candidates = [sessions / expected / (expected + '.json')]
    else:
        # Inventory names before reading: never open an existing conversation.
        try:
            prior = set(meta.get('priorSessions', []))
            candidates = []
            for folder in sessions.iterdir():
                if folder.name not in prior and folder.is_dir():
                    candidates.append(folder / (folder.name + '.json'))
                    if len(candidates) > 256:
                        return None, None, None
        except OSError:
            return None, None, None
    matches = []
    for path in candidates:
        if path.name.endswith(('.messages.json', '.compaction.json')):
            continue
        if not expected and path.parent.name in meta.get('priorSessions', []):
            continue
        try:
            manifest = json.loads(read_history(path, 65536))
            sid = manifest['session_id']
            if not isinstance(sid, str) or path != sessions / sid / (sid + '.json'):
                continue
            if sid in meta.get('priorSessions', []) and not expected:
                continue
            owner = session_owner(meta, manifest.get('pid'))
            if not expected and not owner:
                continue
            current_manifest = bool(owner) or (manifest.get('pid') is None and not meta.get('resumedBy') and meta.get('exitCode') is not None and manifest.get('status') in ('completed','cancelled','failed'))
            matches.append((sid, manifest if current_manifest else None, sessions / sid / (sid + '.messages.json')))
        except (OSError, ValueError, KeyError):
            continue
    # Never infer which conversation to control from file recency.
    return matches[0] if len(matches) == 1 else (None, None, None)

def completed_resume_turn(meta, path):
    """An empty composer also exists during generation. Require a finished text turn.

    The observed history profile writes token metrics on the completed API response.
    A streamed/partial assistant, tool call, or pre-resume reply cannot establish idle.
    Unknown history profiles stay blocked rather than guessing from elapsed time.
    """
    if not path:
        return False
    try:
        doc=json.loads(read_history(path))
        if not isinstance(doc,dict): return False
        messages=doc['messages']
        baseline=(meta.get('resume') or {}).get('baselineMessageCount')
        if not isinstance(messages,list) or doc.get('version')!=1 or doc.get('sessionId')!=meta.get('sessionId') or type(baseline) is not int or len(messages)<=baseline+1:
            return False
        last=messages[-1]
        if not isinstance(last,dict): return False
        metrics=last.get('metrics') or {}
        content=last.get('content') or []
        if not isinstance(metrics,dict) or not isinstance(content,list) or any(not isinstance(p,dict) for p in content): return False
        return bool(last.get('role')=='assistant' and any(p.get('type')=='text' and p.get('text') for p in content) and
                    all(p.get('type') in ('text','thinking') for p in content) and
                    type(metrics.get('inputTokens')) is int and metrics['inputTokens']>=0 and
                    type(metrics.get('outputTokens')) is int and metrics['outputTokens']>=0)
    except (OSError,ValueError,KeyError,TypeError):
        return False

def resume_owner(meta):
    """Some CLIs retain the old manifest PID. Verify this launch's SID in /proc."""
    resume = meta.get('resume') or {}
    expected = meta.get('identity')
    supervisor = meta.get('supervisorIdentity')
    if (not resume or resume.get('executionId') != meta.get('executionId') or
            resume.get('sessionId') != meta.get('sessionId') or not expected or
            identity(expected['pid']) != expected or not supervisor or identity(supervisor['pid']) != supervisor):
        return None
    try:
        ownership = json.loads((Path(meta['tmuxSocket']).parent / meta['executionId'] / 'ownership.json').read_bytes())
        if ownership.get('cliIdentity') != expected or ownership.get('supervisorIdentity') != supervisor or ownership.get('trackingError'):
            return None
        def matches_args(process):
            argv=(Path('/proc')/str(process['pid'])/'cmdline').read_bytes().decode('utf8').rstrip('\0').split('\0')
            required = [('--id',meta['sessionId']),('--cwd',meta['cwd']),('--auto-approve','false')]
            if meta.get('storageMode', 'isolated') == 'isolated':
                required.append(('--data-dir',meta['dataDir']))
            elif '--data-dir' in argv:
                return False
            for flag,value in required:
                if argv.count(flag)!=1 or argv.index(flag)+1>=len(argv) or argv[argv.index(flag)+1]!=value:
                    return False
            return identity(process['pid']) == process
        candidates=[]
        for child in ownership.get('owned',[]):
            if child==expected or identity(child['pid'])!=child: continue
            raw=(Path('/proc')/str(child['pid'])/'stat').read_text()
            ppid=int(raw[raw.rfind(')')+2:].split()[1])
            if ppid==expected['pid'] and matches_args(child): candidates.append(child)
        if candidates: return candidates[0] if len(candidates)==1 else None
        return expected if expected in ownership.get('owned',[]) and matches_args(expected) else None
    except (OSError,ValueError,KeyError,TypeError,IndexError):
        return None

def serve(run):
    from ownership import Ownership, read_json
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
    json_mode = meta.get('outputMode') == 'json'
    stderr_read, stderr_write = os.pipe() if json_mode else (None, None)
    try:
        Ownership.subreaper()
        pid, master = pty.fork()
    except OSError:
        meta.update(exitCode=127, endedAt=now(), startupFailed=True)
        save(run / 'meta.json', meta)
        return
    if pid == 0:
        if json_mode:
            os.close(stderr_read)
            os.dup2(stderr_write, 2)
            os.close(stderr_write)
        os.chdir(meta['cwd'])
        os.environ['TERM'] = 'xterm-256color'
        os.environ['CLINE_NO_AUTO_UPDATE'] = '1'
        os.environ['CLINE_DISABLE_CLINE_PASS_NOTICE'] = '1'
        if meta.get('storageMode') == 'native':
            # The observed TUI explicitly selects auto and ignores backend mode.
            # Route its daemon through a private discovery file and endpoint.
            # Subreaper ownership includes that daemon without adopting a user's hub.
            import socket
            with socket.socket() as endpoint:
                endpoint.bind(('127.0.0.1', 0))
                port = endpoint.getsockname()[1]
            os.environ['CLINE_HUB_DISCOVERY_PATH'] = str(run / 'hub.json')
            os.environ['CLINE_HUB_HOST'] = '127.0.0.1'
            os.environ['CLINE_HUB_PORT'] = str(port)
            os.environ['CLINE_HUB_PATHNAME'] = '/' + meta['executionId']
        os.execv(meta['cliPath'], meta['argv'])
    if json_mode: os.close(stderr_write)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', meta['terminal']['rows'], meta['terminal']['cols'], 0, 0))
    meta['identity'] = identity(pid, allow_zombie=True)
    meta['startedAt'] = now()
    meta.pop('argv', None)
    save(run / 'meta.json', meta)
    owner = Ownership(run, meta['supervisorIdentity'], meta['identity'])
    status = None
    input_buffer = b''
    try:
        while True:
            # tmux resizes the supervisor's outer PTY; propagate that size to the CLI PTY.
            if not json_mode:
                sync_terminal_size(master, run, meta)
            try:
                owner.scan()
            except (OSError, ValueError) as exc:
                owner.error = str(exc)
            stop = read_json(run / 'stop-request.json')
            if stop and not read_json(run / 'stop-result.json'):
                owner.stop(stop)
            readable, _, _ = select.select([master, fifo_fd] + ([stderr_read] if stderr_read is not None else []), [], [], .1)
            if stderr_read is not None and stderr_read in readable:
                error_payload = os.read(stderr_read, 65536)
                if error_payload: event('json-output', channel='stderr', dataBase64=base64.b64encode(error_payload).decode())
                else: os.close(stderr_read); stderr_read = None
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
                event('json-output' if json_mode else 'pty', **({'channel':'stdout'} if json_mode else {}), dataBase64=base64.b64encode(payload).decode())
                sys.stdout.buffer.write(payload)
                sys.stdout.buffer.flush()
            if fifo_fd in readable:
                input_buffer += os.read(fifo_fd, 65536)
                while b'\n' in input_buffer:
                    line, input_buffer = input_buffer.split(b'\n', 1)
                    try:
                        request = json.loads(line)
                        with request_ledger(run) as ledger:
                            parent = ledger.get(request.get('requestId'))
                            record = parent.get('steps', {}).get(str(request['stepIndex'])) if parent and request.get('stepIndex') is not None else parent
                            if not record or record['state'] != 'queued':
                                continue
                            reason = input_binding(run, meta, request, seq)
                            if reason:
                                record.update(state='rejected', reason=reason, updatedAt=now())
                                if request.get('stepIndex') == 0:
                                    parent.update(state='rejected', reason=reason)
                                continue
                            payload = base64.b64decode(request['dataBase64'], validate=True)
                            offset = 0
                            while offset < len(payload):
                                offset += os.write(master, payload[offset:])
                            record.update(state='written', updatedAt=now())
                            if request.get('stepIndex') is not None:
                                parent['state'] = 'written'
                            event('input', requestId=request['requestId'], interactionId=request['interactionId'], stepIndex=request.get('stepIndex'), byteCount=len(payload))
                    except (ValueError, KeyError, OSError):
                        # A reserved request with no conclusive write witness remains uncertain.
                        continue
                if len(input_buffer) > 8192:
                    input_buffer = b''
    finally:
        if stderr_read is not None:
            while select.select([stderr_read], [], [], 0)[0]:
                payload = os.read(stderr_read, 65536)
                if not payload: break
                event('json-output', channel='stderr', dataBase64=base64.b64encode(payload).decode())
            os.close(stderr_read)
        if status is not None:
            meta['exitCode'] = os.waitstatus_to_exitcode(status)
            meta['endedAt'] = now()
            save(run / 'meta.json', meta)
        os.close(master)
        os.close(fifo_fd)
        # Keep ownership authority while an orphan command is still alive.
        while owner.scan():
            stop = read_json(run / 'stop-request.json')
            if stop and not read_json(run / 'stop-result.json'):
                owner.stop(stop)
            time.sleep(.1)

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
                    terminal=meta['terminal'], terminalMode=meta.get('terminalMode', 'readline'), outputMode=meta.get('outputMode','terminal'), cliHash=meta.get('cliHash'), storageMode=meta.get('storageMode','isolated'), resultRequest=meta.get('resultRequest'), supersededBy=meta.get('resumedBy')))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return dict(executions=executions)
    if action == 'resume':
        from resume import launch_resume
        return launch_resume(request, root, handle, identity, boot_id, save)
    if action == 'start':
        terminal = request.get('terminal', dict(rows=40, cols=120))
        if not valid_terminal_size(terminal):
            raise ValueError('Invalid terminal geometry')
        cwd = working_directory(request['cwd'])
        run_id = request['executionId']
        if not run_id.startswith('run-') or not all(c.isalnum() or c == '-' for c in run_id):
            raise ValueError('Invalid execution identity')
        run = root / run_id
        run.mkdir(mode=0o700)
        storage_mode = request.get('storageMode', 'isolated')
        if storage_mode not in ('isolated', 'native'):
            raise ValueError('Unknown CLI storage mode')
        if storage_mode == 'native':
            if request.get('dataDir') or not request.get('sessionDirectory'):
                raise ValueError('Native storage needs an observed session directory and no dataDir')
            sessions = Path(request['sessionDirectory'])
            if not sessions.is_absolute() or not sessions.is_dir() or not os.access(sessions, os.R_OK | os.X_OK):
                raise ValueError('Native CLI session directory is unavailable')
            data = None
        else:
            data = Path(request.get('dataDir') or run / 'cli-data').expanduser().absolute()
            data.mkdir(parents=True, exist_ok=True, mode=0o700)
            sessions = data / 'sessions'
        # Only names are inventoried; existing conversations and credentials are not read.
        prior = [p.name for p in sessions.iterdir() if p.is_dir()] if sessions.is_dir() else []
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
        ownership = root / 'ownership.py'
        ownership.write_bytes(base64.b64decode(request['ownershipSourceBase64']))
        os.chmod(ownership, 0o600)
        socket = str(root / 'tmux.sock')
        argv = [executable, '--cwd', str(cwd), '--auto-approve', 'false']
        if storage_mode == 'isolated': argv += ['--data-dir', str(data)]
        resume = request.get('_resume')
        if resume: argv += ['--id', resume['sessionId']]
        else: argv += [request['prompt']]
        mode = request.get('terminalMode', 'readline')
        output_mode = request.get('outputMode', 'terminal')
        if output_mode not in ('terminal','json') or (output_mode == 'json' and (mode == 'tui' or resume)):
            raise ValueError('Unsupported output mode combination')
        if output_mode == 'json': argv[-1:-1] = ['--json']
        if mode not in ('readline', 'tui'):
            raise ValueError('Invalid terminal mode')
        if mode == 'tui' and not resume: argv[-1:-1] = ['--tui']
        if request.get('retryLimit') is not None:
            if type(request['retryLimit']) is not int or not 1 <= request['retryLimit'] <= 10:
                raise ValueError('Retry limit must be an integer from 1 to 10')
            argv[-1:-1] = ['--retries', str(request['retryLimit'])]
        meta = dict(schemaVersion=1, owner='cline-cli-sdk', executionId=run_id, sessionId=resume['sessionId'] if resume else None, resume=resume, cwd=str(cwd), dataDir=str(data) if data else None, storageMode=storage_mode, sessionDirectory=str(sessions), priorSessions=prior,
                    cliPath=executable, cliHash=request['cliHash'], argv=argv, terminalMode=mode, outputMode=output_mode, resultRequest=request.get('resultRequest'), terminal=terminal,
                    bootId=boot_id(), tmuxSocket=socket, tmuxSession=run_id, identity=None, exitCode=None)
        # Prompt is launch-only: don't retain it in minimal control metadata after startup.
        save(run / 'meta.json', meta)
        save(run / 'requests.json', {})
        command = ' '.join(shlex.quote(v) for v in [sys.executable, str(helper), '--serve', str(run)])
        result = subprocess.run(['tmux', '-S', socket, 'new-session', '-d', '-s', run_id, '-x', str(terminal['cols']), '-y', str(terminal['rows']), command], capture_output=True, text=True)
        if result.returncode:
            raise ValueError('Unable to start task-owned tmux session: ' + result.stderr.strip())
        return dict(executionId=run_id, remoteRoot=str(root), sessionId=meta['sessionId'], terminal=terminal, terminalMode=mode, outputMode=output_mode, resultRequest=meta.get('resultRequest'))
    run = root / request['executionId']
    if run.parent != root or not request['executionId'].startswith('run-'):
        raise ValueError('Invalid execution path')
    meta = json.loads((run / 'meta.json').read_text())
    if meta['executionId'] != request['executionId']:
        raise ValueError('Execution identity mismatch')
    if meta.get('outputMode') == 'json' and action in ('reserve-response','respond','settle-response','reserve-message','settle-message'):
        raise ValueError('JSON output has no verified input path')
    if action == 'reserve-message':
        from message import reserve_message
        return reserve_message(request,run,meta,request_ledger,input_binding,session_files,read_history,message_idle)
    if action == 'settle-message':
        from message import settle_message
        return settle_message(request,run,meta,request_ledger,session_files,read_history)
    if action == 'settle-resume':
        from resume import settle_resume
        return settle_resume(request, run, meta, session_files, request_ledger)
    if action == 'stop':
        if not isinstance(request.get('requestId'), str) or not 1 <= len(request['requestId']) <= 128 or not all(c.isalnum() or c in '._:-' for c in request['requestId']):
            raise ValueError('Invalid stop request identity')
        sys.path.insert(0, str(root))
        from ownership import queue_stop
        with open(run / 'stop.lock', 'a') as lock:
            os.chmod(run / 'stop.lock', 0o600)
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            return queue_stop(run, meta, request)
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
        input_type = request.get('inputType')
        step_index = request.get('stepIndex')
        if input_type in ('composer-text', 'composer-submit'):
            with request_ledger(run) as ledger:
                reservation=ledger.get(request_id)
            authorized=(meta.get('resume') or {}).get('requestId')==request_id or (reservation and reservation.get('message') and not reservation.get('resolution'))
            valid = meta.get('terminalMode') == 'tui' and authorized and request.get('kind') == 'composer' and type(step_index) is int and 0 <= step_index < 128
            if input_type == 'composer-submit': valid = valid and payload == b'\r'
            else:
                text = payload.decode('utf8')
                valid = valid and 0 < len(payload) <= 64 and all(ord(c) >= 32 and ord(c) != 127 for c in text)
        elif input_type in ('tui-navigation', 'tui-text', 'tui-submit'):
            valid = meta.get('terminalMode') == 'tui' and request.get('kind') == 'question' and type(step_index) is int and 0 <= step_index < 128
            if input_type == 'tui-navigation': valid = valid and payload in (b'\x1b[A', b'\x1b[B')
            elif input_type == 'tui-submit': valid = valid and payload == b'\r'
            else:
                text = payload.decode('utf8')
                valid = valid and 0 < len(payload) <= 64 and all(ord(c) >= 32 and ord(c) != 127 for c in text)
        elif input_type == 'readline-text':
            text = payload[:-1].decode('utf8')
            valid = meta.get('terminalMode', 'readline') == 'readline' and request.get('kind') == 'question' and payload.endswith(b'\r') and 0 < len(payload) <= 1025 and text == text.strip() and all(ord(c) >= 32 and ord(c) != 127 for c in text)
        elif request.get('kind') == 'approval':
            valid = payload in ((b'y', b'n') if meta.get('terminalMode') == 'tui' else (b'y\r', b'n\r'))
        else:
            valid = request.get('kind') in ('question', 'recovery') and payload[0:1] in [bytes([c]) for c in range(49, 58)] and (len(payload) == 1 if meta.get('terminalMode') == 'tui' else len(payload) == 2 and payload[1:] == b'\r')
        if not valid:
            raise ValueError('Only verified bounded response input is allowed')
        binding = {key: request.get(key) for key in ('sessionId', 'executionId', 'interactionId', 'revision', 'toolId', 'kind', 'answerDigest')}
        with request_ledger(run) as ledger:
            prior = ledger.get(request_id)
            if prior:
                if prior['binding'] != binding:
                    raise ValueError('Request identity conflict')
                if step_index is None and prior['state'] != 'reserved':
                    return dict(requestId=request_id, state=prior['state'], reason=prior.get('reason'))
                if prior.get('resolution'):
                    return dict(requestId=request_id, state=prior['state'], reason='request-already-resolved')
                previous = prior.get('steps', {}).get(str(step_index)) if step_index is not None else None
                if previous:
                    if previous['digest'] != hashlib.sha256(payload).hexdigest() or previous['inputType'] != input_type:
                        raise ValueError('Response step identity conflict')
                    return dict(requestId=request_id, state=previous['state'], reason=previous.get('reason'))
                steps = prior.get('steps', {})
                if step_index is not None and not (step_index == 0 and not steps and prior['state'] == 'reserved') and (step_index != len(steps) or not steps or steps[str(step_index - 1)]['state'] != 'written' or steps[str(step_index - 1)]['inputType'] in ('tui-submit', 'composer-submit')):
                    raise ValueError('Response continuation is not confirmed')
            if not prior and len(ledger) >= 256:
                raise ValueError('Response request limit reached')
            phase = ('sessionId', 'executionId', 'toolId', 'kind')
            if any(key != request_id and not value.get('resolution') and value['state'] in ('queued', 'written') and all(value['binding'].get(field) == binding.get(field) for field in phase) for key,value in ledger.items()):
                if prior and prior['state'] == 'reserved':
                    prior.update(state='rejected', reason='interaction-already-submitted')
                return dict(requestId=request_id, state='rejected', reason='interaction-already-submitted')
            buffer = json.loads((run / 'buffer.json').read_text())
            reason = input_binding(run, meta, request, buffer['cursor'])
            if step_index is not None:
                if not prior and step_index != 0: raise ValueError('First response step must be zero')
                parent = prior or dict(binding=binding, state='queued', createdAt=now(), steps={})
                ledger[request_id] = parent
                record = dict(state='queued', digest=hashlib.sha256(payload).hexdigest(), inputType=input_type, createdAt=now())
                parent.setdefault('steps', {})[str(step_index)] = record
                parent['state'] = 'queued'
            else:
                record = dict(binding=binding, state='queued', createdAt=prior.get('createdAt') if prior else now())
                ledger[request_id] = record
            if reason:
                record.update(state='rejected', reason=reason)
                if step_index == 0: parent.update(state='rejected', reason=reason)
                return dict(requestId=request_id, state='rejected', reason=reason)
            frame = {key: request.get(key) for key in ('requestId', 'sessionId', 'executionId', 'interactionId', 'expectedCursor', 'historyHash', 'processIdentity', 'dataBase64', 'modalHash', 'stepIndex', 'inputType')}
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
                if step_index == 0: parent.update(state='rejected', reason='input-fifo-unavailable')
                return dict(requestId=request_id, state='rejected', reason=record['reason'])
            return dict(requestId=request_id, state='queued')
    if action == 'status':
        cursor = request.get('cursor', 0)
        try:
            buffer = json.loads((run / 'buffer.json').read_text())
        except (OSError, ValueError):
            buffer = dict(cursor=cursor, first=cursor + 1, observations=[])
        observations = [frame for frame in buffer['observations'] if frame['seq'] > cursor and frame['kind'] in ('pty','json-output')]
        sid, manifest, history_path = session_files(meta)
        if sid and not meta.get('sessionId'):
            # Keep session discovery separate from the supervisor's mutable process metadata.
            # A concurrent final exit write must never be overwritten by a stale status read.
            with open(run / 'session.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                owner = session_owner(meta, manifest.get('pid')) if manifest else session_cache(meta).get('sessionOwner')
                save(run / 'session.json', dict(sessionId=sid, executionId=meta['executionId'], identity=meta.get('identity'), sessionOwner=owner))
        history = None
        history_error = None
        if history_path:
            try:
                payload = read_history(history_path)
                history = dict(dataBase64=base64.b64encode(payload).decode(), sha256=hashlib.sha256(payload).hexdigest())
            except OSError as exc:
                history_error = type(exc).__name__
            except ValueError as exc:
                history_error = str(exc)
        elif sid or meta.get('sessionId'):
            history_error = 'missing'
        expected = meta.get('identity')
        actual = identity(expected['pid']) if expected else None
        same_boot = meta['bootId'] == boot_id()
        alive = bool(same_boot and expected and actual == expected)
        confirmed = bool(same_boot and ((expected and (actual == expected or actual is None)) or (meta.get('startupFailed') and meta.get('supervisorIdentity'))))
        screen = None
        observed_terminal = meta['terminal']
        if meta.get('outputMode') != 'json' and alive:
            target = meta['tmuxSession'] + ':0.0'
            try:
                cols, rows, x, y = terminal_geometry(meta)
                observed_terminal = dict(cols=cols, rows=rows)
                if request.get('fullScreen') or cursor < buffer['first'] - 1 or observed_terminal != request.get('terminal', meta['terminal']):
                    payload = subprocess.check_output(['tmux','-S',meta['tmuxSocket'],'capture-pane','-p','-e','-t',target],timeout=5)
                    if len(payload) > LIMIT or len(payload.splitlines()) != rows or terminal_geometry(meta) != (cols, rows, x, y):
                        raise ValueError('Screen snapshot changed or exceeded bounds')
                    restored = b'\x1b[0m\x1b[2J\x1b[H' + b'\r\n'.join(payload.splitlines()) + f'\x1b[{y+1};{x+1}H'.encode()
                    screen = dict(dataBase64=base64.b64encode(restored).decode(), cols=cols, rows=rows, cursorX=x, cursorY=y)
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        try:
            phase = json.loads((run / 'phase.json').read_text())
        except FileNotFoundError:
            phase = dict(epoch=0, active=False)
        ledger_current = True
        try:
            requests = json.loads((run / 'requests.json').read_text())
        except (OSError, ValueError):
            requests = {}
            ledger_current = False
        if not isinstance(requests, dict) or any(not isinstance(value, dict) or value.get('state') not in ('reserved', 'queued', 'written', 'rejected') or not isinstance(value.get('binding'), dict) or value.get('resolution') not in (None, 'delivered', 'not-submitted') for value in requests.values()):
            requests = {}
            ledger_current = False
        try:
            stop_result = json.loads((run / 'stop-result.json').read_text())
        except FileNotFoundError:
            stop_result = None
        try:
            ownership = json.loads((run / 'ownership.json').read_text())
        except FileNotFoundError:
            ownership = {}
        if not stop_result:
            try:
                pending_stop = json.loads((run / 'stop-request.json').read_text())
                stop_result = dict(executionId=pending_stop['executionId'],requestId=pending_stop['requestId'],state='stopping',childrenVerified=False,trackedCount=ownership.get('trackedCount',0),remaining=ownership.get('owned',[]),reason=None,observedAt=pending_stop.get('observedAt') or now())
            except FileNotFoundError:
                pass
        modal = modal_witness(meta)
        composer = composer_witness(meta)
        resumed_owner = resume_owner(meta) if not manifest else None
        cli_owner = session_owner(meta, manifest.get('pid')) if manifest else resumed_owner
        composer_idle = bool(resumed_owner and completed_resume_turn(meta, history_path) and composer and not modal and not phase.get('active') and
                             base64.b64decode(composer['dataBase64']).decode().splitlines()[composer['cursorY']][2:].rstrip() in ('','Ask anything...'))
        return dict(executionId=meta['executionId'], sessionId=sid, supersededBy=meta.get('resumedBy'), observations=observations, cursor=buffer['cursor'], modalHash=modal['sha256'] if modal else None, modalPane=modal, composerHash=composer['sha256'] if composer else None, composerPane=composer, resume=meta.get('resume'),
                    gap=cursor < buffer['first'] - 1, history=history, historyError=history_error, screen=screen, phase=phase,
                    process=dict(kind='process', identity=expected, alive=alive, identityConfirmed=confirmed,
                                 exitCode=meta.get('exitCode'), manifestStatus=manifest.get('status') if manifest else meta.get('ownedManifestStatus'),
                                 composerIdle=composer_idle,
                                 supervisorAlive=bool(meta.get('supervisorIdentity') and identity(meta['supervisorIdentity']['pid']) == meta['supervisorIdentity']),
                                 stop=stop_result,
                                 children=busy_children(meta, ownership, cli_owner), trackingError=ownership.get('trackingError'),
                                 childrenVerified=bool(same_boot and ownership.get('cliIdentity')==expected and ownership.get('supervisorIdentity')==meta.get('supervisorIdentity') and not ownership.get('owned') and not ownership.get('trackingError')),
                                 requestedStop=any(value['state']=='written' and value['binding']['kind']=='recovery' and value['binding']['answerDigest']==hashlib.sha256(b'Stop this run').hexdigest() for value in requests.values())),
                    requests=[dict(requestId=key, state=value['state'], reason=value.get('reason'), binding=value['binding'], createdAt=value.get('createdAt'), resolution=value.get('resolution'), message=value.get('message'), witness=value.get('witness'), baselineMessageCount=value.get('baselineMessageCount'), baselineLastMessageId=value.get('baselineLastMessageId'), steps=[dict(index=int(i), state=step['state'], reason=step.get('reason')) for i,step in value.get('steps', {}).items()]) for key,value in requests.items()],
                    management=dict(remoteRoot=str(root), terminal=observed_terminal, terminalMode=meta.get('terminalMode', 'readline'), outputMode=meta.get('outputMode','terminal'), bootId=meta['bootId'], phaseSupported=meta.get('outputMode')!='json', responseReservation=meta.get('outputMode')!='json', inputLedgerCurrent=ledger_current))
    raise ValueError('Unsupported supervisor action')

if len(sys.argv) >= 3 and sys.argv[1] == '--serve':
    serve(Path(sys.argv[2]))
else:
    try:
        print(json.dumps(handle(json.load(sys.stdin))))
    except Exception as exc:
        print(json.dumps(dict(error=getattr(exc, 'code', type(exc).__name__), message=str(exc))))
        sys.exit(0)
