"""Run a command; if it fails, surface the tail of its output as a GitHub Actions error annotation.

Annotations are readable through the Checks API even where raw logs aren't, and show up at the top
of the run page. Output is still streamed to the log as usual.

    python3 tools/ci/annotate.py "Build" -- ./hx build --profile dev
"""

from __future__ import annotations

import collections
import subprocess
import sys

TAIL_LINES = 80
MAX_CHARS = 60000  # GitHub caps annotation messages at 64 KB


def escape(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main(argv: list[str]) -> int:
    if "--" not in argv or argv.index("--") == 0:
        print("usage: annotate.py TITLE -- command...", file=sys.stderr)
        return 2
    title = " ".join(argv[: argv.index("--")])
    cmd = argv[argv.index("--") + 1:]
    tail: collections.deque[str] = collections.deque(maxlen=TAIL_LINES)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            errors="replace", bufsize=1)
    assert proc.stdout is not None
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        tail.append(line.rstrip("\n"))
    code = proc.wait()
    if code != 0:
        body = "\n".join(tail)[-MAX_CHARS:]
        print(f"::error title={escape(title)} failed (exit {code})::{escape(body)}", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
