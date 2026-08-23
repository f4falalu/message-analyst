#!/usr/bin/env bash
#
# Prepare a Mac to serve this app's document reader over an ngrok tunnel.
#
# Run this ON THE MACHINE THAT WILL HOST THE MODEL, not on the machine where you
# open the app. The browser does the reading (see src/lib/local-read.ts), so it
# reaches across the network to whatever this script sets up here.
#
#   ./scripts/setup-local-model.sh                 # install + configure + pull the default model
#   ./scripts/setup-local-model.sh --dry-run       # report what it would do, change nothing
#   ./scripts/setup-local-model.sh qwen3-vl:4b     # pull a specific model instead
#   ./scripts/setup-local-model.sh qwen3-vl:2b glm-ocr   # pull several
#
# Every configuration step is idempotent: re-running is safe.

set -euo pipefail

DEFAULT_MODEL="qwen3-vl:2b"
OLLAMA_BIND="0.0.0.0:11434"
API="http://127.0.0.1:11434"

DRY_RUN=0
MODELS=()

for arg in "$@"; do
  case "$arg" in
    # Interactive zsh does not strip `#` comments, so a pasted command with a
    # trailing "# note" arrives here as arguments. Ignore everything from it on
    # rather than trying to `ollama pull look`.
    \#*) break ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) MODELS+=("$arg") ;;
  esac
done
[ ${#MODELS[@]} -eq 0 ] && MODELS=("$DEFAULT_MODEL")

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗  %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m  %s\n' "$1"; }
step() { printf '\n\033[1m→  %s\033[0m\n' "$1"; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '   \033[2mwould run:\033[0m %s\n' "$*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------- preflight --

bold "Local model host setup"

[ "$(uname -s)" = "Darwin" ] || fail "This script targets macOS. On Linux, set OLLAMA_HOST/OLLAMA_ORIGINS via systemctl instead."

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
# Ollama requires macOS Sonoma (14) or newer.
if [ "$MACOS_MAJOR" -lt 14 ]; then
  fail "Ollama needs macOS 14 (Sonoma) or newer. This machine is on $MACOS_VERSION."
fi
ok "macOS $MACOS_VERSION"

ARCH="$(uname -m)"
RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
CPU_BRAND="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"

if [ "$ARCH" = "x86_64" ]; then
  warn "Intel Mac: Ollama runs CPU-only here. There is no GPU acceleration path"
  warn "(Metal is Apple Silicon only; Vulkan is Windows/Linux only)."
  warn "Model size on disk is what governs speed. Prefer 2-4B models."
else
  ok "Apple Silicon: Metal GPU acceleration available."
fi
ok "$CPU_BRAND, ${RAM_GB} GB RAM"

# A vision model needs room for weights + KV cache + the image encoder, on top
# of whatever macOS is already using.
if [ "$RAM_GB" -lt 8 ]; then
  warn "Under 8 GB of RAM. Expect swapping even with a 2B model."
fi

# ------------------------------------------------------------ install step --

step "Ollama"

if command -v ollama >/dev/null 2>&1; then
  ok "already installed ($(ollama --version 2>/dev/null | head -1))"
elif [ -d /Applications/Ollama.app ]; then
  ok "Ollama.app present but the CLI is not on PATH; open the app once to have it linked."
else
  warn "Ollama is not installed."
  if command -v brew >/dev/null 2>&1; then
    run brew install --cask ollama
  else
    echo "   Homebrew is not available. Download it from https://ollama.com/download"
    echo "   then re-run this script."
    [ "$DRY_RUN" -eq 1 ] || exit 1
  fi
fi

# -------------------------------------------------------------- configure ---

step "Network and origin settings"

# The macOS GUI app does not inherit your shell environment, so these have to go
# through launchctl. Verified against Ollama's FAQ ("Setting environment
# variables on Mac"). They persist for the login session; a reboot clears them,
# so re-run this script after restarting the machine.
echo "   OLLAMA_HOST    = $OLLAMA_BIND   (bind beyond loopback so the tunnel can reach it)"
echo "   OLLAMA_ORIGINS = *              (let the app's browser tab call this machine)"
run launchctl setenv OLLAMA_HOST "$OLLAMA_BIND"
run launchctl setenv OLLAMA_ORIGINS "*"

if [ -d /Applications/Ollama.app ]; then
  step "Restarting Ollama so it picks the settings up"
  if run osascript -e 'quit app "Ollama"'; then
    run sleep 2
    run open -a Ollama
    run sleep 5
  else
    warn "Could not quit Ollama automatically (a dialog was dismissed, or it was"
    warn "not running). Quit it from the menu bar yourself and reopen it, then"
    warn "re-run this script — until it restarts, OLLAMA_ORIGINS is not in effect"
    warn "and the app's browser tab will still be refused with a 403."
  fi
else
  warn "No Ollama.app found. If you run 'ollama serve' by hand, start it as:"
  echo "     OLLAMA_HOST=$OLLAMA_BIND OLLAMA_ORIGINS='*' ollama serve"
fi

# Confirm the *running* server actually carries the origin policy, rather than
# trusting that the restart worked. A CORS preflight is the same question the
# browser asks, so a pass here means a pass there.
verify_origins() {
  local probe
  probe=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$API/v1/models" \
    -H 'Origin: https://example.lovable.app' \
    -H 'Access-Control-Request-Method: POST' 2>/dev/null || echo 000)
  case "$probe" in
    2*) ok "Origin policy is live (preflight answered $probe)" ;;
    000) warn "Could not run the origin check; is Ollama running?" ;;
    *)   warn "Ollama refused a browser origin (preflight $probe). It is still running"
         warn "with the old settings — quit it fully from the menu bar, reopen it," ;;
  esac
}


# ------------------------------------------------------------ wait for API --

step "Waiting for the API"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '   \033[2mwould poll\033[0m %s/api/tags\n' "$API"
else
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "$API/api/tags" >/dev/null 2>&1; then
      ok "responding on $API"
      break
    fi
    sleep 1
  done
  curl -fsS --max-time 2 "$API/api/tags" >/dev/null 2>&1 \
    || fail "Ollama did not come up on $API. Open the Ollama app manually and re-run."
  verify_origins
fi

# ------------------------------------------------------------------ models --

step "Models"

for model in "${MODELS[@]}"; do
  echo "   pulling $model ..."
  run ollama pull "$model"
done

# Confirm each model can actually see an image. Ollama reports this directly, so
# there is no need to guess from the name. A text-only model here would waste
# hours before producing nothing usable.
if [ "$DRY_RUN" -eq 0 ]; then
  step "Verifying vision capability"
  for model in "${MODELS[@]}"; do
    caps="$(curl -fsS --max-time 10 "$API/api/show" -d "{\"model\":\"$model\"}" 2>/dev/null || echo '')"
    if [ -z "$caps" ]; then
      warn "$model: could not read capabilities"
    elif printf '%s' "$caps" | grep -q '"vision"'; then
      ok "$model can read images"
    else
      warn "$model reports NO vision capability. This app cannot use it to read scans."
    fi
  done
fi

# ------------------------------------------------------------------ tunnel --

step "Tunnel"

if command -v ngrok >/dev/null 2>&1; then
  ok "ngrok installed"
else
  warn "ngrok is not installed."
  if command -v brew >/dev/null 2>&1; then
    echo "   Install with: brew install ngrok"
  else
    echo "   Download from https://ngrok.com/download"
  fi
  echo "   You will also need a free account and 'ngrok config add-authtoken <token>'."
fi

cat <<EOF

$(bold "Next steps")

1. Start the tunnel, and leave this terminal window open:

     ngrok http 11434 --host-header="localhost:11434"

   A free tunnel dies when the window closes, and gets a new URL each time.

2. Copy the https forwarding URL ngrok prints, e.g.
     https://something.ngrok-free.app

3. In the app, open the Models page and add a provider:
     Preset    Local / self-hosted (Ollama, vLLM, LM Studio)
     Base URL  https://something.ngrok-free.app/v1     <- keep the /v1
     Model     ${MODELS[0]}
     Runs on   this computer   (browser lane)

4. Press "Test connection". It checks two hops separately, so a failure tells
   you whether the tunnel or the origin policy is at fault.

5. Before committing to a full run, measure on your own documents:

     npm run benchmark -- --base-url https://something.ngrok-free.app/v1 \\
       --model ${MODELS[0]} --images ./sample-receipts

$(warn "launchctl settings are cleared by a reboot. Re-run this script after restarting.")
EOF
