#!/usr/bin/env bash
# Local add-on lint, equivalent to frenck/action-addon-linter (CI is not set up
# for this repository yet; see goals/lock-user-manager/progress.md).
#
# Fetches the official linter source from GitHub and runs it with Python.
# Requires: python3 with venv, network access to github.com.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -sL -o "$WORK/linter.tgz" https://github.com/frenck/action-addon-linter/archive/refs/heads/main.tar.gz
mkdir -p "$WORK/extract"
tar xzf "$WORK/linter.tgz" -C "$WORK/extract"
SRC_DIR="$(find "$WORK/extract" -name lint.py -exec dirname {} \;)"

python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q jsonschema pyyaml
sed \
  -e 's|"/config.schema.json"|__import__("os").path.join(__import__("os").path.dirname(__file__), "config.schema.json")|' \
  -e 's|"/build.schema.json"|__import__("os").path.join(__import__("os").path.dirname(__file__), "build.schema.json")|' \
  "$SRC_DIR/lint.py" > "$SRC_DIR/lint-local.py"

INPUT_PATH="$REPO_ROOT/lock-manager" INPUT_COMMUNITY=false "$WORK/venv/bin/python" "$SRC_DIR/lint-local.py"
echo "Add-on lint: OK"
"$WORK/venv/bin/python" - "$REPO_ROOT/repository.yaml" <<'EOF'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
assert set(d) == {"name", "url", "maintainer"}, d
print("Repository lint: OK", d)
EOF