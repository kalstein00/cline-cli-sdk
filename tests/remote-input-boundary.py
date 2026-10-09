"""Real helper stdin -> FIFO -> PTY supervisor regression; controlled CLI, no model/auth."""
import base64, hashlib, json, os, shlex, subprocess, sys, tempfile, time, tty, unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / 'packages/sdk/remote/supervisor.py'
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

if '--controlled-cli' in sys.argv:
    tty.setraw(sys.stdin.fileno())
    if '--composer' in sys.argv:
        rule = '─' * 40
        sys.stdout.write('\x1b[2J\x1b[35;1H' + rule + '\x1b[36;1H❯ controlled placeholder\x1b[37;1H' + rule + '\x1b[38;1H● Act (Tab)\x1b[40;1HAuto-approve all disabled (Shift+Tab)\x1b[36;3H')
    else:
        sys.stdout.write('\x1b[2J\x1b[HCline is asking a question\r\nChoose BLUE\r\nRED\r\nBLUE\r\n')
    sys.stdout.flush()
    while True:
        value = os.read(sys.stdin.fileno(), 64)
        if not value: break
        sys.stdout.write('\x1b[10;1HRECEIVED:' + value.decode('utf8') + '\r\n')
        sys.stdout.flush()
    sys.exit(0)


def wait_for(check, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result: return result
        time.sleep(.05)
    raise AssertionError('Bounded wait expired before the required remote witness')


class RemoteInputBoundary(unittest.TestCase):
    def exercise(self, input_type, composer=False):
        with tempfile.TemporaryDirectory(prefix='cline-sdk-null-input-') as directory:
            root = Path(directory)
            os.chmod(root, 0o700)
            run = root / 'run-controlled'
            run.mkdir(mode=0o700)
            socket = root / 'tmux.sock'
            sid = 'controlled-session'
            sessions = root / 'data/sessions' / sid
            sessions.mkdir(parents=True)
            history = b'{"version":1,"messages":[]}'
            (sessions / (sid + '.messages.json')).write_bytes(history)
            meta = dict(owner='cline-cli-sdk', executionId=run.name, sessionId=sid,
                        bootId=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                        cwd=str(root), dataDir=str(root / 'data'), cliPath=sys.executable,
                        argv=[sys.executable, str(Path(__file__).resolve()), '--controlled-cli'] + (['--composer'] if composer else []),
                        terminalMode='tui', terminal=dict(rows=40, cols=120), tmuxSocket=str(socket), tmuxSession='controlled',
                        priorSessions=[])
            if composer: meta['resume'] = dict(requestId='input-controlled')
            (run / 'meta.json').write_text(json.dumps(meta))
            ready = root / 'ready'
            command = 'while [ ! -f ' + shlex.quote(str(ready)) + ' ]; do sleep .01; done; exec ' + shlex.join([sys.executable, str(HELPER), '--serve', str(run)])
            subprocess.run(['tmux', '-S', str(socket), 'new-session', '-d', '-s', 'controlled', '-x', '120', '-y', '40', command], check=True)
            subprocess.run(['tmux', '-S', str(socket), 'set-option', '-g', 'status', 'off'], check=True)
            subprocess.run(['tmux', '-S', str(socket), 'set-window-option', '-t', 'controlled', 'remain-on-exit', 'on'], check=True)
            ready.touch()
            def load(name):
                try: return json.loads((run / name).read_text())
                except (FileNotFoundError, ValueError): return None
            def handle(request):
                process = subprocess.run([sys.executable, str(HELPER)], input=json.dumps(dict(root=str(root), executionId=run.name, **request)), text=True, capture_output=True, timeout=10)
                self.assertEqual(process.returncode, 0, process.stderr)
                result = json.loads(process.stdout)
                self.assertNotIn('error', result, result)
                return result
            try:
                meta = wait_for(lambda: (load('meta.json') or {}).get('identity') and load('meta.json'))
                (sessions / (sid + '.json')).write_text(json.dumps(dict(session_id=sid, pid=meta['identity']['pid'], status='pending')))
                status = wait_for(lambda: (load('buffer.json') or {}).get('observations') and handle(dict(action='status', cursor=0)))
                try: pane = wait_for(lambda: handle(dict(action='status', cursor=0)).get('composerPane' if composer else 'modalPane'))
                except AssertionError:
                    geometry = subprocess.run(['tmux', '-S', str(socket), 'display-message', '-p', '-t', 'controlled', '#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}'], text=True, capture_output=True).stdout
                    raw = subprocess.run(['tmux', '-S', str(socket), 'capture-pane', '-p', '-t', 'controlled'], text=True, capture_output=True).stdout
                    raise AssertionError('No pane witness; geometry=' + geometry + ' pane=' + repr(raw))
                request = dict(requestId='input-controlled', sessionId=sid, interactionId='controlled-phase', revision=1,
                               toolId='controlled-tool', kind='composer' if composer else 'question',
                               answerDigest=hashlib.sha256(b'hello' if composer else b'BLUE').hexdigest(),
                               expectedCursor=status['cursor'], historyHash=hashlib.sha256(history).hexdigest(),
                               processIdentity=meta['identity'], modalHash=pane['sha256'])
                if input_type != 'omitted': request['inputType'] = input_type
                if composer: request['stepIndex'] = 0
                reserved = handle(dict(request, action='reserve-response'))
                self.assertEqual(reserved['state'], 'reserved')
                queued = handle(dict(request, action='respond', dataBase64=base64.b64encode(b'hello' if composer else b'2').decode()))
                self.assertEqual(queued['state'], 'queued')
                def written():
                    ledger = load('requests.json') or {}
                    parent = ledger.get('input-controlled', {})
                    return parent if parent.get('state') == 'written' else None
                try: witness = wait_for(written)
                except AssertionError:
                    pane_failure = subprocess.run(['tmux', '-S', str(socket), 'capture-pane', '-p', '-S', '-100', '-t', 'controlled'], text=True, capture_output=True).stdout
                    raise AssertionError('No written receipt; supervisor pane: ' + pane_failure)
                self.assertEqual(witness['state'], 'written')
                current = handle(dict(action='status', cursor=0))
                self.assertTrue(current['process']['alive'])
                self.assertTrue(current['process']['supervisorAlive'])
                self.assertTrue(any(o['kind'] == 'pty' and b'RECEIVED:' in base64.b64decode(o['dataBase64']) for o in wait_for(lambda: handle(dict(action='status', cursor=0))['observations'])))
                print(json.dumps(dict(inputType=input_type, composer=composer, receipt='written', supervisorAlive=True)), flush=True)
            finally:
                # This unique test-owned socket has no shared CLI or user sessions.
                subprocess.run(['tmux', '-S', str(socket), 'kill-server'], capture_output=True, timeout=5)

    def test_nullable_and_ordinary_choice_frames(self):
        for value in ('omitted', None, 'choice'):
            with self.subTest(inputType=value): self.exercise(value)

    def test_composer_frame_keeps_its_distinct_witness(self):
        self.exercise('composer-text', composer=True)


if __name__ == '__main__': unittest.main()
