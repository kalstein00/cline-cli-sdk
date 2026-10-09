"""Exact Linux process ownership evidence and bounded termination for one run."""
import ctypes, datetime, json, os, signal, time
from pathlib import Path

MAX_OWNED = 4096

def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def process(pid):
    try:
        path = Path('/proc') / str(pid)
        value = (path / 'stat').read_text()
        fields = value[value.rfind(')') + 2:].split()
        if fields[0] == 'Z':
            return None  # Zombies cannot execute or retain running children.
        return dict(identity=dict(pid=int(pid), startTime=fields[19], bootId=Path('/proc/sys/kernel/random/boot_id').read_text().strip()), ppid=int(fields[1]))
    except (OSError, ValueError, IndexError):
        return None

def matches(expected):
    actual = process(expected['pid']) if expected else None
    return bool(actual and actual['identity'] == expected)

def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return None

def atomic(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value))
    os.chmod(tmp, 0o600)
    tmp.replace(path)

class Ownership:
    def __init__(self, run, supervisor, cli):
        self.run, self.supervisor, self.cli = run, supervisor, cli
        self.owned = {}
        self.total = 0
        self.error = None
        self.last = None

    @staticmethod
    def subreaper():
        if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise OSError('Linux pidfd process targeting is required')
        fd = os.pidfd_open(os.getpid())
        os.close(fd)
        # Orphaned commands stay children of this exact SDK supervisor.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Unable to enable owned-child tracking')

    def scan(self):
        if not matches(self.supervisor):
            raise ValueError('Supervisor identity changed')
        current = {}
        for path in Path('/proc').iterdir():
            if path.name.isdigit():
                item = process(path.name)
                if item:
                    current[item['identity']['pid']] = item
        # Start with still-identical observed descendants and newly adopted children.
        owned = {pid: ident for pid, ident in self.owned.items() if current.get(pid, {}).get('identity') == ident}
        if current.get(self.cli['pid'], {}).get('identity') == self.cli:
            owned[self.cli['pid']] = self.cli
        roots = {self.supervisor['pid'], *owned.keys()}
        changed = True
        while changed:
            changed = False
            for pid, item in current.items():
                if pid not in owned and item['ppid'] in roots and pid != self.supervisor['pid']:
                    if len(owned) >= MAX_OWNED:
                        self.error = 'owned-process-limit'
                        raise ValueError(self.error)
                    owned[pid] = item['identity']
                    roots.add(pid)
                    changed = True
        # A privilege-changing child must not disappear from evidence just because
        # /proc restrictions prevent reading it. This is a failure, not termination.
        for pid in list(roots):
            parent = current.get(pid)
            if not parent:
                continue
            try:
                for thread in (Path('/proc') / str(pid) / 'task').iterdir():
                    try:
                        child_ids = (thread / 'children').read_text().split()
                    except FileNotFoundError:
                        if not thread.exists() or not matches(parent['identity']):
                            continue  # Linux threads may exit during a /proc sweep.
                        raise
                    for child in child_ids:
                        if int(child) not in current and (Path('/proc') / child).exists():
                            born = process(child)
                            if born:
                                # A child may fork after the initial /proc directory
                                # snapshot. Read and retain it rather than treating
                                # this ordinary race as an inaccessible process.
                                if len(owned) >= MAX_OWNED:
                                    self.error = 'owned-process-limit'
                                    raise ValueError(self.error)
                                current[int(child)] = born
                                owned[int(child)] = born['identity']
                                roots.add(int(child))
                                continue
                            try:
                                raw = (Path('/proc') / child / 'stat').read_text()
                                zombie = raw[raw.rfind(')') + 2:].split()[0] == 'Z'
                            except FileNotFoundError:
                                if not (Path('/proc') / child).exists():
                                    continue
                                zombie = False
                            except (OSError, ValueError, IndexError):
                                zombie = False
                            if not zombie:
                                raise ValueError('owned-child-observation-unavailable')
            except OSError:
                if matches(parent['identity']):
                    self.error = 'owned-child-observation-unavailable'
                    raise ValueError(self.error)
        self.total += sum(1 for pid, ident in owned.items() if self.owned.get(pid) != ident)
        self.owned = owned
        value = dict(supervisorIdentity=self.supervisor, cliIdentity=self.cli, owned=list(owned.values()), trackedCount=self.total, trackingError=self.error, observedAt=stamp())
        stable = {key: val for key, val in value.items() if key != 'observedAt'}
        if stable != self.last:
            atomic(self.run / 'ownership.json', value)
            self.last = stable
        return list(owned.values())

    def signal(self, ident, sig):
        try:
            fd = os.pidfd_open(ident['pid'])
        except ProcessLookupError:
            return
        try:
            # pidfd binds the signal to the inspected OS process across PID reuse.
            if matches(ident):
                signal.pidfd_send_signal(fd, sig, None, 0)
        finally:
            os.close(fd)

    def stop(self, request):
        result = dict(executionId=request['executionId'], requestId=request['requestId'], state='unknown', childrenVerified=False, trackedCount=self.total, remaining=[], reason=None, observedAt=stamp())
        frozen = {}
        try:
            if self.error:
                raise ValueError(self.error)
            # Quiesce the exact tree first; repeated scans catch children forked during the sweep.
            for _ in range(32):
                owned = self.scan()
                fresh = [ident for ident in owned if frozen.get(ident['pid']) != ident]
                if not fresh:
                    break
                for ident in sorted(fresh, key=lambda value: value != self.cli):
                    self.signal(ident, signal.SIGSTOP)
                    frozen[ident['pid']] = ident
            else:
                raise ValueError('process-tree-did-not-quiesce')
            result['targets'] = list(self.scan())
            for ident in result['targets']:
                self.signal(ident, signal.SIGTERM)
                self.signal(ident, signal.SIGCONT)
            deadline = time.monotonic() + 2
            while self.scan() and time.monotonic() < deadline:
                time.sleep(.05)
            deadline = time.monotonic() + 3
            while self.scan() and time.monotonic() < deadline:
                for ident in self.scan():
                    self.signal(ident, signal.SIGKILL)
                time.sleep(.05)
            remaining = self.scan()
            result.update(remaining=remaining, trackedCount=self.total, childrenVerified=not remaining, state='confirmed' if not remaining else 'unknown', reason=None if not remaining else 'termination-timeout', observedAt=stamp())
        except (OSError, ValueError) as exc:
            result.update(reason=str(exc), remaining=list(self.owned.values()), trackedCount=self.total, observedAt=stamp())
        finally:
            # Never leave a live process frozen if ownership/termination verification failed.
            for ident in frozen.values():
                try:
                    self.signal(ident, signal.SIGCONT)
                except OSError:
                    pass
        atomic(self.run / 'stop-result.json', result)
        return result

def queue_stop(run, meta, request):
    prior = read_json(run / 'stop-request.json')
    if prior and any(prior.get(key) != request[key] for key in ('executionId', 'requestId')):
        raise ValueError('A stop request already targets this execution')
    result = read_json(run / 'stop-result.json')
    if result:
        return result
    evidence = read_json(run / 'ownership.json')
    supervisor = meta.get('supervisorIdentity')
    if not evidence or evidence.get('supervisorIdentity') != supervisor or not matches(supervisor) or evidence.get('trackingError'):
        result = dict(executionId=request['executionId'],requestId=request['requestId'],state='unknown',childrenVerified=False,trackedCount=(evidence or {}).get('trackedCount',0),remaining=(evidence or {}).get('owned',[]),reason='owned-supervisor-unavailable',observedAt=stamp())
        # Preserve a refused stop across app restarts without scheduling any signal.
        atomic(run / 'stop-result.json', result)
        return result
    atomic(run / 'stop-request.json', dict(**{key: request[key] for key in ('executionId', 'requestId')},observedAt=stamp()))
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        result = read_json(run / 'stop-result.json')
        if result:
            return result
        time.sleep(.05)
    return dict(executionId=request['executionId'],requestId=request['requestId'],state='unknown',childrenVerified=False,trackedCount=evidence['trackedCount'],remaining=evidence['owned'],reason='stop-confirmation-timeout',observedAt=stamp())
