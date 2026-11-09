"""iMassage: iMessage / SMS from this PC, sent and received through a Mac's Messages app.

    Electron window  <--HTTP + SSE, 127.0.0.1:8766-->  server.py  <--one SSH session-->  mac_agent.py on the Mac

The agent is streamed over SSH at connect time (nothing installed on the Mac), reads chat.db and the
AddressBook read-only, pushes new/changed messages as they land, and sends with AppleScript.

Started at logon by the scheduled task "iMassage Server" (install.ps1); iMassage.pyw opens the window.
Logs: logs\\server.log. Attachment and photo cache: cache\\. Seen-markers for unread counts: state.json.
"""
from __future__ import annotations

import asyncio
import base64
import collections
import itertools
import json
import logging
import logging.handlers
import re
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import Future
from contextlib import asynccontextmanager
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOG_DIR = HERE / "logs"
LOG_DIR.mkdir(exist_ok=True)

# Under pythonw there is no console: point stdout/stderr at the log so uvicorn can start.
if sys.stdout is None or sys.stderr is None:
    _fh = open(LOG_DIR / "server.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115
    sys.stdout = sys.stdout or _fh
    sys.stderr = sys.stderr or _fh

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

CFG = {"mac_host": "", "ssh_key": str(Path.home() / ".ssh" / "id_ed25519"),
       "port": 8766, "chat_limit": 300}
if (HERE / "config.json").exists():
    CFG.update(json.loads((HERE / "config.json").read_text(encoding="utf-8")))
PORT = int(CFG["port"])
CACHE = HERE / "cache"
STATE_FILE = HERE / "state.json"

log = logging.getLogger("imassage")
log.setLevel(logging.INFO)
_handler = logging.handlers.RotatingFileHandler(LOG_DIR / "server.log", maxBytes=1_000_000, backupCount=3,
                                                encoding="utf-8")
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S"))
log.addHandler(_handler)

BOOT = "exec /usr/bin/python3 -u -c 'import sys;b=sys.stdin.buffer;exec(b.read(int(b.readline())))'"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class AgentError(Exception):
    """The agent ran the op and reported a failure (message is meant for the user)."""


class MacLink:
    """One long-lived SSH session to the agent, re-established whenever it drops."""

    def __init__(self, on_event, on_status):
        self.on_event, self.on_status = on_event, on_status
        self.proc: subprocess.Popen | None = None
        self.pending: dict[int, Future] = {}
        self.ids = itertools.count(1)
        self.lock = threading.Lock()
        self.connected = threading.Event()
        self.info: dict = {}
        self.error: str | None = "connecting"
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=6)

    def start(self) -> None:
        threading.Thread(target=self._supervise, name="maclink", daemon=True).start()

    def submit(self, op: str, args: dict) -> Future:
        fut: Future = Future()
        with self.lock:
            proc = self.proc
            if proc is None or proc.poll() is not None:
                raise ConnectionError(self.error or "Mac not connected")
            rid = next(self.ids)
            self.pending[rid] = fut
            try:
                proc.stdin.write((json.dumps({"id": rid, "op": op, "args": args}) + "\n").encode("ascii"))
                proc.stdin.flush()
            except OSError as e:
                self.pending.pop(rid, None)
                raise ConnectionError(f"Mac link write failed: {e}") from e
        return fut

    def reconnect(self) -> None:
        proc = self.proc
        if proc and proc.poll() is None:
            proc.kill()

    def _supervise(self) -> None:
        delay = 1
        while True:
            started = time.time()
            try:
                self._session()
            except Exception as e:  # noqa: BLE001
                self.error = str(e) or type(e).__name__
                log.warning("mac link down: %s", self.error)
            self.connected.clear()
            self.on_status()
            if time.time() - started > 60:
                delay = 1
            time.sleep(delay)
            delay = min(delay * 2, 30)

    def _session(self) -> None:
        if not CFG["mac_host"]:
            raise RuntimeError("set mac_host (user@your-mac.local) in config.json, then restart the server")
        code = (HERE / "mac_agent.py").read_bytes()
        cmd = ["ssh", "-i", CFG["ssh_key"], "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
               "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", CFG["mac_host"], BOOT]
        self.stderr_tail.clear()
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                creationflags=NO_WINDOW)
        with self.lock:
            self.proc = proc
        try:
            threading.Thread(target=self._read_stderr, args=(proc,), daemon=True).start()
            reader = threading.Thread(target=self._read, args=(proc,), daemon=True)
            reader.start()
            proc.stdin.write(b"%d\n" % len(code) + code)
            proc.stdin.flush()
            self.info = self.submit("hello", {}).result(timeout=20)
            self.error = None
            self.connected.set()
            log.info("mac link up: %s", self.info)
            self.on_status()
            proc.wait()
            reader.join(5)
            raise ConnectionError(self._tail() or f"ssh exited ({proc.returncode})")
        finally:
            if proc.poll() is None:
                proc.kill()

    def _tail(self) -> str:
        lines = [ln for ln in self.stderr_tail if ln and not ln.startswith(("Traceback", "  File"))]
        return lines[-1] if lines else ""

    def _read(self, proc: subprocess.Popen) -> None:
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                log.warning("agent said: %r", line[:300])
                continue
            if "id" in msg:
                with self.lock:
                    fut = self.pending.pop(msg["id"], None)
                if fut and not fut.done():
                    if msg.get("ok"):
                        fut.set_result(msg.get("result"))
                    else:
                        fut.set_exception(AgentError(msg.get("error") or "failed on the Mac"))
            elif "event" in msg:
                try:
                    self.on_event(msg)
                except Exception:  # noqa: BLE001
                    log.exception("event handler failed")
        with self.lock:
            pending, self.pending = self.pending, {}
        err = ConnectionError(self._tail() or "Mac link closed")
        for fut in pending.values():
            if not fut.done():
                fut.set_exception(err)

    def _read_stderr(self, proc: subprocess.Popen) -> None:
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self.stderr_tail.append(line)
                log.warning("mac: %s", line)


# --- contacts ---------------------------------------------------------------------------------

def phone_key(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    return digits[-10:] if len(digits) >= 10 else digits


def handle_key(handle: str | None) -> str:
    if not handle:
        return ""
    return handle.strip().lower() if "@" in handle else phone_key(handle)


def pretty_handle(handle: str | None) -> str:
    if not handle:
        return "Unknown"
    if "@" in handle:
        return handle
    d = re.sub(r"\D", "", handle)
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    if len(d) == 10:
        return f"({d[:3]}) {d[3:6]}-{d[6:]}"
    return handle


def canonical_handle(raw: str) -> str:
    """What AppleScript should address: +1XXXXXXXXXX for US numbers, emails as typed."""
    raw = raw.strip()
    if "@" in raw:
        return raw.lower()
    d = re.sub(r"\D", "", raw)
    if len(d) == 10:
        return "+1" + d
    if len(d) == 11 and d.startswith("1"):
        return "+" + d
    return ("+" + d) if raw.startswith("+") else d


class Directory:
    def __init__(self):
        self.people: list[dict] = []
        self.index: dict[str, dict] = {}

    def load(self, people: list[dict]) -> None:
        index = {}
        for p in people:
            for ph in p["phones"]:
                index.setdefault(phone_key(ph), p)
            for em in p["emails"]:
                index.setdefault(em.strip().lower(), p)
        self.people, self.index = people, index

    def person(self, handle: str | None) -> dict | None:
        return self.index.get(handle_key(handle)) if handle else None

    def member(self, handle: str) -> dict:
        p = self.person(handle)
        return {"handle": handle, "label": pretty_handle(handle), "name": p["name"] if p else pretty_handle(handle),
                "first": p["first"] if p else pretty_handle(handle),
                "photo": f"/api/photo/{p['key']}" if p and p["photo"] else None, "known": bool(p)}


DIRECTORY = Directory()


# --- state, events ----------------------------------------------------------------------------

def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"seen": {}}


STATE = load_state()
STATE_LOCK = threading.Lock()
LOOP: asyncio.AbstractEventLoop | None = None
CLIENTS: set[asyncio.Queue] = set()


def save_state() -> None:
    with STATE_LOCK:
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(STATE), encoding="utf-8")
        tmp.replace(STATE_FILE)


def _broadcast(payload: str) -> None:
    for q in list(CLIENTS):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            pass


def publish(obj: dict) -> None:
    if LOOP is not None:
        LOOP.call_soon_threadsafe(_broadcast, json.dumps(obj))


def enrich(m: dict) -> dict:
    if not m.get("fromMe") and m.get("handle"):
        mem = DIRECTORY.member(m["handle"])
        m["sender"], m["senderFirst"], m["senderPhoto"] = mem["name"], mem["first"], mem["photo"]
    if m.get("other"):
        m["otherName"] = DIRECTORY.member(m["other"])["name"]
    return m


def status() -> dict:
    return {"type": "status", "connected": LINK.connected.is_set(), "error": LINK.error,
            "mac": LINK.info, "contacts": len(DIRECTORY.people)}


def on_event(evt: dict) -> None:
    if evt.get("event") == "messages":
        publish({"type": "messages", "messages": [enrich(m) for m in evt["messages"]]})


def load_contacts() -> None:
    try:
        DIRECTORY.load(LINK.submit("contacts", {}).result(timeout=60))
        log.info("contacts: %d", len(DIRECTORY.people))
        publish(status())
    except Exception as e:  # noqa: BLE001
        log.warning("contacts load failed: %s", e)


def on_status() -> None:
    publish(status())
    if LINK.connected.is_set():
        threading.Thread(target=load_contacts, daemon=True).start()


LINK = MacLink(on_event, on_status)


async def call(op: str, timeout: float = 30, **args):
    if not LINK.connected.is_set():
        await asyncio.to_thread(LINK.connected.wait, 6)
    try:
        fut = LINK.submit(op, args)
    except ConnectionError as e:
        raise HTTPException(503, f"Mac not connected: {e}") from e
    try:
        return await asyncio.wait_for(asyncio.wrap_future(fut), timeout)
    except asyncio.TimeoutError as e:
        raise HTTPException(504, f"The Mac took too long ({op})") from e
    except AgentError as e:
        raise HTTPException(502, str(e)) from e
    except ConnectionError as e:
        raise HTTPException(503, f"Mac link dropped: {e}") from e


# --- app --------------------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    global LOOP
    LOOP = asyncio.get_running_loop()
    for sub in ("att", "photos"):
        (CACHE / sub).mkdir(parents=True, exist_ok=True)
    week_ago = time.time() - 7 * 86400
    for f in (CACHE / "photos").glob("*"):
        if f.stat().st_mtime < week_ago:
            f.unlink(missing_ok=True)
    LINK.start()
    sched = asyncio.create_task(scheduler())
    log.info("server up on 127.0.0.1:%d", PORT)
    yield
    sched.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


class Guard:
    """Only this machine's own pages may drive the server: the Host header must be ours (no DNS
    rebinding) and anything that changes state needs a same-origin custom header (no CSRF)."""

    def __init__(self, inner):
        self.inner = inner
        self.hosts = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
        self.origins = {f"http://{h}" for h in self.hosts}

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
            ok = headers.get("host") in self.hosts
            if ok and scope["method"] not in ("GET", "HEAD"):
                ok = headers.get("x-imassage") == "1" and headers.get("origin", next(iter(self.origins))) in self.origins
            if not ok:
                await send({"type": "http.response.start", "status": 403,
                            "headers": [(b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"forbidden"})
                return
        await self.inner(scope, receive, send)


app.add_middleware(Guard)


def chat_view(c: dict) -> dict:
    members = [DIRECTORY.member(h) for h in c["members"]]
    if c["displayName"]:
        name = c["displayName"]
    elif not c["group"]:
        name = members[0]["name"] if members else pretty_handle(c["identifier"])
    else:
        firsts = [m["first"] for m in members]
        name = ", ".join(firsts[:3]) + (f" & {len(firsts) - 3} more" if len(firsts) > 3 else "") or "Group"
    seen = STATE["seen"].get(str(c["id"]), 0)
    pins = STATE.get("pins") or []
    return {"id": c["id"], "guid": c["guid"], "name": name, "group": c["group"], "service": c["service"],
            "identifier": c["identifier"], "members": members, "filtered": c["filtered"],
            "lastDate": c["lastDate"], "last": enrich(c["last"]) if c["last"] else None,
            "unread": [r for r in c["unread"] if r > seen],
            "pin": pins.index(c["id"]) if c["id"] in pins else None}


async def seed_pins(chats: list[dict]) -> None:
    """First run: pin the six busiest conversations of the last 60 days, like a phone that's been
    used for a while. Only when nothing was ever pinned; an emptied pin list stays empty."""
    if "pins" in STATE:
        return
    busy = await call("activity", days=60, limit=30)
    ok = {c["id"] for c in chats if c["filtered"] != 2}
    with STATE_LOCK:
        STATE["pins"] = [cid for cid, _n in busy if cid in ok][:6]
    await asyncio.to_thread(save_state)


@app.get("/api/status")
async def api_status():
    return status()


@app.post("/api/reconnect")
async def api_reconnect():
    LINK.reconnect()
    return {"ok": True}


@app.get("/api/chats")
async def api_chats(limit: int = 0):
    limit = min(max(limit, int(CFG["chat_limit"])), 3000)  # the sidebar asks for more as you scroll
    chats = await call("chats", timeout=60, limit=limit, include=STATE.get("pins") or [])
    await seed_pins(chats)
    return [chat_view(c) for c in chats]


@app.post("/api/pins")
async def api_pins(request: Request):
    pins = [int(x) for x in (await request.json()).get("pins", [])][:12]
    with STATE_LOCK:
        STATE["pins"] = list(dict.fromkeys(pins))
    await asyncio.to_thread(save_state)
    return {"pins": STATE["pins"]}


@app.get("/api/chats/{chat_id}/media")
async def api_media(chat_id: int, limit: int = 90):
    return await call("media", chat=chat_id, limit=min(limit, 300))


@app.get("/api/chats/{chat_id}/messages")
async def api_messages(chat_id: int, before: int | None = None, limit: int = 60):
    r = await call("messages", chat=chat_id, before=before, limit=min(limit, 200))
    r["messages"] = [enrich(m) for m in r["messages"]]
    r["reactions"] = [enrich(m) for m in r["reactions"]]
    return r


@app.get("/api/lookup")
async def api_lookup(guids: str):
    return [enrich(m) for m in await call("message", guids=[g for g in guids.split(",") if g][:50])]


@app.post("/api/chats/{chat_id}/seen")
async def api_seen(chat_id: int, request: Request):
    rowid = int((await request.json()).get("rowid", 0))
    with STATE_LOCK:
        key = str(chat_id)
        changed = rowid > STATE["seen"].get(key, 0)
        if changed:
            STATE["seen"][key] = rowid
    if changed:
        await asyncio.to_thread(save_state)
    return {"ok": True}


@app.get("/api/search")
async def api_search(q: str, chat: int | None = None):
    return [enrich(m) for m in await call("search", q=q, chat=chat, limit=300 if chat else 80)]


@app.post("/api/react")
async def api_react(request: Request):
    b = await request.json()
    if not b.get("chat") or not b.get("target") or not b.get("kind"):
        raise HTTPException(400, "chat, target and kind are required")
    await call("react", timeout=60, chat=b["chat"], target=b["target"], kind=b["kind"],
               remove=bool(b.get("remove")), text=b.get("text") or "")
    log.info("tapback %s%s on %s", "un-" if b.get("remove") else "", b["kind"], b["chat"])
    return {"ok": True}


@app.post("/api/edit")
async def api_edit(request: Request):
    b = await request.json()
    text = (b.get("text") or "").rstrip()
    if not b.get("chat") or not b.get("target") or not text:
        raise HTTPException(400, "chat, target and text are required")
    await call("edit", timeout=60, chat=b["chat"], target=b["target"], text=text, old=b.get("old") or "")
    log.info("edited a message in %s", b["chat"])
    return {"ok": True}


@app.post("/api/unsend")
async def api_unsend(request: Request):
    b = await request.json()
    if not b.get("chat") or not b.get("target"):
        raise HTTPException(400, "chat and target are required")
    await call("unsend", timeout=60, chat=b["chat"], target=b["target"], text=b.get("text") or "")
    log.info("unsent a message in %s", b["chat"])
    return {"ok": True}


# --- send later: held here and sent by this PC at the time (so it has to be on) -------------------

def scheduled_view() -> list[dict]:
    with STATE_LOCK:
        return sorted((dict(x) for x in STATE.get("scheduled", [])), key=lambda x: x["at"])


def publish_scheduled() -> None:
    publish({"type": "scheduled", "items": scheduled_view()})


@app.get("/api/scheduled")
async def api_scheduled():
    return scheduled_view()


@app.post("/api/scheduled")
async def api_schedule(request: Request):
    b = await request.json()
    text = (b.get("text") or "").rstrip()
    at = int(b.get("at") or 0)
    if not b.get("chat") or not text:
        raise HTTPException(400, "chat and text are required")
    if at < time.time() * 1000 + 30_000:
        raise HTTPException(400, "Pick a time at least a minute from now.")
    item = {"id": uuid.uuid4().hex[:12], "chat": b["chat"], "chatId": b.get("chatId"), "text": text, "at": at}
    with STATE_LOCK:
        STATE.setdefault("scheduled", []).append(item)
    await asyncio.to_thread(save_state)
    publish_scheduled()
    log.info("scheduled a message to %s for %s", b["chat"], time.strftime("%Y-%m-%d %H:%M", time.localtime(at / 1000)))
    return item


@app.delete("/api/scheduled/{sid}")
async def api_unschedule(sid: str):
    with STATE_LOCK:
        STATE["scheduled"] = [x for x in STATE.get("scheduled", []) if x["id"] != sid]
    await asyncio.to_thread(save_state)
    publish_scheduled()
    return {"ok": True}


async def scheduler() -> None:
    while True:
        await asyncio.sleep(5)
        now = time.time() * 1000
        for item in [x for x in scheduled_view() if x["at"] <= now and not x.get("error")]:
            try:
                await call("send", timeout=90, chat=item["chat"], text=item["text"], files=[])
                with STATE_LOCK:
                    STATE["scheduled"] = [x for x in STATE.get("scheduled", []) if x["id"] != item["id"]]
                log.info("sent scheduled message to %s", item["chat"])
            except HTTPException as e:
                if e.status_code in (503, 504) and now - item["at"] < 3600_000:
                    continue  # Mac briefly unreachable: keep trying for an hour
                with STATE_LOCK:
                    for x in STATE.get("scheduled", []):
                        if x["id"] == item["id"]:
                            x["error"] = str(e.detail)
                log.warning("scheduled send failed: %s", e.detail)
            await asyncio.to_thread(save_state)
            publish_scheduled()


@app.get("/api/contacts")
async def api_contacts():
    out = []
    for p in DIRECTORY.people:
        handles = [{"value": canonical_handle(x), "label": pretty_handle(x)} for x in p["phones"]]
        handles += [{"value": x.strip().lower(), "label": x.strip()} for x in p["emails"]]
        out.append({"name": p["name"], "photo": f"/api/photo/{p['key']}" if p["photo"] else None,
                    "handles": handles})
    return sorted(out, key=lambda p: p["name"].lower())


@app.post("/api/send")
async def api_send(request: Request):
    body = await request.json()
    text = (body.get("text") or "").rstrip()
    files = body.get("files") or []
    if not text and not files:
        raise HTTPException(400, "Nothing to send")
    paths = [await call("put_file", timeout=180, name=f["name"], data=f["data"]) for f in files]
    to = canonical_handle(body["to"]) if body.get("to") else None
    await call("send", timeout=90, chat=body.get("chat"), to=to, service=body.get("service"),
               text=text, files=paths)
    log.info("sent to %s (%d chars, %d files)", body.get("chat") or to, len(text), len(paths))
    return {"ok": True}


def _cached(stem: str):
    meta = CACHE / "att" / f"{stem}.json"
    if meta.exists():
        info = json.loads(meta.read_text(encoding="utf-8"))
        path = CACHE / "att" / f"{stem}.bin"
        if path.exists():
            return info, path
    return None, None


@app.get("/api/attachment/{aid}")
async def api_attachment(aid: int, download: int = 0, thumb: int = 0):
    stem = f"{aid}-{'o' if download else 't' if thumb else 'd'}"
    info, path = _cached(stem)
    if info is None:
        r = await call("attachment", timeout=180, id=aid, display=not download, thumb=bool(thumb and not download))
        path = CACHE / "att" / f"{stem}.bin"
        path.write_bytes(base64.b64decode(r["data"]))
        info = {"name": r["name"], "mime": r["mime"]}
        (CACHE / "att" / f"{stem}.json").write_text(json.dumps(info), encoding="utf-8")
    headers = {"Cache-Control": "private, max-age=31536000, immutable"}
    if download:
        return FileResponse(path, media_type=info["mime"], filename=info["name"], headers=headers)
    # iPhone .mov is MP4-compatible; Edge only tries to play it (H.264, anyway) when told it's MP4.
    mime = "video/mp4" if info["mime"] == "video/quicktime" else info["mime"]
    return FileResponse(path, media_type=mime, headers=headers)


@app.get("/api/photo/{key}")
async def api_photo(key: str):
    path = CACHE / "photos" / (re.sub(r"[^A-Za-z0-9_-]", "_", key) + ".jpg")
    if not path.exists():
        r = await call("photo", key=key)
        if not r:
            raise HTTPException(404, "no photo")
        path.write_bytes(base64.b64decode(r["data"]))
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/events")
async def api_events(request: Request):
    q: asyncio.Queue = asyncio.Queue(maxsize=2000)
    CLIENTS.add(q)

    async def stream():
        try:
            yield f"data: {json.dumps(status())}\n\n"
            while True:  # ends when Starlette cancels us on disconnect
                try:
                    yield f"data: {await asyncio.wait_for(q.get(), timeout=15)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            CLIENTS.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


app.mount("/", StaticFiles(directory=HERE / "web", html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
