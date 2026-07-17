#!/usr/bin/env bash
# ocask sync check — verifies all linked artifacts are consistent.
# Run before commit to ensure docs, skill, commands, and code agree.
# Exits 1 with details on any mismatch.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0

fail() { FAIL=$((FAIL + 1)); echo "  ✗ $*"; }
pass() { PASS=$((PASS + 1)); echo "  ✓ $*"; }

file_ok()  { [ -f "$1" ] && pass "$2 ($1)" || fail "$2 ($1) missing"; }
text_ok()  { grep -qF -- "$2" "$3" 2>/dev/null && pass "$1" || fail "$1 — '$2' not in $3"; }
regex_ok() { grep -qE -- "$2" "$3" 2>/dev/null && pass "$1" || fail "$1 — '$2' not found"; }

section() { echo ""; echo "$1"; echo "$(printf '%.0s─' $(seq 1 ${#1}))"; }

# ── Core files ──
section "Core files"
for f in ocask.mjs logging.mjs pricing.mjs ocverify.mjs README.md \
         ARCHITECTURE.md install.sh skill/SKILL.md commands/ocask.md \
         providers/factory.mjs providers/deepseek.mjs \
         providers/qwen.mjs providers/opencode.mjs; do
  file_ok "$REPO/$f" "$f"
done

# ── Version ──
section "Version (v0.1)"
text_ok "README"         "v0.1" "$REPO/README.md"
regex_ok "Architecture"  "ocask Architecture" "$REPO/ARCHITECTURE.md"
text_ok "Skill"          "v0.1" "$REPO/skill/SKILL.md"
text_ok "CLI"            "v0.1" "$REPO/ocask.mjs"
text_ok "Installer"      "v0.1" "$REPO/install.sh"

# ── Lenses ──
section "Review lenses"
for lens in code-review architecture security tdd maintainability deep-modules general; do
  text_ok "ocask.mjs: $lens"   "$lens" "$REPO/ocask.mjs"
  text_ok "ARCHITECTURE.md: $lens" "$lens" "$REPO/ARCHITECTURE.md"
  text_ok "README.md: $lens"     "$lens" "$REPO/README.md"
  text_ok "skill: $lens"         "$lens" "$REPO/skill/SKILL.md"
done
regex_ok "VALID_LENSES from LENS_FRAMEWORKS" \
  "VALID_LENSES.*Object\.keys\(LENS_FRAMEWORKS\)" "$REPO/ocask.mjs"

# ── Providers ──
section "Providers"
for p in deepseek qwen opencode; do
  text_ok "factory.mjs: $p"       "$p" "$REPO/providers/factory.mjs"
  text_ok "README.md: $p"         "$p" "$REPO/README.md"
  text_ok "ARCHITECTURE.md: $p"   "$p" "$REPO/ARCHITECTURE.md"
done

# ── Subcommands ──
section "Subcommands"
for cmd in doctor diagnose cost pricing help; do
  text_ok "ocask.mjs: $cmd"  "$cmd" "$REPO/ocask.mjs"
  text_ok "README.md: $cmd"  "$cmd" "$REPO/README.md"
done
text_ok "skill: doctor"   "doctor"   "$REPO/skill/SKILL.md"
text_ok "skill: cost"     "cost"     "$REPO/skill/SKILL.md"
text_ok "skill: pricing"  "pricing"  "$REPO/skill/SKILL.md"

# ── Architecture integrity ──
section "Architecture integrity"
text_ok "imports logging"    "from './logging.mjs'" "$REPO/ocask.mjs"
text_ok "imports pricing"    "from './pricing.mjs'" "$REPO/ocask.mjs"
for f in providers/deepseek.mjs providers/qwen.mjs providers/opencode.mjs; do
  text_ok "$f: exports invoke" "export async function invoke" "$REPO/$f"
done
text_ok "factory loads deepseek"  "./deepseek.mjs"  "$REPO/providers/factory.mjs"
text_ok "factory loads qwen"      "./qwen.mjs"      "$REPO/providers/factory.mjs"
text_ok "factory loads opencode"  "./opencode.mjs"  "$REPO/providers/factory.mjs"
text_ok "deepseek returns tokensUsed"  "tokensUsed"  "$REPO/providers/deepseek.mjs"
text_ok "qwen returns tokensUsed"      "tokensUsed"  "$REPO/providers/qwen.mjs"
text_ok "qwen prefix = alibaba"        "alibaba"     "$REPO/providers/opencode.mjs"
text_ok "USAGE has --provider"         "--provider"  "$REPO/ocask.mjs"
text_ok "USAGE has --lens"             "--lens"      "$REPO/ocask.mjs"

# ── Installer coverage ──
section "Installer coverage"
text_ok "installs skill"   "skill/SKILL.md"    "$REPO/install.sh"
text_ok "installs command" "commands/ocask.md" "$REPO/install.sh"
text_ok "installs CLI"     "ocask.mjs"         "$REPO/install.sh"

# ── Local symlinks (best-effort) ──
section "Local symlinks"
if command -v ocask &>/dev/null && [ "$(readlink -f "$(which ocask)")" = "$REPO/ocask.mjs" ]; then
  pass "ocask resolves to repo"
else
  fail "ocask does not resolve to $REPO/ocask.mjs (run ./install.sh)"
fi
if [ -f "$HOME/.claude/skills/ocask/SKILL.md" ]; then
  diff -q "$HOME/.claude/skills/ocask/SKILL.md" "$REPO/skill/SKILL.md" &>/dev/null && \
    pass "skill matches repo" || \
    fail "skill out of sync (run ./install.sh)"
else
  fail "skill not installed (run ./install.sh)"
fi
if [ -f "$HOME/.config/opencode/commands/ocask.md" ]; then
  diff -q "$HOME/.config/opencode/commands/ocask.md" "$REPO/commands/ocask.md" &>/dev/null && \
    pass "command matches repo" || \
    fail "command out of sync (run ./install.sh)"
else
  fail "command not installed (run ./install.sh)"
fi

# ── Summary ──
echo ""
echo "──────────────────────────────────────────"
echo "Sync check: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Fix failures above, then: ./install.sh && ./check.sh"
  exit 1
fi
echo "All artifacts in sync."
