#!/bin/bash
# iMassage one-time Mac setup. Run in Terminal on the Mac, with the PC's public key:
#
#   curl -fsSL https://raw.githubusercontent.com/DeltaPlusProtoTyping/iMassage/main/mac-setup.sh | bash -s -- "ssh-ed25519 AAAA... you@pc"
#
# (install.ps1 on the PC prints this line with your key filled in.) Asks for your Mac password once.
# Safe to run again. What it does:
#   1. installs Apple's Command Line Tools if missing (the agent runs on their Python 3)
#   2. turns on Remote Login (SSH) and authorizes the PC's key
#   3. keeps the Mac awake on power (the display can still sleep)
#   4. opens Messages, then walks you through the three Privacy switches macOS only lets you flip by hand
set -euo pipefail

KEY="${1:-}"
WRAPPER=/usr/libexec/sshd-keygen-wrapper
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
ask() { printf '  → %s ' "$*"; read -r _ </dev/tty; }

if [[ -z "$KEY" || "$KEY" != ssh-* ]]; then
  echo "Usage: bash mac-setup.sh \"<the PC's public key, starting with ssh-ed25519>\"" >&2
  echo "On the PC: type \$env:USERPROFILE\\.ssh\\id_ed25519.pub" >&2
  exit 1
fi

bold "iMassage Mac setup"
echo "  Your Mac password is needed once (Remote Login and power settings)."
sudo -v </dev/tty
# keep sudo alive for the rest of the script
while true; do sudo -n true; sleep 50; kill -0 "$$" 2>/dev/null || exit; done 2>/dev/null &

bold "1/4  Command Line Tools (Python 3)"
if xcode-select -p >/dev/null 2>&1 && /usr/bin/python3 -c 'import sys' 2>/dev/null; then
  ok "installed ($(/usr/bin/python3 --version))"
else
  xcode-select --install 2>/dev/null || true
  ask "Click Install in the window that opened, wait for it to finish, then press Enter."
  /usr/bin/python3 -c 'import sys' && ok "installed"
fi

bold "2/4  Remote Login + the PC's key"
if (echo >/dev/tcp/127.0.0.1/22) 2>/dev/null; then
  ok "Remote Login already on"
else
  sudo systemsetup -f -setremotelogin on >/dev/null 2>&1 || sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
  sleep 2
  if (echo >/dev/tcp/127.0.0.1/22) 2>/dev/null; then ok "Remote Login on"
  else
    open "x-apple.systempreferences:com.apple.Sharing-Settings.extension"
    ask "Turn on Remote Login in the Sharing settings that opened, then press Enter."
  fi
fi
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
if grep -qxF "$KEY" ~/.ssh/authorized_keys; then ok "PC key already authorized"
else echo "$KEY" >>~/.ssh/authorized_keys; ok "PC key authorized"; fi

bold "3/4  Stay awake"
sudo pmset -c sleep 0 >/dev/null && ok "Mac won't sleep while plugged in (display still can)"

bold "4/4  Messages + privacy switches"
open -a Messages
ok "Messages is open (sign in to iMessage there if you haven't)"
printf '%s' "$WRAPPER" | pbcopy
echo "  For each one: click +, press Cmd+Shift+G, press Cmd+V (the path is on your clipboard:"
echo "  $WRAPPER), press Return, click Open, and make sure its switch is ON."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
ask "Full Disk Access: add sshd-keygen-wrapper. Press Enter when done."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
ask "Accessibility: add sshd-keygen-wrapper. Press Enter when done."

# Automation can't be added by hand; macOS asks the first time an SSH session controls an app.
# Trigger those questions now through a throwaway key to this Mac, so they show up while you're here.
echo "  Two questions are about to pop up (sshd-keygen-wrapper wants to control Messages / System Events)."
echo "  Click OK / Allow on both."
TMP=$(mktemp -d)
ssh-keygen -q -t ed25519 -N "" -f "$TMP/k" -C imassage-setup
cat "$TMP/k.pub" >>~/.ssh/authorized_keys
cleanup() { grep -vF "imassage-setup" ~/.ssh/authorized_keys >"$TMP/a" || true; cat "$TMP/a" >~/.ssh/authorized_keys; rm -rf "$TMP"; }
trap cleanup EXIT
SSHL=(ssh -i "$TMP/k" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$USER@localhost")
# check <label> <AppleScript> <expected output, or empty for "any">
check() {
  local out
  for attempt in 1 2; do
    out=$("${SSHL[@]}" "osascript -e 'with timeout of 60 seconds' -e '$2' -e 'end timeout'" 2>/dev/null) && [[ -z "$3" || "$out" == "$3" ]] && { ok "$1"; return; }
    [[ $attempt == 2 ]] && break
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_${4:-Automation}"
    ask "Not allowed yet: in the settings that opened, turn on sshd-keygen-wrapper > ${5:-$1}. Press Enter to retry."
  done
  echo "  ✗ $1: still not working. You can fix it later; iMassage's error messages say which switch."
}
check "Automation → Messages" 'tell application "Messages" to count of accounts' "" Automation "Messages"
check "Automation → System Events" 'tell application "System Events" to count processes' "" Automation "System Events"
check "Accessibility" 'tell application "System Events" to get UI elements enabled' "true" Accessibility "its switch"

bold "Done. Your Mac is ready."
echo "  Mac address for config.json on the PC:  \"mac_host\": \"$USER@$(scutil --get LocalHostName).local\""
echo "  Tapbacks, edits and Undo Send only work while this Mac is unlocked."
