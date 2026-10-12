import hashlib
import json
import os
import platform
import pty
import re
import selectors
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


def observe_help(path):
    result = dict(state='execution-failed', exitCode=None, channels=[])
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    try:
        with subprocess.Popen([path, '--help'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env={**os.environ, 'CLINE_NO_AUTO_UPDATE': '1'}) as child:
            with selectors.DefaultSelector() as streams:
                streams.register(child.stdout, selectors.EVENT_READ, 'stdout')
                streams.register(child.stderr, selectors.EVENT_READ, 'stderr')
                deadline = time.monotonic() + 10
                failure = None
                while streams.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        failure = 'timeout'
                        break
                    for key, _ in streams.select(min(remaining, .1)):
                        chunk = os.read(key.fileobj.fileno(), 8192)
                        if not chunk:
                            streams.unregister(key.fileobj)
                            continue
                        target = output[key.data]
                        available = 65536 - len(target)
                        target.extend(chunk[:available])
                        if len(chunk) > available:
                            failure = 'truncated'
                            break
                    if failure:
                        break
                if failure:
                    child.kill()
                try:
                    code = child.wait(timeout=max(.1, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    child.kill()
                    code = child.wait()
                    failure = 'timeout'
                result.update(state=failure or ('success' if code == 0 else 'exit-failed'), exitCode=code,
                              channels=[channel for channel, data in output.items() if data])
    except OSError:
        return None, result
    if result['state'] != 'success':
        return None, result
    text = '\n'.join(bytes(value).decode('utf8', errors='replace') for value in output.values())
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    flags = sorted(set(re.findall(r'(?<!\S)--[a-z][a-z-]*', text)))
    if not flags:
        result['state'] = 'unparseable'
        return None, result
    return flags, result


if sys.version_info < (3, 9):
    print(json.dumps(dict(error='python-version-unsupported', message='Python 3.9 or newer is required.')))
    sys.exit(0)
request = json.load(sys.stdin)
path = request.get('cliPath') or shutil.which('cline')
discovery = 'explicit' if request.get('cliPath') else 'noninteractive-path'
if not path:
    try:
        login = subprocess.run(['bash', '-lic', 'printf "\\nCLINE_SDK_PATH=%s\\n" "$(command -v cline)"'],
                               capture_output=True, text=True, timeout=10)
        paths = [line[len('CLINE_SDK_PATH='):] for line in login.stdout.splitlines() if line.startswith('CLINE_SDK_PATH=')]
        path = paths[-1] if paths and paths[-1] else None
        discovery = 'login-shell' if path else 'not-installed' if login.returncode == 0 else 'login-shell-failed'
    except (OSError, subprocess.TimeoutExpired):
        discovery = 'login-shell-failed'
digest = None
flags = None
help_result = dict(state='unavailable', exitCode=None, channels=[])
if path and os.path.isfile(path) and os.access(path, os.X_OK):
    try:
        h = hashlib.sha256()
        with open(path, 'rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                h.update(chunk)
        digest = h.hexdigest()
    except OSError:
        pass
    flags, help_result = observe_help(path)
working_pty = False
try:
    a, b = pty.openpty()
    os.close(a)
    os.close(b)
    working_pty = True
except OSError:
    pass
tmux = shutil.which('tmux')
working_ownership = False
try:
    if hasattr(signal, 'pidfd_send_signal'):
        fd = os.pidfd_open(os.getpid())
        os.close(fd)
        working_ownership = True
except (AttributeError, OSError):
    pass
native_sessions = None
candidate = request.get('sessionDirectory')
if candidate:
    directory = Path(candidate).expanduser()
else:
    # Observed Cline data layout. Require an existing readable directory;
    # alternate layouts must be supplied explicitly, never inferred from cwd.
    home = Path(os.environ.get('CLINE_DIR', '').strip() or (Path.home() / '.cline'))
    data = Path(os.environ.get('CLINE_DATA_DIR', '').strip() or (home / 'data'))
    directory = Path(os.environ.get('CLINE_SESSION_DATA_DIR', '').strip() or (data / 'sessions'))
if directory.is_absolute() and directory.is_dir() and os.access(directory, os.R_OK | os.X_OK):
    native_sessions = str(directory.resolve())
print(json.dumps(dict(platform=platform.system(), pythonVersion=platform.python_version(), pty=working_pty,
                      processOwnership=working_ownership, tmux=subprocess.check_output([tmux, '-V'], text=True).strip() if tmux else None,
                      cliPath=path, cliVersion=None, cliHash=digest, cliFlags=flags, help=help_result, discovery=discovery,
                      nativeSessionDirectory=native_sessions,
                      bootId=open('/proc/sys/kernel/random/boot_id').read().strip() if platform.system() == 'Linux' else '')))
