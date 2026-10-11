#!/usr/bin/env python3
"""Run bounded synthetic observation scenarios against a pinned Linux CLI."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import time


ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("case", choices=["approve", "deny", "numeric", "cancel"])
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    name = args.case + "-live"
    run = root / "logs" / name
    if args.case == "numeric":
        prompt = ("Call ask_question with question 'Enter an identifier' and exactly the options RED and BLUE. "
                  "Wait for the human. After the answer reply exactly IDENTIFIER:<answer> and finish. "
                  "Use no other tool.")
    elif args.case == "cancel":
        prompt = ("Controlled cancellation test. Call run_commands exactly once with this shell command: "
                  "python3 -c 'import os,time,pathlib; pathlib.Path(\"cancel-child.pid\").write_text(str(os.getpid())); "
                  "print(\"CANCEL_RUNNING\",flush=True); time.sleep(90); print(\"UNEXPECTED_FINISH\")'. "
                  "Use the current working directory. Do not use any other tool, retry, or delegate.")
    else:
        prompt = ("Controlled approval test. Call run_commands exactly once with shell command "
                  "'printf APPROVAL_PROBE' in the current working directory. Wait for human approval. "
                  "If denied, do not retry or use another tool and reply DENIED. "
                  "If allowed, report APPROVED:<the command output> and finish. Do not delegate.")
    command = [str(root / "cline-3.0.69"), "--data-dir", str(root / "data"),
               "--cwd", str(root / "workspace"), "--auto-approve", "false",
               "--timeout", "150", "--retries", "1", prompt]
    runner = ["env", "CLINE_NO_AUTO_UPDATE=1", "python3", str(root / "remote_probe.py"),
              str(root), name, "--seconds", "180", "--command-json", json.dumps(command)]
    subprocess.run(["tmux", "-L", "cline-sdk-observe", "new-session", "-d", "-s", name, *runner], check=True)

    def read():
        path = run / "frames.ndjson"
        if not path.exists():
            return [], ""
        # A reader can observe the recorder mid-line; retry incomplete tail.
        rows = []
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                break
        text = b"".join(base64.b64decode(e["data_b64"]) for e in rows if e["kind"] == "output").decode(errors="replace")
        return rows, ANSI.sub("", text)

    def wait(predicate, seconds=45):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            rows, output = read()
            if predicate(rows, output):
                return rows, output
            if rows and rows[-1]["kind"] == "exit":
                raise RuntimeError("Unexpected early exit: " + output[-3000:])
            time.sleep(0.15)
        raise TimeoutError("Observation condition not reached: " + read()[1][-3000:])

    def send(value):
        fd = os.open(run / "input.fifo", os.O_WRONLY | os.O_NONBLOCK)
        try:
            assert os.write(fd, value) == len(value)
        finally:
            os.close(fd)

    tool = "ask_question" if args.case == "numeric" else "run_commands"
    wait(lambda rows, out: f'Approve "{tool}"' in out)
    send(b"n\r" if args.case == "deny" else b"y\r")
    extra = {}
    if args.case == "deny":
        rows, output = wait(lambda rows, out: (bool(rows) and rows[-1]["kind"] == "exit")
                            or ("mistake_limit_reached" in out and "Stop this run" in out))
        if not rows or rows[-1]["kind"] != "exit":
            extra["additional_prompt"] = "mistake_limit_reached"
            send(b"2\r")
    elif args.case == "numeric":
        wait(lambda rows, out: "Choose 1-2 or type a custom answer:" in out)
        send(b"2 custom identifier\r")
    elif args.case == "cancel":
        marker = root / "workspace" / "cancel-child.pid"
        wait(lambda rows, out: marker.exists())
        extra["tool_child_pid"] = int(marker.read_text())
        extra["cancel_sent_at_ns"] = time.time_ns()
        send(b"\x03")
    rows, output = wait(lambda rows, out: bool(rows) and rows[-1]["kind"] == "exit", seconds=65)
    if "tool_child_pid" in extra:
        try:
            os.kill(extra["tool_child_pid"], 0)
            extra["tool_child_alive_after_cli_exit"] = True
        except ProcessLookupError:
            extra["tool_child_alive_after_cli_exit"] = False
    result = {"case": args.case, "last_event": rows[-1], "output": output, **extra}
    (run / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
