#!/usr/bin/env python3
"""Linux-only observation helper, not the SDK or a general remote supervisor.

Runs an explicitly supplied CLI in a PTY and records byte frames and snapshots
under an isolated observation root. It never reads CLI credentials/config.
"""

import argparse
import base64
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import sys
import termios
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("run_id")
    parser.add_argument("--seconds", type=int, default=240)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--input-base64")
    parser.add_argument("--command-json")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if not root.name.startswith("cline-sdk-observe-"):
        parser.error("An isolated cline-sdk-observe-* root is required")
    if not args.run_id.replace("-", "").replace("_", "").isalnum():
        parser.error("run_id must contain only letters, digits, '-' and '_'")
    run = root / "logs" / args.run_id
    fifo = run / "input.fifo"
    if args.input_base64 is not None:
        value = base64.b64decode(args.input_base64, validate=True)
        fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
        try:
            if os.write(fd, value) != len(value):
                raise RuntimeError("Incomplete input write")
        finally:
            os.close(fd)
        print(json.dumps({"input_bytes": len(value), "run_id": args.run_id}))
        return
    if not args.command_json:
        parser.error("--command-json is required to start a run")
    command = json.loads(args.command_json)
    if not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command):
        parser.error("command must be an argv array")
    data_dir = (args.data_dir or root / "data").resolve(strict=True)
    if not data_dir.is_relative_to(root):
        parser.error("data-dir must be inside the isolated observation root")
    run.mkdir(parents=True, exist_ok=False)
    os.mkfifo(fifo, 0o600)
    fifo_fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
    frames = (run / "frames.ndjson").open("w", encoding="utf-8")
    os.chmod(run / "frames.ndjson", 0o600)
    started = time.monotonic_ns()
    sequence = 0
    previous = {}

    def event(kind, **fields):
        nonlocal sequence
        sequence += 1
        frames.write(json.dumps({"seq": sequence, "elapsed_ns": time.monotonic_ns() - started,
                                 "kind": kind, **fields}, ensure_ascii=False) + "\n")
        frames.flush()

    def snapshot():
        # Only isolated conversation files, never config, credentials, or real tasks.
        paths = set(data_dir.glob("tasks/*/ui_messages.json"))
        paths.update(data_dir.glob("tasks/*/api_conversation_history.json"))
        paths.update(data_dir.glob("tasks/*/task_metadata.json"))
        paths.update(data_dir.glob("sessions/*/*.json"))
        for path in sorted(paths):
            relative = str(path.relative_to(data_dir))
            try:
                payload = path.read_bytes()
                digest = hashlib.sha256(payload).hexdigest()
                if previous.get(relative) == digest:
                    continue
                previous[relative] = digest
                try:
                    json.loads(payload)
                    complete_json = True
                except (ValueError, UnicodeError):
                    complete_json = False
                event("file_snapshot", path=relative, sha256=digest,
                      complete_json=complete_json, data_b64=base64.b64encode(payload).decode())
            except OSError as exc:
                event("file_read_error", path=relative, error=type(exc).__name__)

    event("start", argv=command, cwd=str(root / "workspace"), data_dir=str(data_dir),
          terminal={"rows": 40, "cols": 120, "term": "xterm-256color"})
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(root / "workspace")
        os.environ["TERM"] = "xterm-256color"
        os.environ["NO_COLOR"] = "1"
        os.execvp(command[0], command)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    event("child", pid=pid)
    deadline = time.monotonic() + args.seconds
    status = None
    timed_out = False
    try:
        while True:
            if time.monotonic() >= deadline:
                timed_out = True
                event("observation_deadline")
                os.killpg(pid, signal.SIGTERM)
                break
            readable, _, _ = select.select([master, fifo_fd], [], [], 0.15)
            if fifo_fd in readable:
                payload = os.read(fifo_fd, 4096)
                if payload:
                    # Observation inputs are small; record only after a complete write.
                    offset = 0
                    while offset < len(payload):
                        offset += os.write(master, payload[offset:])
                    event("input", data_b64=base64.b64encode(payload).decode())
            if master in readable:
                try:
                    payload = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    payload = b""
                if payload:
                    event("output", data_b64=base64.b64encode(payload).decode())
                    sys.stdout.buffer.write(payload)
                    sys.stdout.buffer.flush()
                else:
                    _, status = os.waitpid(pid, 0)
                    break
            snapshot()
        if status is None:
            for _ in range(20):
                ended, status_result = os.waitpid(pid, os.WNOHANG)
                if ended:
                    status = status_result
                    break
                time.sleep(0.1)
            if status is None:
                os.killpg(pid, signal.SIGKILL)
                _, status = os.waitpid(pid, 0)
        snapshot()
        event("exit", exit_code=os.waitstatus_to_exitcode(status), timed_out=timed_out)
    finally:
        os.close(master)
        os.close(fifo_fd)
        frames.close()


if __name__ == "__main__":
    main()
