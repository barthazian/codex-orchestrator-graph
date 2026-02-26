#!/bin/bash
# codex-orchestrator-graph — Skill Graph Installer
# Installs all pipeline skills and agents into ~/.claude/
# Cross-platform: macOS, Linux, Windows (MINGW/Git Bash)
#
# Usage:
#   bash plugins/codex-orchestrator/scripts/install.sh           # skip existing
#   bash plugins/codex-orchestrator/scripts/install.sh --update  # overwrite existing

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-${HOME}/.claude}"
UPDATE=0

for arg in "$@"; do
  [[ "$arg" == "--update" ]] && UPDATE=1
done

info()    { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[ok]${NC} $1"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $1"; }
error()   { echo -e "${RED}[error]${NC} $1"; }

# -------------------------------------------------------------------
# Platform detection
# -------------------------------------------------------------------
detect_platform() {
  case "$(uname -s)" in
    Linux*)            PLATFORM="linux" ;;
    Darwin*)           PLATFORM="macos" ;;
    CYGWIN*|MINGW*|MSYS*) PLATFORM="windows" ;;
    *)
      error "Unsupported platform: $(uname -s)"
      exit 1
      ;;
  esac
  info "Platform: $PLATFORM ($(uname -m))"
}

# -------------------------------------------------------------------
# Detect Linux package manager
# -------------------------------------------------------------------
detect_linux_pkg_manager() {
  if   command -v apt-get &>/dev/null; then PKG_MANAGER="apt"
  elif command -v dnf     &>/dev/null; then PKG_MANAGER="dnf"
  elif command -v yum     &>/dev/null; then PKG_MANAGER="yum"
  elif command -v pacman  &>/dev/null; then PKG_MANAGER="pacman"
  elif command -v apk     &>/dev/null; then PKG_MANAGER="apk"
  elif command -v zypper  &>/dev/null; then PKG_MANAGER="zypper"
  else PKG_MANAGER=""
  fi
}

# -------------------------------------------------------------------
# Check prerequisites
# -------------------------------------------------------------------
check_bun() {
  if command -v bun &>/dev/null; then
    success "bun: $(bun --version)"
    return 0
  fi
  warn "Bun not found. Installing via official installer..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if command -v bun &>/dev/null; then
    success "bun installed: $(bun --version)"
  else
    error "Bun installation failed. Install manually: https://bun.sh"
    exit 1
  fi
}

check_sqlite() {
  if command -v sqlite3 &>/dev/null; then
    success "sqlite3: $(sqlite3 --version | cut -d' ' -f1)"
    return 0
  fi
  warn "sqlite3 not found. Installing..."
  if [ "$PLATFORM" = "macos" ]; then
    command -v brew &>/dev/null && brew install sqlite || \
      warn "Homebrew not found. Install sqlite3 manually."
  elif [ "$PLATFORM" = "linux" ]; then
    detect_linux_pkg_manager
    case "$PKG_MANAGER" in
      apt)    sudo apt-get update && sudo apt-get install -y sqlite3 ;;
      dnf)    sudo dnf install -y sqlite ;;
      yum)    sudo yum install -y sqlite ;;
      pacman) sudo pacman -S --noconfirm sqlite ;;
      apk)    sudo apk add sqlite ;;
      zypper) sudo zypper install -y sqlite3 ;;
      *)      error "Install sqlite3 manually: https://www.sqlite.org/download.html"; return 1 ;;
    esac
  elif [ "$PLATFORM" = "windows" ]; then
    command -v winget &>/dev/null && \
      winget install SQLite.SQLite --accept-package-agreements --accept-source-agreements || \
      warn "Install sqlite3 manually: https://www.sqlite.org/download.html"
  fi
  command -v sqlite3 &>/dev/null && \
    success "sqlite3 installed: $(sqlite3 --version | cut -d' ' -f1)" || \
    warn "sqlite3 may require a shell restart to appear on PATH."
}

check_codex() {
  if command -v codex &>/dev/null; then
    success "codex CLI: found"
    return 0
  fi
  warn "OpenAI Codex CLI not found."
  echo ""
  echo "The Codex CLI is the coding agent that codex-orchestrator controls."
  echo "Install it with npm:"
  echo "  npm install -g @openai/codex"
  echo ""
  echo "Then authenticate:"
  echo "  codex --login"
  echo ""
  read -p "Install now with npm? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    if command -v npm &>/dev/null; then
      npm install -g @openai/codex
      command -v codex &>/dev/null && \
        success "codex CLI installed" || \
        { error "Codex CLI installation failed."; exit 1; }
      warn "Still need to authenticate: codex --login"
    else
      error "npm not found. Install Node.js first: https://nodejs.org"
      exit 1
    fi
  else
    warn "Skipping Codex CLI install. Required before using the pipeline."
  fi
}

# -------------------------------------------------------------------
# Install skills and agents into ~/.claude/
# -------------------------------------------------------------------
install_file() {
  local src="$1"
  local dest="$2"
  local label="$3"
  mkdir -p "$(dirname "${dest}")"
  if [[ -f "${dest}" && "${UPDATE}" -eq 0 ]]; then
    echo -e "  ${YELLOW}~${NC} skip (exists): ${label}  — pass --update to overwrite"
  else
    cp "${src}" "${dest}"
    echo -e "  ${GREEN}✓${NC} installed:     ${label}"
  fi
}

install_skills() {
  info "Installing skills to ${CLAUDE_DIR}/skills/"
  for skill_dir in "${PLUGIN_DIR}/skills"/*/; do
    skill_name=$(basename "${skill_dir}")
    dest_dir="${CLAUDE_DIR}/skills/${skill_name}"
    mkdir -p "${dest_dir}"
    install_file "${skill_dir}/SKILL.md" "${dest_dir}/SKILL.md" "${skill_name}"
  done

  echo ""
  info "Installing agents to ${CLAUDE_DIR}/agents/"
  install_file \
    "${PLUGIN_DIR}/agents/codex-reviewer.md" \
    "${CLAUDE_DIR}/agents/codex-reviewer.md" \
    "codex-reviewer"
}

# -------------------------------------------------------------------
# Verify
# -------------------------------------------------------------------
verify() {
  echo ""
  info "Verifying install..."
  echo ""

  local all_ok=1
  for skill in codex-orchestrator codex-implement codex-research codex-prd codex-test; do
    if [[ -f "${CLAUDE_DIR}/skills/${skill}/SKILL.md" ]]; then
      echo -e "  ${GREEN}✓${NC} ${skill}"
    else
      echo -e "  ${RED}✗${NC} ${skill} — missing"
      all_ok=0
    fi
  done

  if [[ -f "${CLAUDE_DIR}/agents/codex-reviewer.md" ]]; then
    echo -e "  ${GREEN}✓${NC} codex-reviewer (agent)"
  else
    echo -e "  ${RED}✗${NC} codex-reviewer — missing"
    all_ok=0
  fi

  echo ""
  if [[ "$all_ok" -eq 1 ]]; then
    success "All skills and agents installed."
  else
    error "Some files are missing. Re-run with --update."
    exit 1
  fi

  echo ""
  echo "Next steps:"
  if ! command -v codex &>/dev/null; then
    echo "  1. Install Codex CLI:  npm install -g @openai/codex"
    echo "  2. Authenticate:       codex --login"
    echo "  3. Reload Claude Code and use /codex-orchestrator to start"
  else
    echo "  1. Reload Claude Code"
    echo "  2. Use /codex-orchestrator to start a pipeline"
  fi
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------
main() {
  echo ""
  echo "========================================="
  echo "  codex-orchestrator-graph — Installer"
  echo "========================================="
  echo ""

  detect_platform
  echo ""

  check_bun
  check_sqlite
  check_codex

  echo ""
  install_skills

  verify
}

main "$@"
