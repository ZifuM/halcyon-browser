#!/usr/bin/env sh
# hx launcher (macOS / Linux / MozillaBuild shell on Windows)
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-$(command -v python3 || command -v python)}"
PYTHONPATH="$HERE/tools${PYTHONPATH:+:$PYTHONPATH}" exec "$PY" -m hx "$@"
