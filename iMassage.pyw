"""Open iMassage. The app is runtime\\iMassage.exe (Electron); this just starts it, for anything that
still points here. A running copy comes to the front instead of opening a second one."""
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXE = HERE / "runtime" / "iMassage.exe"

if EXE.exists():
    subprocess.Popen([str(EXE)], cwd=EXE.parent, close_fds=True)
else:
    import os
    os.startfile("http://127.0.0.1:8766/")  # runtime missing: run install.ps1; the browser UI still works
