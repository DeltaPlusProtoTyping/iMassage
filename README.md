# iMassage

iMessage and SMS on a Windows PC, sent and received through your Mac's Messages app, in a window
that looks and behaves like Messages.

```
iMassage.exe (Electron: window, tray, toasts) --loads--> http://127.0.0.1:8766  server.py (FastAPI)
                                                                                 | one SSH session
                                                                                 v
                                                       mac_agent.py on the Mac: reads chat.db + Contacts,
                                                       pushes new rows within ~0.25 s, sends with AppleScript,
                                                       tapbacks/edits/unsend through Messages' accessibility actions
```

Nothing is installed on the Mac: `server.py` streams `mac_agent.py` (Python 3.9, standard library
only) down an SSH session each time it connects.

## What you need

- A Mac that stays on, signed in to iMessage in Messages (tested on macOS 26.3).
- A Windows 10/11 PC that can reach the Mac over SSH: same network, or anything that routes to it
  (Tailscale, a VPN).
- On the PC: Git, Python 3.10+ and Node.js (only used once, to fetch Electron).
- For SMS / green bubbles: on the iPhone, Settings > Messages > Text Message Forwarding > turn on
  the Mac.

## Video tutorial

<video src="https://github.com/DeltaPlusProtoTyping/iMassage/raw/main/tutorial/iMassage-tutorial.mp4" poster="tutorial/thumbnail.jpg" controls width="100%"></video>

**[Watch the 90-second tutorial](tutorial/iMassage-tutorial.mp4)**
(setup on both machines, then every feature). The conversations in it are made-up demo data.

## Setup

Two steps: one PowerShell block on the PC, then one pasted line on the Mac. You type your Mac
password once.

### 1. On the PC

```powershell
git clone https://github.com/DeltaPlusProtoTyping/iMassage.git
cd iMassage
pip install -r requirements.txt
npx electron --version
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` makes an SSH key if you don't have one, then prints a one-line command for the Mac
with that key already filled in, and copies it to your clipboard. Leave it waiting.

### 2. On the Mac

Open **Terminal**, paste the line `install.ps1` printed, and press Return. It looks like:

```bash
curl -fsSL https://raw.githubusercontent.com/DeltaPlusProtoTyping/iMassage/main/mac-setup.sh | bash -s -- "ssh-ed25519 AAAA... imassage@YOUR-PC"
```

[`mac-setup.sh`](mac-setup.sh) asks for your password once, then:

1. installs Apple's Command Line Tools if they're missing (the agent runs on their Python 3)
2. turns on Remote Login (SSH) and authorizes the PC's key
3. keeps the Mac awake while plugged in (`pmset -c sleep 0`; the display can still sleep)
4. opens Messages, then the two Privacy panes macOS only lets you change by hand,
   **Full Disk Access** and **Accessibility**, with `/usr/libexec/sshd-keygen-wrapper` already on
   your clipboard: click **+**, **Cmd+Shift+G**, **Cmd+V**, Return, **Open**, and switch it on
5. makes macOS ask to let SSH control **Messages** and **System Events** while you're sitting
   there (click **OK** twice), then checks that all of it works

It ends with `Your Mac is ready` and the `mac_host` to type back into `install.ps1` on the PC,
which then finishes: it builds `runtime\` (Electron renamed `iMassage.exe`), registers an
`iMassage Server` scheduled task that runs `server.py` at logon, and starts the app. The app adds
itself to the Start Menu and starts hidden at login (tray menu > Open at Login).

<details>
<summary>Doing the Mac side by hand instead</summary>

```bash
xcode-select --install                                   # Command Line Tools, if `python3` isn't there yet
sudo systemsetup -f -setremotelogin on                   # or System Settings > General > Sharing > Remote Login
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA... (the PC's id_ed25519.pub)" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
sudo pmset -c sleep 0                                    # stay awake on power
echo "$USER@$(scutil --get LocalHostName).local"         # your mac_host
```

Then in **System Settings > Privacy & Security**, for `/usr/libexec/sshd-keygen-wrapper`: turn on
**Full Disk Access** and **Accessibility**, and under **Automation** allow **Messages** and
**System Events** (those two appear after the PC first connects; the app's errors say which is
missing).
</details>
## Using it

- **Enter** sends, **Shift+Enter** new line. Paste or drag photos/files in, or use **+**. The
  smiley opens the Windows emoji panel. Typing anywhere goes to the message box.
- **Double-click** a message for tapbacks (pick the same one again to remove it). **Right-click** a
  message for Reply, Copy, Save, and on your own iMessages **Edit** (15 minutes) and **Undo Send**
  (2 minutes).
- **Right-click the send button** to Send Later (in an hour, tonight, tomorrow morning, or a custom
  time). The PC sends it at that time, so it has to be on.
- **Ctrl+F** finds text in the open conversation (Enter / Shift+Enter step older / newer);
  **Ctrl+Shift+F** searches all conversations. **Ctrl+N** new message. **Ctrl+1...9** pinned
  conversations. **Ctrl+Tab / Alt+Up/Down** next/previous. **Ctrl+I** details. **Esc** closes
  things. **Ctrl+W** hides, **Ctrl+Q** quits, **Ctrl+R** reloads.
- Right-click a conversation to pin/unpin it or mark it read. Pinned conversations always load,
  however old; older ones load as you scroll the sidebar. Unsent text is kept per conversation as
  a draft, across restarts.
- Shows link previews, tapbacks, replies, edits, unsent notices, effects (with Replay), voice
  memos, photos, videos and files. Threads mark where they switch between iMessage and SMS.
- Closing the window leaves it in the tray; new messages show a Windows notification and play a
  tri-tone style chime. The tray menu has Sounds and Appearance (match Windows / light / dark).

Limits: tapbacks, edit and Undo Send drive Messages on the Mac, so they only work while the Mac's
screen is unlocked. Replies are sent as a quoted message, not a threaded reply. No new group chats
(existing groups work), no read receipts back to the phone. HEVC videos may not play here; they
fall back to a Save link. HEIC photos are converted on the Mac.

## Files

| Path | What |
|---|---|
| `server.py` | Windows server: SSH link + reconnect, contacts, pins, send-later queue, JSON API, SSE, serves `web/` |
| `mac_agent.py` | Runs on the Mac inside the SSH session; streamed at connect, nothing installed |
| `web/` | The UI (`index.html`, `app.js`, `effects.js`, `style.css`, `fonts/Inter.woff2`, OFL) |
| `desktop/` | Electron main process + preload; `runtime/resources/app` is a junction to it |
| `install.ps1` | SSH key + Mac link, builds `runtime/`, registers the `iMassage Server` logon task, starts the app |
| `mac-setup.sh` | One-time Mac setup, pasted into Terminal (see Setup) |
| `tutorial/` | The tutorial video's source: `tutorial.html` (canvas + synthesized score), demo screenshots, `recorder/` |
| `config.json` | Yours, not committed: `mac_host`, `ssh_key`, `port`, `chat_limit` (see `config.example.json`) |
| `state.json` | Pins, last-seen message per chat, scheduled messages |
| `cache/`, `logs/` | Fetched attachments/photos (safe to delete); `logs/server.log` |

UI changes take effect on **Ctrl+R**; `desktop/` changes need Quit and reopen; `mac_agent.py` and
`server.py` changes need the server task restarted. Outgoing attachments are staged in
`~/Pictures/iMassage` on the Mac (Messages won't send files from most folders) and cleared after
two days.

Test hook: `runtime\iMassage.exe --user-data-dir=<temp> --capture=out.png [--chat=<id>]
[--js=<expr> | --js-file=<path>] [--theme=light|dark] [--capture-quit]` screenshots a separate
window after load.

## API (for scripts)

All on `http://127.0.0.1:8766`. Non-GET requests need header `X-iMassage: 1`; any other `Host` is
refused.

- `GET /api/status` · `GET /api/chats[?limit=]` · `GET /api/chats/{id}/messages?before=<rowid>&limit=60`
- `GET /api/search?q=[&chat=<id>]` · `GET /api/contacts` · `GET /api/chats/{id}/media`
- `GET /api/attachment/{id}[?download=1|?thumb=1]` · `GET /api/photo/{key}`
- `POST /api/send` `{"chat": "<chat guid>", "text": "..."}` or `{"to": "+15551234567", "service": "iMessage"|"SMS", "text": "..."}`,
  optional `"files": [{"name": "a.jpg", "data": "<base64>"}]`
- `POST /api/react` `{"chat", "target": "<message guid>", "kind": "love|like|dislike|laugh|emphasize|question", "remove"}`
- `POST /api/edit` `{"chat", "target", "text"}` · `POST /api/unsend` `{"chat", "target"}`
- `GET|POST /api/scheduled` `{"chat", "text", "at": <unix ms>}` · `DELETE /api/scheduled/{id}`
- `POST /api/pins` `{"pins": [chat ids]}`
- `GET /api/events` server-sent events: `status`, `messages` (new or changed rows), `scheduled`

## Troubleshooting

- "Can't reach your Mac": it's asleep, off the network, or its address changed. Set `mac_host`
  in `config.json` (e.g. `you@your-mac.local`) and restart the task. `ssh you@your-mac.local`
  from the PC should log in without a password.
- Sends fail with an Automation message: turn on Messages / System Events for
  `sshd-keygen-wrapper` (see Setup).
- "Starting iMassage..." that never clears: the server isn't coming up; see `logs/server.log`.
- `Stop-ScheduledTask -TaskName 'iMassage Server'` then `Start-ScheduledTask ...` restarts the server.
