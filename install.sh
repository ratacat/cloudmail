#!/usr/bin/env bash
# cloudmail installer.
#   Install:   curl -fsSL https://raw.githubusercontent.com/ratacat/cloudmail/main/install.sh | bash
#   Uninstall: curl -fsSL https://raw.githubusercontent.com/ratacat/cloudmail/main/install.sh | bash -s -- --uninstall
set -euo pipefail

REPO="https://github.com/ratacat/cloudmail.git"
SRC_DIR="${CLOUDMAIL_SRC:-$HOME/.local/share/cloudmail}"
BIN_DIR="${CLOUDMAIL_BIN:-$HOME/.local/bin}"
BIN="$BIN_DIR/cloudmail"

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }

uninstall() {
  rm -f "$BIN"
  rm -rf "$SRC_DIR"
  grn "cloudmail uninstalled (removed $BIN and $SRC_DIR)."
  echo "Profiles in ~/.cloudmail were left untouched. Remove with: rm -rf ~/.cloudmail"
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

command -v bun >/dev/null 2>&1 || { red "bun is required. Install it: https://bun.sh"; exit 1; }
command -v git >/dev/null 2>&1 || { red "git is required."; exit 1; }

# Fetch or update the source.
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" pull --ff-only --quiet
else
  rm -rf "$SRC_DIR"
  git clone --depth 1 --quiet "$REPO" "$SRC_DIR"
fi

# The CLI itself has no external runtime dependencies (Node built-ins only),
# so no `bun install` is needed to run it. Worker deploy/dev deps are installed
# separately with `bun install` inside the repo when you work on the worker.

# Install a tiny launcher on PATH.
mkdir -p "$BIN_DIR"
cat > "$BIN" <<EOF
#!/usr/bin/env bash
exec bun run "$SRC_DIR/bin/cloudmail.ts" "\$@"
EOF
chmod +x "$BIN"

grn "cloudmail installed -> $BIN"
case ":$PATH:" in
  *":$BIN_DIR:"*) cloudmail --version >/dev/null 2>&1 || true ;;
  *) echo "Add $BIN_DIR to your PATH:"; echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "Next: cloudmail   (run with no args for help)"
