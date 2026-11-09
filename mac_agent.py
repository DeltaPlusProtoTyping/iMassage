"""iMassage agent: runs on the Mac, inside the SSH session that server.py opens.

Nothing is installed on the Mac. server.py starts `/usr/bin/python3 -u -c <bootstrap>` over SSH,
writes this file's bytes down the pipe, and the bootstrap exec()s them. Must stay compatible with
the Mac's Command Line Tools Python (3.9) and use only the standard library.

Protocol, one JSON object per line (ASCII on the wire):
  in   {"id": 7, "op": "messages", "args": {...}}
  out  {"id": 7, "ok": true, "result": ...}  |  {"id": 7, "ok": false, "error": "..."}
  out  {"event": "messages", "messages": [...]}   rows that are new or changed since the last poll

Reads chat.db and the AddressBook read-only. Writes only: sending (AppleScript to Messages) and
staging outgoing attachments in ~/Pictures/iMassage, which Messages is allowed to read.
"""
import base64
import glob
import json
import os
import platform
import plistlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

HOME = os.path.expanduser("~")
CHAT_DB = os.path.join(HOME, "Library/Messages/chat.db")
AB_DIR = os.path.join(HOME, "Library/Application Support/AddressBook")
OUTBOX = os.path.join(HOME, "Pictures/iMassage")
APPLE_EPOCH = 978307200
POLL_SECS = 0.25
WATCH_WINDOW = 400      # recent rows re-checked for delivered/read/edited changes
MAX_FILE = 100 * 1024 * 1024
TAPBACKS = {0: "love", 1: "like", 2: "dislike", 3: "laugh", 4: "emphasize", 5: "question",
            6: "emoji", 7: "sticker"}

_out_lock = threading.Lock()
_local = threading.local()


def emit(obj):
    line = json.dumps(obj, separators=(",", ":")) + "\n"
    try:
        with _out_lock:
            sys.stdout.write(line)
            sys.stdout.flush()
    except (BrokenPipeError, OSError):
        os._exit(0)


def ro_connect(path):
    conn = sqlite3.connect("file:%s?mode=ro" % quote(path), uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def db():
    conn = getattr(_local, "db", None)
    if conn is None:
        conn = _local.db = ro_connect(CHAT_DB)
    return conn


def ms(apple):
    """chat.db dates are nanoseconds since 2001 (seconds on very old databases) -> unix ms."""
    if not apple:
        return 0
    if apple > 10 ** 12:
        return apple // 1000000 + APPLE_EPOCH * 1000
    return (apple + APPLE_EPOCH) * 1000


def body_text(blob):
    """Text out of attributedBody, a typedstream-archived NSAttributedString. Newer macOS leaves
    `text` NULL and keeps the words only here: ...NSString 01 94 84 01 '+' <len> <utf-8 bytes>."""
    if not blob:
        return None
    b = bytes(blob)
    i = b.find(b"NSString")
    if i < 0:
        return None
    j = b.find(b"+", i + 8, i + 16)
    if j < 0:
        return None
    j += 1
    n = b[j]
    j += 1
    if n == 0x81:
        n = int.from_bytes(b[j:j + 2], "little")
        j += 2
    elif n == 0x82:
        n = int.from_bytes(b[j:j + 4], "little")
        j += 4
    return b[j:j + n].decode("utf-8", "replace")


# --- handles ----------------------------------------------------------------------------------

_handles = {}
_handles_lock = threading.Lock()


def handle_str(rowid):
    if not rowid:
        return None
    with _handles_lock:
        if rowid not in _handles:
            for r in db().execute("SELECT ROWID, id FROM handle"):
                _handles[r[0]] = r[1]
        return _handles.get(rowid)


# --- messages ---------------------------------------------------------------------------------

MSG_COLS = """m.ROWID, m.guid, m.text, m.attributedBody, m.handle_id, m.service, m.date, m.date_read,
  m.date_delivered, m.is_delivered, m.is_read, m.is_sent, m.is_from_me, m.error, m.item_type,
  m.group_title, m.group_action_type, m.other_handle, m.associated_message_guid,
  m.associated_message_type, m.associated_message_emoji, m.balloon_bundle_id,
  m.expressive_send_style_id, m.thread_originator_guid, m.date_edited, m.date_retracted,
  m.cache_has_attachments, m.is_audio_message, m.subject, cmj.chat_id,
  CASE WHEN m.date_edited > 0 THEN m.message_summary_info END AS summary,
  CASE WHEN m.balloon_bundle_id LIKE '%URLBalloonProvider%' THEN m.payload_data END AS payload"""


def attachments_for(rowids):
    """message ROWID -> {"shown": [...], "hidden": [...]}. Hidden ones are link-preview payloads."""
    out = {}
    if not rowids:
        return out
    q = """SELECT maj.message_id, a.ROWID, a.filename, a.mime_type, a.uti, a.transfer_name,
                  a.total_bytes, a.is_sticker, a.transfer_state, a.hide_attachment
           FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
           WHERE maj.message_id IN (%s) ORDER BY a.ROWID""" % ",".join("?" * len(rowids))
    for r in db().execute(q, list(rowids)):
        name = r["transfer_name"] or os.path.basename(r["filename"] or "") or "attachment"
        slot = out.setdefault(r["message_id"], {"shown": [], "hidden": []})
        slot["hidden" if r["hide_attachment"] else "shown"].append({
            "id": r["ROWID"], "name": name, "mime": r["mime_type"] or "", "uti": r["uti"] or "",
            "size": r["total_bytes"] or 0, "sticker": bool(r["is_sticker"]),
            "ready": r["transfer_state"] == 5,
        })
    return out


def unarchive(data):
    """Just enough NSKeyedArchiver decoding for LPLinkMetadata: dicts, arrays, strings, URLs."""
    p = plistlib.loads(bytes(data))
    objs = p.get("$objects") or []

    def res(x, depth=0):
        if isinstance(x, plistlib.UID):
            x = objs[x.data] if x.data < len(objs) else None
        if depth > 16:
            return None
        if isinstance(x, dict):
            if "NS.keys" in x and "NS.objects" in x:
                return {res(k, depth + 1): res(v, depth + 1) for k, v in zip(x["NS.keys"], x["NS.objects"])}
            if "NS.objects" in x:
                return [res(v, depth + 1) for v in x["NS.objects"]]
            if "NS.string" in x:
                return res(x["NS.string"], depth + 1)
            if "NS.relative" in x:
                return res(x["NS.relative"], depth + 1)
            return {k: res(v, depth + 1) for k, v in x.items() if k != "$class"}
        return None if x == "$null" else x

    return res((p.get("$top") or {}).get("root"))


def link_preview(payload, hidden):
    """Title, site and thumbnail of a shared link, from the rich-link metadata the sender's phone
    archived into payload_data. Images live in the message's hidden attachments, by index."""
    try:
        root = unarchive(payload)
    except Exception:  # noqa: BLE001 - odd payloads just get no preview
        return None
    meta = root.get("richLinkMetadata") if isinstance(root, dict) else None
    if not isinstance(meta, dict):
        return None

    def att(ref):
        i = ref.get("richLinkImageAttachmentSubstituteIndex") if isinstance(ref, dict) else None
        if isinstance(i, int) and 0 <= i < len(hidden) and hidden[i]["ready"]:
            return hidden[i]["id"]
        return None

    image = att(meta.get("image"))
    if image is None and isinstance(meta.get("contentImages"), list) and meta["contentImages"]:
        image = att(meta["contentImages"][0])
    size = None
    md = meta.get("imageMetadata")
    if isinstance(md, dict) and isinstance(md.get("size"), str):
        nums = [float(n) for n in re.findall(r"[\d.]+", md["size"])[:2]]
        if len(nums) == 2 and nums[0] > 0 and nums[1] > 0:
            size = nums
    url = meta.get("originalURL") or meta.get("URL")
    if not isinstance(url, str):
        return None
    text = lambda v: v if isinstance(v, str) else None  # noqa: E731
    return {"url": url, "title": text(meta.get("title")), "site": text(meta.get("siteName")),
            "image": image, "size": size, "icon": att(meta.get("icon"))}


def target_guid(assoc):
    if not assoc:
        return None
    if "/" in assoc:
        return assoc.rsplit("/", 1)[1]
    if assoc.startswith("bp:"):
        return assoc[3:]
    return assoc


def msg_dict(r, atts):
    text = r["text"]
    if text is None or not text.replace("￼", "").strip():
        decoded = body_text(r["attributedBody"])
        if decoded:
            text = decoded
    text = (text or "").replace("￼", "").strip()
    d = {
        "id": r["ROWID"], "guid": r["guid"], "chat": r["chat_id"], "date": ms(r["date"]),
        "fromMe": bool(r["is_from_me"]), "handle": handle_str(r["handle_id"]),
        "service": r["service"] or "", "text": text,
        "sent": bool(r["is_sent"]), "delivered": bool(r["is_delivered"]), "read": bool(r["is_read"]),
        "dateRead": ms(r["date_read"]), "dateDelivered": ms(r["date_delivered"]),
        "error": r["error"] or 0, "itemType": r["item_type"] or 0,
    }
    if r["item_type"]:
        d["groupAction"] = r["group_action_type"]
        d["groupTitle"] = r["group_title"]
        d["other"] = handle_str(r["other_handle"])
    at = r["associated_message_type"] or 0
    if 2000 <= at < 4000:
        d["reaction"] = {"target": target_guid(r["associated_message_guid"]),
                         "kind": TAPBACKS.get(at % 1000, "emoji"),
                         "emoji": r["associated_message_emoji"], "remove": at >= 3000}
    elif at:
        d["assocType"] = at
    if r["balloon_bundle_id"]:
        d["balloon"] = r["balloon_bundle_id"].rsplit(":", 1)[-1]
    if r["expressive_send_style_id"]:
        d["effect"] = r["expressive_send_style_id"].rsplit(".", 1)[-1]
    if r["thread_originator_guid"]:
        d["replyTo"] = r["thread_originator_guid"]
    # Undo Send on current macOS sets date_edited and lists the retracted parts under "rp" in
    # message_summary_info; date_retracted stays 0.
    summary = {}
    if r["summary"]:
        try:
            summary = plistlib.loads(bytes(r["summary"]))
        except Exception:  # noqa: BLE001
            summary = {}
    if r["date_retracted"] or summary.get("rp"):
        d["unsent"] = True
    elif r["date_edited"]:
        d["edited"] = True
    if r["is_audio_message"]:
        d["audio"] = True
    if r["subject"]:
        d["subject"] = r["subject"]
    a = atts.get(r["ROWID"]) or {"shown": [], "hidden": []}
    if a["shown"]:
        d["attachments"] = a["shown"]
    if r["payload"]:
        lp = link_preview(r["payload"], a["hidden"])
        if lp:
            d["link"] = lp
    return d


def fetch_messages(where, params, order="DESC", limit=None):
    q = ("SELECT %s FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID "
         "WHERE %s ORDER BY cmj.message_date %s, m.ROWID %s" % (MSG_COLS, where, order, order))
    if limit:
        q += " LIMIT %d" % int(limit)
    rows = db().execute(q, params).fetchall()
    atts = attachments_for([r["ROWID"] for r in rows if r["cache_has_attachments"] or r["payload"]])
    return [msg_dict(r, atts) for r in rows]


# --- ops --------------------------------------------------------------------------------------

def op_hello(_args):
    return {"host": platform.node(), "macos": platform.mac_ver()[0], "python": platform.python_version(),
            "maxRowid": db().execute("SELECT MAX(ROWID) FROM message").fetchone()[0] or 0}


def op_chats(args):
    limit = int(args.get("limit", 300))
    unread_since = (time.time() - APPLE_EPOCH - 14 * 86400) * 10 ** 9
    conn = db()
    base = """
        SELECT c.ROWID, c.guid, c.chat_identifier, c.service_name, c.style, c.display_name,
               c.is_filtered, c.is_archived, lm.last_date
        FROM chat c
        JOIN (SELECT chat_id, MAX(message_date) AS last_date FROM chat_message_join GROUP BY chat_id) lm
          ON lm.chat_id = c.ROWID"""
    chats = conn.execute(base + " ORDER BY lm.last_date DESC LIMIT ?", (limit,)).fetchall()
    ids = [c["ROWID"] for c in chats]
    # Pinned chats stay listed however old they are.
    extra = [int(x) for x in args.get("include", []) if int(x) not in ids]
    if extra:
        chats += conn.execute(base + " WHERE c.ROWID IN (%s)" % ",".join("?" * len(extra)), extra).fetchall()
        ids = [c["ROWID"] for c in chats]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    members = {}
    for r in conn.execute("SELECT chj.chat_id, h.id FROM chat_handle_join chj "
                          "JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id IN (%s)" % marks, ids):
        members.setdefault(r[0], []).append(r[1])
    unread = {}
    for r in conn.execute("""
            SELECT cmj.chat_id, m.ROWID FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            WHERE m.is_from_me = 0 AND m.is_read = 0 AND m.item_type = 0 AND m.associated_message_type = 0
              AND m.date > ? AND cmj.chat_id IN (%s)""" % marks, [unread_since] + ids):
        unread.setdefault(r[0], []).append(r[1])
    out = []
    for c in chats:
        last = fetch_messages("cmj.chat_id = ? AND m.associated_message_type = 0", (c["ROWID"],), limit=1)
        out.append({
            "id": c["ROWID"], "guid": c["guid"], "identifier": c["chat_identifier"],
            "service": c["service_name"] or "", "group": c["style"] == 43,
            "displayName": c["display_name"] or "", "filtered": c["is_filtered"] or 0,
            "archived": bool(c["is_archived"]), "members": members.get(c["ROWID"], []),
            "lastDate": ms(c["last_date"]), "last": last[0] if last else None,
            "unread": unread.get(c["ROWID"], [])[-99:],
        })
    return out


def op_messages(args):
    chat = int(args["chat"])
    limit = int(args.get("limit", 60))
    before = args.get("before")
    where, params = "cmj.chat_id = ? AND m.associated_message_type = 0", [chat]
    if before:
        where += " AND cmj.message_date < (SELECT date FROM message WHERE ROWID = ?)"
        params.append(int(before))
    msgs = fetch_messages(where, params, limit=limit + 1)
    more = len(msgs) > limit
    msgs = list(reversed(msgs[:limit]))
    reactions = []
    if msgs:
        guids = set(m["guid"] for m in msgs)
        first = min(m["id"] for m in msgs)
        for m in fetch_messages("cmj.chat_id = ? AND m.associated_message_type BETWEEN 2000 AND 3999 "
                                "AND m.ROWID > ?", (chat, first), order="ASC"):
            if m["reaction"]["target"] in guids:
                reactions.append(m)
    return {"messages": msgs, "reactions": reactions, "more": more}


def op_message(args):
    """Look up single messages by guid (reply previews whose original is not loaded)."""
    guids = list(args.get("guids", []))[:50]
    if not guids:
        return []
    return fetch_messages("m.guid IN (%s)" % ",".join("?" * len(guids)), guids)


def op_search(args):
    term = (args.get("q") or "").strip()
    if len(term) < 2:
        return []
    like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    where = ("m.associated_message_type = 0 AND m.item_type = 0 AND "
             "(m.text LIKE ? ESCAPE '\\' OR (m.text IS NULL AND instr(m.attributedBody, CAST(? AS BLOB)) > 0))")
    params = [like, term]
    if args.get("chat"):  # find-in-conversation
        where += " AND cmj.chat_id = ?"
        params.append(int(args["chat"]))
    return fetch_messages(where, params, limit=int(args.get("limit", 80)))


def address_books():
    paths = glob.glob(os.path.join(AB_DIR, "Sources", "*", "AddressBook-v22.abcddb"))
    main = os.path.join(AB_DIR, "AddressBook-v22.abcddb")
    if os.path.exists(main):
        paths.append(main)
    return paths


def op_contacts(_args):
    people = {}
    for path in address_books():
        try:
            conn = ro_connect(path)
        except sqlite3.Error:
            continue
        src = os.path.basename(os.path.dirname(path))
        with conn:
            for r in conn.execute("""SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION,
                                            ZTHUMBNAILIMAGEDATA IS NOT NULL AS has_photo FROM ZABCDRECORD"""):
                first, last = r["ZFIRSTNAME"] or "", r["ZLASTNAME"] or ""
                name = (first + " " + last).strip() or r["ZORGANIZATION"] or r["ZNICKNAME"] or ""
                if name:
                    people[(src, r["Z_PK"])] = {"key": "%s:%d" % (src, r["Z_PK"]), "name": name,
                                                "first": first or name, "photo": bool(r["has_photo"]),
                                                "phones": [], "emails": []}
            for r in conn.execute("SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL"):
                p = people.get((src, r[0]))
                if p:
                    p["phones"].append(r[1])
            for r in conn.execute("SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL"):
                p = people.get((src, r[0]))
                if p:
                    p["emails"].append(r[1])
        conn.close()
    return [p for p in people.values() if p["phones"] or p["emails"]]


def op_photo(args):
    src, pk = args["key"].rsplit(":", 1)
    path = (os.path.join(AB_DIR, "AddressBook-v22.abcddb") if src == "AddressBook"
            else os.path.join(AB_DIR, "Sources", src, "AddressBook-v22.abcddb"))
    conn = ro_connect(path)
    row = conn.execute("SELECT ZTHUMBNAILIMAGEDATA FROM ZABCDRECORD WHERE Z_PK = ?", (int(pk),)).fetchone()
    conn.close()
    blob = bytes(row[0]) if row and row[0] else b""
    if blob[:1] == b"\x01":          # inline JPEG
        data = blob[1:]
    elif blob[:1] == b"\x02":        # external file, named by the UUID that follows
        name = blob[1:].split(b"\x00", 1)[0].decode("ascii", "ignore")
        ext = os.path.join(os.path.dirname(path), ".AddressBook-v22_SUPPORT", "_EXTERNAL_DATA", name)
        with open(ext, "rb") as f:
            data = f.read()
    else:
        return None
    return {"mime": "image/jpeg", "data": base64.b64encode(data).decode("ascii")}


BROWSER_IMAGES = ("image/jpeg", "image/png", "image/gif", "image/webp", "image/x-icon", "image/bmp")


def sniff(path):
    """Type of a file Messages didn't label (link-preview payloads are bare image data)."""
    with open(path, "rb") as f:
        head = f.read(32)
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"GIF8":
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"hevc"):
        return "image/heic"
    if head[:4] == b"\x00\x00\x01\x00":
        return "image/x-icon"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "image/tiff"
    return ""


def image_side(path):
    """Longest side in pixels, so small images (stickers) aren't scaled up."""
    r = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                       capture_output=True, text=True, timeout=30)
    nums = [int(w) for line in r.stdout.splitlines() for w in line.split()[1:] if w.isdigit()]
    return max(nums) if nums else 0


def op_attachment(args):
    row = db().execute("SELECT filename, mime_type, uti, transfer_name, is_sticker FROM attachment WHERE ROWID = ?",
                       (int(args["id"]),)).fetchone()
    if not row or not row["filename"]:
        raise ValueError("no such attachment")
    path = os.path.expanduser(row["filename"])
    if not os.path.exists(path):
        raise ValueError("attachment not downloaded on the Mac yet")
    mime, uti = (row["mime_type"] or ""), (row["uti"] or "")
    name = row["transfer_name"] or os.path.basename(path)
    if not mime:
        mime = sniff(path)
        if mime.startswith("image/") and name.endswith(".pluginPayloadAttachment"):
            name = "preview." + mime.split("/")[1].replace("x-icon", "ico").replace("jpeg", "jpg")
    tmp = None
    try:
        if args.get("thumb") and mime.startswith("image/"):
            tmp = tempfile.mkdtemp(prefix="imassage-")
            out = os.path.join(tmp, "thumb.jpg")
            cmd = ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "72"]
            if image_side(path) > 360:
                cmd += ["-Z", "360"]
            subprocess.run(cmd + [path, "--out", out],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True)
            path, mime = out, "image/jpeg"
            name = os.path.splitext(name)[0] + ".jpg"
        elif args.get("display") and mime.startswith("image/") and mime not in BROWSER_IMAGES:
            fmt = "png" if row["is_sticker"] else "jpeg"   # stickers keep their transparency
            tmp = tempfile.mkdtemp(prefix="imassage-")
            out = os.path.join(tmp, "out." + fmt)
            cmd = ["sips", "-s", "format", fmt]
            if fmt == "jpeg":
                cmd += ["-s", "formatOptions", "82"]
            if image_side(path) > 1600:
                cmd += ["-Z", "1600"]
            subprocess.run(cmd + [path, "--out", out],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True)
            path, mime = out, "image/" + fmt
            name = os.path.splitext(name)[0] + (".png" if fmt == "png" else ".jpg")
        elif args.get("display") and uti == "com.apple.coreaudio-format":
            tmp = tempfile.mkdtemp(prefix="imassage-")
            out = os.path.join(tmp, "out.m4a")
            subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", path, out],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True)
            path, mime = out, "audio/mp4"
            name = os.path.splitext(name)[0] + ".m4a"
        size = os.path.getsize(path)
        if size > MAX_FILE:
            raise ValueError("attachment is %d MB; open it on the Mac" % (size // 1048576))
        with open(path, "rb") as f:
            data = f.read()
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    return {"name": name, "mime": mime or "application/octet-stream",
            "data": base64.b64encode(data).decode("ascii")}


def op_put_file(args):
    """Stage an outgoing attachment where Messages may read it; returns the path for op_send."""
    name = os.path.basename(args.get("name") or "file").replace("/", "_") or "file"
    folder = os.path.join(OUTBOX, uuid.uuid4().hex)
    os.makedirs(folder)
    path = os.path.join(folder, name)
    with open(path, "wb") as f:
        f.write(base64.b64decode(args["data"]))
    return path


SEND_TO_CHAT = """on run argv
	set chatId to item 1 of argv
	set msgText to item 2 of argv
	set theFiles to {}
	repeat with i from 3 to count of argv
		set end of theFiles to (POSIX file (item i of argv))
	end repeat
	tell application "Messages"
		set theChat to chat id chatId
		repeat with f in theFiles
			send (contents of f) to theChat
		end repeat
		if msgText is not "" then send msgText to theChat
	end tell
end run"""

SEND_TO_HANDLE = """on run argv
	set svc to item 1 of argv
	set who to item 2 of argv
	set msgText to item 3 of argv
	set theFiles to {}
	repeat with i from 4 to count of argv
		set end of theFiles to (POSIX file (item i of argv))
	end repeat
	tell application "Messages"
		if svc is "SMS" then
			set acct to first account whose service type is SMS
		else if svc is "RCS" then
			set acct to first account whose service type is RCS
		else
			set acct to first account whose service type is iMessage
		end if
		set p to participant who of acct
		repeat with f in theFiles
			send (contents of f) to p
		end repeat
		if msgText is not "" then send msgText to p
	end tell
end run"""


def osascript(script, argv):
    r = subprocess.run(["osascript", "-e", script] + argv, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        err = (r.stderr or r.stdout).strip()
        if "-1743" in err:
            err = ("The Mac is blocking SSH from controlling Messages. On the Mac: System Settings > "
                   "Privacy & Security > Automation > sshd-keygen-wrapper > turn on Messages.")
        raise RuntimeError(err or "osascript failed")


def op_send(args):
    text = args.get("text") or ""
    files = [p for p in (args.get("files") or []) if os.path.isfile(p)]
    if not text.strip() and not files:
        raise ValueError("nothing to send")
    if args.get("chat"):
        osascript(SEND_TO_CHAT, [args["chat"], text] + files)
    elif args.get("to"):
        osascript(SEND_TO_HANDLE, [args.get("service") or "iMessage", args["to"], text] + files)
    else:
        raise ValueError("need chat or to")
    return True


def op_ping(_args):
    return time.time()


# Tapbacks, edits and Undo Send have no AppleScript command. Messages (macOS 26) exposes each as a
# named accessibility action on the message bubble, so: open the conversation at that message
# (sms://open?message-guid=), find the bubble by its spoken description ("Your iMessage, <text>,
# <time>"), and perform the action. Needs System Events (Automation) + Accessibility for
# sshd-keygen-wrapper on the Mac.
TAPBACK_ACTION = {"love": "Heart", "like": "Thumbs up", "dislike": "Thumbs down", "laugh": "Ha ha!",
                  "emphasize": "Exclamation mark", "question": "Question mark"}

UI_JS = r"""
function run(argv) {
  const [action, mine, snippet, time, text] = argv;
  const se = Application('System Events');
  const proc = se.processes.byName('Messages');
  const w = proc.windows[0];
  function first(el, test, depth) {
    let kids = [];
    try { kids = el.uiElements(); } catch (e) { return null; }
    for (const k of kids) {
      if (test(k)) return k;
      if (depth > 0) { const r = first(k, test, depth - 1); if (r) return r; }
    }
    return null;
  }
  const ident = el => { try { return el.attributes.byName('AXIdentifier').value(); } catch (e) { return ''; } };
  const desc = el => { try { return String(el.description()); } catch (e) { return ''; } };
  const role = el => { try { return el.role(); } catch (e) { return ''; } };
  let transcript = null;
  for (let i = 0; i < 20 && !transcript; i++) {
    transcript = first(w, el => ident(el) === 'TranscriptCollectionView', 16);
    if (!transcript) delay(0.25);
  }
  if (!transcript) throw new Error("Couldn't find the conversation in Messages on the Mac.");
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const rows = transcript.uiElements().filter(r => {
    const d = norm(desc(r));
    return (mine === '1') === d.startsWith('Your ') && d.indexOf(snippet) >= 0;
  });
  const timed = rows.filter(r => time && norm(desc(r)).endsWith(', ' + time));
  const row = (timed.length ? timed : rows).pop();
  if (!row) throw new Error("Couldn't find that message in Messages on the Mac.");
  const bubble = row.uiElements()[0] || row;
  const acts = bubble.actions();
  const a = acts.filter(x => x.name().split('\n')[0] === 'Name:' + action)[0];
  if (!a) {
    const have = acts.map(x => x.name().split('\n')[0].replace('Name:', '')).filter(n => !/^AX/.test(n));
    if (action === 'Edit' || action === 'Undo Send') throw new Error(action + ' is no longer available for that message (too old, or already changed).');
    throw new Error("Messages didn't offer " + action + ' (has: ' + have.join(', ') + ')');
  }
  a.perform();
  if (action !== 'Edit') return 'ok';
  let field = null, send = null;
  for (let i = 0; i < 20 && !(field && send); i++) {
    delay(0.15);
    field = first(w, el => role(el) === 'AXTextField' && (function () { try { return el.focused(); } catch (e) { return false; } })(), 20);
    send = first(w, el => role(el) === 'AXButton' && desc(el) === 'Send edit', 20);
  }
  if (!field || !send) throw new Error("Messages didn't open the editor for that message.");
  field.value = text;
  delay(0.2);
  if (field.value() !== text) {
    const cancel = first(w, el => role(el) === 'AXButton' && desc(el) === 'Cancel edit', 20);
    if (cancel) cancel.actions.byName('AXPress').perform();
    throw new Error("Couldn't type the new text into Messages.");
  }
  send.actions.byName('AXPress').perform();
  return 'ok';
}
"""

_ui_lock = threading.Lock()


def ui_action(guid, action, text=""):
    rows = fetch_messages("m.guid = ?", (guid,), limit=1)
    if not rows:
        raise ValueError("message not found")
    m = rows[0]
    words = m["text"] or (m.get("attachments") or [{}])[0].get("name") or ""
    snippet = re.sub(r"\s+", " ", words).strip()[:40]
    if not snippet:
        raise RuntimeError("Can't find a message with no text on the Mac yet.")
    t = time.localtime(m["date"] / 1000)
    clock = time.strftime("%I:%M %p", t).lstrip("0")
    # A locked screen stops Messages from exposing the conversation, so say so instead of failing.
    lock = subprocess.run(["ioreg", "-n", "Root", "-d1"], capture_output=True, text=True, timeout=10).stdout
    if '"CGSSessionScreenIsLocked"=Yes' in lock:
        raise RuntimeError("The Mac's screen is locked. Tapbacks, edits and Undo Send only work while "
                           "it's unlocked.")
    with _ui_lock:
        subprocess.run(["open", "sms://open?message-guid=" + guid], capture_output=True, timeout=15)
        time.sleep(1.0)
        r = subprocess.run(["osascript", "-l", "JavaScript", "-e", UI_JS, action,
                            "1" if m["fromMe"] else "0", snippet, clock, text],
                           capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        err = (r.stderr or r.stdout).strip()
        if "-1719" in err or "assistive access" in err:
            err = ("The Mac is blocking SSH from using Accessibility. On the Mac: System Settings > "
                   "Privacy & Security > Accessibility > turn on sshd-keygen-wrapper.")
        elif "-1743" in err:
            err = ("The Mac is blocking SSH from controlling System Events. On the Mac: System Settings > "
                   "Privacy & Security > Automation > sshd-keygen-wrapper > turn on System Events.")
        else:
            err = re.sub(r"^.*execution error: (Error: )*", "", err).replace(" (-2700)", "")
        raise RuntimeError(err or "Messages didn't respond")
    return True


def op_react(args):
    kind = args.get("kind")
    if kind not in TAPBACK_ACTION:
        raise ValueError("unknown tapback")
    # Performing the tapback you already left toggles it off, so add and remove are the same action.
    return ui_action(args["target"], TAPBACK_ACTION[kind])


def op_edit(args):
    text = (args.get("text") or "").strip()
    if not text:
        raise ValueError("nothing to change it to")
    return ui_action(args["target"], "Edit", text)


def op_unsend(args):
    return ui_action(args["target"], "Undo Send")


def op_media(args):
    """Photos and videos in one conversation, newest first (details panel)."""
    rows = db().execute("""
        SELECT a.ROWID, a.mime_type, a.transfer_name, a.transfer_state, m.date, m.ROWID
        FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
        JOIN message_attachment_join maj ON maj.message_id = m.ROWID
        JOIN attachment a ON a.ROWID = maj.attachment_id
        WHERE cmj.chat_id = ? AND a.hide_attachment = 0 AND a.is_sticker = 0
          AND (a.mime_type LIKE 'image/%' OR a.mime_type LIKE 'video/%')
        ORDER BY cmj.message_date DESC LIMIT ?""", (int(args["chat"]), int(args.get("limit", 90)))).fetchall()
    return [{"id": r[0], "mime": r[1] or "", "name": r[2] or "", "ready": r[3] == 5, "date": ms(r[4]),
             "message": r[5]} for r in rows]


def op_activity(args):
    """[chat_id, message count] over the last N days, busiest first (default pins)."""
    since = (time.time() - APPLE_EPOCH - int(args.get("days", 60)) * 86400) * 10 ** 9
    return [list(r) for r in db().execute(
        "SELECT chat_id, COUNT(*) FROM chat_message_join WHERE message_date > ? GROUP BY chat_id "
        "ORDER BY 2 DESC LIMIT ?", (since, int(args.get("limit", 20))))]


OPS = {"hello": op_hello, "chats": op_chats, "messages": op_messages, "message": op_message,
       "search": op_search, "contacts": op_contacts, "photo": op_photo, "attachment": op_attachment,
       "put_file": op_put_file, "send": op_send, "ping": op_ping, "media": op_media,
       "activity": op_activity, "react": op_react, "edit": op_edit, "unsend": op_unsend}


def handle(req):
    rid = req.get("id")
    try:
        fn = OPS.get(req.get("op"))
        if fn is None:
            raise ValueError("unknown op %r" % req.get("op"))
        emit({"id": rid, "ok": True, "result": fn(req.get("args") or {})})
    except Exception as e:  # noqa: BLE001 - every failure goes back to the caller
        sys.stderr.write(traceback.format_exc())
        sys.stderr.flush()
        emit({"id": rid, "ok": False, "error": str(e) or type(e).__name__})


# --- watcher: push new and changed rows -------------------------------------------------------

SIG_SQL = """SELECT m.ROWID, m.is_sent, m.is_delivered, m.is_read, m.date_read, m.error, m.date_edited,
                    m.date_retracted, m.cache_has_attachments,
                    (SELECT group_concat(a.transfer_state) FROM message_attachment_join maj
                       JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id = m.ROWID) AS ts
             FROM message m WHERE m.ROWID > ?"""


def file_state():
    out = []
    for p in (CHAT_DB, CHAT_DB + "-wal"):
        try:
            st = os.stat(p)
            out.append((st.st_size, st.st_mtime_ns))
        except OSError:
            out.append(None)
    return tuple(out)


def watcher():
    conn = ro_connect(CHAT_DB)
    _local.db = conn
    top = conn.execute("SELECT MAX(ROWID) FROM message").fetchone()[0] or 0
    sigs = {}
    for r in conn.execute(SIG_SQL, (top - WATCH_WINDOW,)):
        sigs[r[0]] = tuple(r)
    last_state, last_full = None, 0.0
    while True:
        time.sleep(POLL_SECS)
        try:
            state = file_state()
            now = time.time()
            if state == last_state and now - last_full < 20:
                continue
            last_state, last_full = state, now
            changed = []
            floor = top - WATCH_WINDOW
            for r in conn.execute(SIG_SQL, (floor,)):
                sig = tuple(r)
                if sigs.get(r[0]) != sig:
                    sigs[r[0]] = sig
                    changed.append(r[0])
                top = max(top, r[0])
            for k in [k for k in sigs if k <= top - WATCH_WINDOW]:
                del sigs[k]
            if changed:
                msgs = fetch_messages("m.ROWID IN (%s)" % ",".join("?" * len(changed)), changed, order="ASC")
                if msgs:
                    emit({"event": "messages", "messages": msgs})
        except sqlite3.Error as e:
            sys.stderr.write("watcher: %s\n" % e)
            sys.stderr.flush()
            time.sleep(2)


def tidy_outbox():
    cutoff = time.time() - 2 * 86400
    for d in glob.glob(os.path.join(OUTBOX, "*")):
        try:
            if os.path.getmtime(d) < cutoff:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


def main():
    tidy_outbox()
    threading.Thread(target=watcher, name="watcher", daemon=True).start()
    pool = ThreadPoolExecutor(max_workers=4)
    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line.decode("utf-8"))
        except ValueError:
            continue
        pool.submit(handle, req)
    os._exit(0)


main()
