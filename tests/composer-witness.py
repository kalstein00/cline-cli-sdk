"""Platform-independent tests of supervisor functions with controlled tmux/process IO.

Load function definitions via AST to avoid Linux imports and the helper's stdin entrypoint.
Run with Python 3; no CLI, credentials, Linux host or tmux server required.
"""
import ast
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import struct
import shlex
import runpy
from contextlib import contextmanager
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'packages/sdk/remote/supervisor.py'
tree = ast.parse(SOURCE.read_text(encoding='utf8'))
functions = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef)
                            and node.name in ('composer_witness', 'modal_witness', 'message_idle', 'terminal_geometry', 'valid_terminal_size', 'input_binding', 'handle', 'sync_terminal_size')], type_ignores=[])


class ComposerWitness(unittest.TestCase):
    def setUp(self):
        self.io = Mock()
        self.io.SubprocessError = subprocess.SubprocessError
        self.scope = dict(base64=base64, hashlib=hashlib, json=json, subprocess=self.io, LIMIT=512*1024)
        exec(compile(functions, str(SOURCE), 'exec'), self.scope)
        self.fixture = json.loads((ROOT / 'fixtures/chat/company-composer-layout.json').read_text())
        self.meta = dict(terminalMode='tui', tmuxSocket='fixture', tmuxSession='fixture',
                         terminal=dict(rows=40, cols=120), identity=dict(pid=1), supervisorIdentity=dict(pid=2))

    def pane(self, row=32, text='Ask anything...', footer=None, x=2, cols=120, rows=40):
        lines = [''] * rows
        lines[row-1:row+2] = ['─'*cols, '❯ '+text, '─'*cols]
        for i, line in enumerate(footer or []):
            lines[row+2+i] = line
        self.capture(lines, row, x, cols, rows)
        return lines

    def capture(self, lines, row, x=2, cols=120, rows=40):
        self.io.check_output.side_effect = lambda args, **kwargs: (
            f'{cols},{rows},{x},{row}' if 'display-message' in args else ('\n'.join(lines)+'\n').encode())

    def witness(self):
        return self.scope['composer_witness'](self.meta)

    def test_footer_independent_focus_at_every_valid_row(self):
        for row in range(1, 39):
            with self.subTest(row=row):
                self.pane(row)
                self.assertEqual(self.witness()['cursorY'], row)
        self.pane(footer=self.fixture['footer'])
        original = self.witness()['sha256']
        self.pane(footer=['changed status'])
        self.assertEqual(self.witness()['sha256'], original)
        self.pane(text='draft')
        self.assertNotEqual(self.witness()['sha256'], original)

    def test_invalid_structure_focus_and_geometry_are_rejected(self):
        for row in (31, 34, 0, 39):
            lines = self.pane()
            self.capture(lines, row)
            self.assertIsNone(self.witness())
        for x in (0, 1, 120):
            self.pane(x=x)
            self.assertIsNone(self.witness())
        for row, value in ((31, ''), (33, '─'*19), (32, '> Ask anything...')):
            lines = self.pane()
            lines[row] = value
            self.capture(lines, 32)
            self.assertIsNone(self.witness())
        lines = self.pane()
        self.capture(lines, 32, cols=19)
        self.assertIsNone(self.witness())

    def test_terminal_sizes_and_resize_invalidate_old_witness(self):
        for cols, rows in ((80,24), (160,50), (20,5), (500,200)):
            self.pane(row=2, cols=cols, rows=rows)
            witness=self.witness()
            self.assertEqual((witness['cols'], witness['rows']), (cols, rows))
        lines=self.pane()
        old=self.witness()['sha256']
        self.capture(lines+[''],32,rows=41)
        self.assertNotEqual(self.witness()['sha256'],old)
        raw=('\n'.join(lines)+'\n').encode()
        self.io.check_output.side_effect=['120,40,2,32',raw,'120,41,2,32']
        self.assertIsNone(self.witness())
        for cols, rows in ((501,40),(120,201),(20,4),(19,40)):
            self.capture(lines,32,cols=cols,rows=rows)
            self.assertIsNone(self.witness())

    def test_remote_input_binding_rejects_wrap_and_old_geometry_before_write(self):
        self.meta.update(executionId='run-test',resume={'requestId':'request'})
        self.scope.update(identity=lambda pid: dict(pid=pid), session_files=lambda meta: ('session',None,'history'),read_history=lambda path: b'{}')
        self.pane(row=2,cols=20,rows=5)
        request=dict(executionId='run-test',processIdentity=dict(pid=1),requestId='request',inputType='composer-text',
                     modalHash=self.witness()['sha256'],sessionId='session',historyHash=hashlib.sha256(b'{}').hexdigest(),dataBase64=base64.b64encode(b'x'*12))
        self.assertIsNone(self.scope['input_binding'](None,self.meta,request,0))
        request['dataBase64']=base64.b64encode(b'x'*13)
        self.assertEqual(self.scope['input_binding'](None,self.meta,request,0),'composer-width-exceeded')
        self.pane(row=2,cols=20,rows=6)
        self.assertEqual(self.scope['input_binding'](None,self.meta,request,0),'terminal-modal-changed')

    def test_message_reservation_checks_target_without_requiring_input_payload(self):
        reserve=runpy.run_path(str(ROOT/'packages/sdk/remote/message.py'))['reserve_message']
        self.meta.update(executionId='run-test')
        history=b'{"version":1,"sessionId":"session","messages":[]}'
        self.scope.update(identity=lambda pid: dict(pid=pid),session_files=lambda meta: ('session',dict(status='idle',pid=1),'history'),
                          read_history=lambda path: history,session_owner=lambda *args: 1,busy_children=lambda *args: [],modal_witness=lambda meta: None)
        ledger={}
        @contextmanager
        def lock(run):
            yield ledger
        with tempfile.TemporaryDirectory() as directory:
            run=Path(directory)
            (run/'ownership.json').write_text('{}')
            (run/'buffer.json').write_text('{"cursor":0}')
            self.pane(row=15,cols=80,rows=24)
            request=dict(executionId='run-test',processIdentity=dict(pid=1),requestId='request',kind='composer',revision=0,
                         modalHash=self.witness()['sha256'],sessionId='session',historyHash=hashlib.sha256(history).hexdigest(),answerDigest=hashlib.sha256(b'hello').hexdigest())
            result=reserve(request,run,self.meta,lock,self.scope['input_binding'],self.scope['session_files'],self.scope['read_history'],self.scope['message_idle'])
            self.assertEqual(result,dict(state='reserved',fresh=True))
            self.assertEqual(ledger['request']['state'],'reserved')

    def test_short_modal_binds_choices_and_custom_text_in_last_three_rows(self):
        self.meta.update(executionId='run-test')
        self.scope.update(identity=lambda pid: dict(pid=pid),session_files=lambda meta: ('session',None,'history'),read_history=lambda path: b'{}')
        def show(lines):
            self.capture(lines,5,cols=80,rows=8)
            self.io.run.return_value=SimpleNamespace(returncode=0,stdout=('\n'.join(lines)+'\n').encode())
            return self.scope['modal_witness'](self.meta)
        for before,after in [
            (['','','','','Cline is asking a question','Choose one','> Yes','No'],
             ['','','','','Cline is asking a question','Choose one','Yes','> No']),
            (['Cline is asking a question','Proceed?','Yes','No','','> agreed|','context','footer'],
             ['Cline is asking a question','Proceed?','Yes','No','','> denied|','context','footer']),
        ]:
            witness=show(before)
            request=dict(executionId='run-test',processIdentity=dict(pid=1),inputType='tui-submit',
                         modalHash=witness['sha256'],sessionId='session',historyHash=hashlib.sha256(b'{}').hexdigest())
            self.assertIsNone(self.scope['input_binding'](None,self.meta,request,0))
            self.assertNotEqual(show(after)['sha256'],witness['sha256'])
            self.assertEqual(self.scope['input_binding'](None,self.meta,request,0),'terminal-modal-changed')

    def test_message_idle_uses_focused_row_and_keeps_modal_guard(self):
        self.scope.update(session_files=lambda meta: ('session', dict(status='idle', pid=1), 'history'),
                          identity=lambda pid: dict(pid=pid), session_owner=lambda *args: 1,
                          busy_children=lambda *args: [], modal_witness=lambda meta: None)
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run/'ownership.json').write_text('{}')
            for text, expected in (('Ask anything...', None), ('', None), ('draft', 'composer-not-empty')):
                self.pane(text=text, footer=self.fixture['footer'])
                self.assertEqual(self.scope['message_idle'](run, self.meta, empty=True), expected)
            self.scope['modal_witness'] = lambda meta: dict(sha256='modal')
            self.pane()
            self.assertEqual(self.scope['message_idle'](run, self.meta, empty=True), 'modal-active')

    def test_status_resynchronizes_current_size_and_resumed_idle_composer(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);run=root/'run-test';run.mkdir()
            self.meta.update(executionId='run-test',sessionId='session',bootId='boot')
            (run/'meta.json').write_text(json.dumps(self.meta))
            (run/'requests.json').write_text('{}')
            self.scope.update(os=Mock(),private=lambda value: root,boot_id=lambda: 'boot',
                              identity=lambda pid: dict(pid=pid),session_files=lambda meta: ('session',None,'history'),
                              read_history=lambda path: b'{}',modal_witness=lambda meta: None,
                              resume_owner=lambda meta: dict(pid=1),completed_resume_turn=lambda *args: True,
                              busy_children=lambda *args: [])
            self.pane(row=15,cols=80,rows=24)
            status=self.scope['handle'](dict(action='status',root=str(root),executionId='run-test',terminal=self.meta['terminal']))
            self.assertEqual(status['management']['terminal'],dict(cols=80,rows=24))
            self.assertEqual((status['screen']['cols'],status['screen']['rows']),(80,24))
            self.assertTrue(status['process']['composerIdle'])
            self.pane(row=15,text='draft',cols=80,rows=24)
            status=self.scope['handle'](dict(action='status',root=str(root),executionId='run-test',terminal=dict(cols=80,rows=24)))
            self.assertIsNone(status['screen'])
            self.assertFalse(status['process']['composerIdle'])

    def test_outer_resize_reaches_nested_cli_pty_with_bounded_dimensions(self):
        os_mock=Mock();ioctl=Mock();save=Mock()
        self.scope.update(os=os_mock,sys=Mock(),fcntl=SimpleNamespace(ioctl=ioctl),termios=SimpleNamespace(TIOCSWINSZ=1),struct=struct,save=save)
        os_mock.get_terminal_size.return_value=SimpleNamespace(columns=80,lines=24)
        self.scope['sync_terminal_size'](7,Path('run'),self.meta)
        ioctl.assert_called_once_with(7,1,struct.pack('HHHH',24,80,0,0))
        self.assertEqual(self.meta['terminal'],dict(rows=24,cols=80))
        self.scope['sync_terminal_size'](7,Path('run'),self.meta)
        os_mock.get_terminal_size.return_value=SimpleNamespace(columns=501,lines=24)
        self.scope['sync_terminal_size'](7,Path('run'),self.meta)
        self.assertEqual(ioctl.call_count,1)
        self.assertEqual(save.call_count,1)

    def test_start_passes_requested_size_to_tmux_and_saved_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);cli=root/'cline';cli.write_bytes(b'controlled')
            self.scope.update(os=Mock(),private=lambda value: root,working_directory=lambda value: root,
                              Path=Path,sys=SimpleNamespace(executable='python3'),shlex=shlex,boot_id=lambda: 'boot',
                              save=lambda path,value: path.write_text(json.dumps(value)))
            self.io.run.return_value=SimpleNamespace(returncode=0,stderr='')
            request=dict(action='start',root=str(root),cwd=str(root),executionId='run-test',terminal=dict(cols=80,rows=24),
                         cliPath=str(cli),cliHash=hashlib.sha256(b'controlled').hexdigest(),prompt='hello',
                         terminalMode='tui',sourceBase64='',ownershipSourceBase64='')
            result=self.scope['handle'](request)
            self.assertEqual(result['terminal'],request['terminal'])
            args=self.io.run.call_args.args[0]
            self.assertEqual(args[args.index('-x')+1],'80')
            self.assertEqual(args[args.index('-y')+1],'24')
            self.assertEqual(json.loads((root/'run-test'/'meta.json').read_text())['terminal'],request['terminal'])
            with self.assertRaisesRegex(ValueError,'Invalid terminal geometry'):
                self.scope['handle'](dict(request,executionId='run-invalid',terminal=dict(cols=10,rows=24)))
            self.assertFalse((root/'run-invalid').exists())


if __name__ == '__main__':
    unittest.main()
