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
- On the PC: Python 3.10+ and Node.js (only used once, to fetch Electron).
- For SMS / green bubbles: on the iPhone, Settings > Messages > Text Message Forwarding > turn on
  the Mac.

## Setup

### On the Mac

1. **System Settings > General > Sharing > Remote Login**: on.
2. **System Settings > Privacy & Security**, for `sshd-keygen-wrapper` (it's what SSH sessions run
   as; add it with **+**, then **Cmd+Shift+G** and `/usr/libexec/sshd-keygen-wrapper`):
   - **Full Disk Access**: on (reads the Messages database and Contacts).
   - **Automation**: Messages on (sending). System Events on (tapbacks, edit, unsend). These appear
     the first time the app asks; the app's error messages say which one is missing.
   - **Accessibility**: on (tapbacks, edit, unsend).

### On the PC

```powershell
git clone https://github.com/DeltaPlusProtoTyping/iMassage.git
cd iMassage
pip install -r requirements.txt
npx electron --version                 # puts an Electron zip in the local cache for install.ps1

ssh-keygen -t ed25519                  # skip if you already have ~/.ssh/id_ed25519
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh you@your-mac.local "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"

copy config.example.json config.json   # then set mac_host (and ssh_key if it's not id_ed25519)
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` builds `runtime\` (Electron renamed `iMassage.exe`), registers an `iMassage Server`
scheduled task that runs `server.py` at logon, and starts the app. It adds itself to the Start Menu
and starts hidden at login (tray menu > Open at Login).

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
| `install.ps1` | Builds `runtime/`, registers the `iMassage Server` logon task, starts the app |
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
