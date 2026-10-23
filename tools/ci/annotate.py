"""Run a command; if it fails, surface the tail of its output as a GitHub Actions error annotation.

Annotations are readable through the Checks API even where raw logs aren't, and show up at the top
of the run page. Output is still streamed to the log as usual.

    python3 tools/ci/annotate.py "Build" -- ./hx build --profile dev
    python3 tools/ci/annotate.py --timeout 2400 "Bootstrap" -- ./hx bootstrap

--timeout SECONDS stops a stuck command itself and still reports its last output (a GitHub step
timeout would kill it silently).
"""

from __future__ import annotations

import collections
import os
import signal
import subprocess
import sys
import threading

TAIL_LINES = 80
MAX_CHARS = 60000  # GitHub caps annotation messages at 64 KB


def escape(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main(argv: list[str]) -> int:
    if "--" not in argv or argv.index("--") == 0:
        print("usage: annotate.py TITLE -- command...", file=sys.stderr)
        return 2
    head = argv[: argv.index("--")]
    timeout = None
    if head[:1] == ["--timeout"]:
        timeout = float(head[1])
        head = head[2:]
    title = " ".join(head)
    cmd = argv[argv.index("--") + 1:]
    tail: collections.deque[str] = collections.deque(maxlen=TAIL_LINES)
    # Own process group/tree, so a timeout can stop grandchildren that hold the output pipe open.
    group = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            errors="replace", bufsize=1, **group)
    assert proc.stdout is not None
    timed_out = threading.Event()
    if timeout:
        def stop():
            timed_out.set()
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
            else:
                os.killpg(proc.pid, signal.SIGKILL)
        timer = threading.Timer(timeout, stop)
        timer.daemon = True
        timer.start()
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        tail.append(line.rstrip("\n"))
    code = proc.wait()
    if timed_out.is_set():
        code = 124
        reason = f"timed out after {timeout:.0f} s (last output below)"
    else:
        reason = f"exit {code}"
    if code != 0:
        body = "\n".join(tail)[-MAX_CHARS:]
        print(f"::error title={escape(title)} failed ({escape(reason)})::{escape(body)}", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
