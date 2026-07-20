#!/usr/bin/env bash
set -euo pipefail

# ocask v0.1 — OpenCode Analytical Scrutiny Kit
# One-command installer.

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.local/bin/ocask"
SKILL_DIR="$HOME/.claude/skills/ocask"
CMD_DIR="$HOME/.config/opencode/commands"

echo "ocask v0.1 — OpenCode Analytical Scrutiny Kit"
echo "============================================="
echo ""

# ── CLI binary ──
mkdir -p "$HOME/.local/bin"
echo "→ Installing CLI to $BIN"
chmod +x "$REPO_DIR/ocask.mjs"
ln -sf "$REPO_DIR/ocask.mjs" "$BIN"
echo "  ✓ ocask CLI ready"
# `eval/` contains dev-only evaluation harness assets. It is intentionally not copied
# during install so local users receive only the runtime CLI and command docs.

# ── Provider auth check ──
echo ""
echo "→ Checking provider auth..."
DS_OK=0; QW_OK=0; OC_OK=0

if [ -n "${DEEPSEEK_API_KEY:-}" ] || [ -f "$HOME/.deepseek-key" ]; then
  echo "  ✓ DeepSeek API: configured"
  DS_OK=1
else
  echo "  ⚠ DeepSeek API: not configured (set DEEPSEEK_API_KEY or create ~/.deepseek-key)"
fi

if [ -n "${QWEN_API_KEY:-}" ] || [ -f "$HOME/.qwen-key" ]; then
  echo "  ✓ Qwen API: configured"
  QW_OK=1
else
  echo "  ⚠ Qwen API: not configured (set QWEN_API_KEY or create ~/.qwen-key)"
fi

if command -v opencode &>/dev/null; then
  echo "  ✓ OpenCode CLI: found on PATH"
  OC_OK=1
else
  echo "  ⚠ OpenCode CLI: not found (install from https://opencode.ai)"
fi

if [ "$DS_OK" -eq 0 ] && [ "$QW_OK" -eq 0 ] && [ "$OC_OK" -eq 0 ]; then
  echo ""
  echo "  No providers configured. Set up at least one:"
  echo "    - DeepSeek: export DEEPSEEK_API_KEY=<key>"
  echo "    - Qwen:     export QWEN_API_KEY=<key>"
  echo "    - OpenCode: opencode providers login"
  echo ""
  echo "  For Qwen via OpenCode: get a key from https://home.qwencloud.com/api-keys"
  echo "  then run: opencode providers login alibaba"
fi

# ── Claude Code skill ──
echo ""
echo "→ Installing Claude Code skill to $SKILL_DIR"
mkdir -p "$SKILL_DIR"
cp "$REPO_DIR/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
echo "  ✓ /ocask command available in Claude Code"

# ── OpenCode slash command ──
echo ""
echo "→ Installing OpenCode slash command to $CMD_DIR"
mkdir -p "$CMD_DIR"
cp "$REPO_DIR/commands/ocask.md" "$CMD_DIR/ocask.md"
echo "  ✓ ocask slash command registered"

# ── Verify ──
echo ""
echo "→ Verifying installation..."
if "$BIN" help &>/dev/null; then
  echo "  ✓ ocask CLI responds"
else
  echo "  ⚠ ocask CLI check failed (may need Node.js ≥ 20)"
fi

echo ""
echo "Done. Try:  ocask help"
