"""Focus Up companion: Chrome/Brave native messaging host for Windows.

The extension sends {"type": "sync", "active": bool, "blockedApps": [...]}.
  active=True : turn Windows notification banners off (remembering the old value)
                and politely close blocklisted apps.
  active=False: put notifications back exactly as they were.
The message is idempotent, so the extension can repeat it (it does, every minute).

Standard library only. Run `python host.py --status` or `--restore` by hand.
Test overrides: FOCUSUP_DATA_DIR, FOCUSUP_REG_PATH, FOCUSUP_DRYRUN=1.
"""
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time
import winreg

DATA_DIR = os.environ.get('FOCUSUP_DATA_DIR') or os.path.join(os.environ.get('LOCALAPPDATA', '.'), 'FocusUp')
# "Get notifications from apps and other senders" (Settings > System > Notifications).
REG_PATH = os.environ.get('FOCUSUP_REG_PATH') or r'Software\Microsoft\Windows\CurrentVersion\PushNotifications'
REG_VALUE = 'ToastEnabled'
DRY_RUN = os.environ.get('FOCUSUP_DRYRUN') == '1'
STATE_FILE = os.path.join(DATA_DIR, 'state.json')
IPC_FILE = os.path.join(DATA_DIR, 'ipc.json')  # written by the desktop app: its port and key
LOG_FILE = os.path.join(DATA_DIR, 'host.log')

# Never closed, whatever the blocklist says. Lower-case.
PROTECTED = {
    'discord.exe', 'discordptb.exe', 'discordcanary.exe', 'discorddevelopment.exe', 'update.exe',
    'brave.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe',
    'spotify.exe',
    'explorer.exe', 'dwm.exe', 'winlogon.exe', 'csrss.exe', 'wininit.exe', 'services.exe',
    'lsass.exe', 'svchost.exe', 'system', 'taskmgr.exe', 'cmd.exe', 'powershell.exe',
    'pwsh.exe', 'conhost.exe', 'python.exe', 'pythonw.exe', 'windowsterminal.exe', 'code.exe',
}
APP_NAME = re.compile(r'^[A-Za-z0-9._ -]{1,64}\.exe$')
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def log(msg):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(msg + '\n')
    except OSError:
        pass


# ---------- persisted state: survives host exits and crashes ----------

def load_state():
    try:
        with open(STATE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {'applied': False, 'previous': None}


def save_state(state):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = STATE_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


# ---------- notifications ----------

def read_toasts():
    """Current value, or None if the value doesn't exist (Windows treats that as on)."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH, 0, winreg.KEY_READ) as k:
            return winreg.QueryValueEx(k, REG_VALUE)[0]
    except FileNotFoundError:
        return None


def write_toasts(value):
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, REG_PATH, 0, winreg.KEY_SET_VALUE) as k:
        if value is None:
            try:
                winreg.DeleteValue(k, REG_VALUE)
            except FileNotFoundError:
                pass
        else:
            winreg.SetValueEx(k, REG_VALUE, 0, winreg.REG_DWORD, int(value))


def notifications_off():
    state = load_state()
    if not state['applied']:
        # Save what to restore BEFORE changing anything, so a crash can't lose it.
        save_state({'applied': True, 'previous': read_toasts()})
    write_toasts(0)


def notifications_restore():
    state = load_state()
    if not state['applied']:
        return False
    write_toasts(state['previous'])
    save_state({'applied': False, 'previous': None})
    return True


# ---------- apps ----------

def is_running(name):
    out = subprocess.run(['tasklist', '/FI', f'IMAGENAME eq {name}', '/FO', 'CSV', '/NH'],
                         capture_output=True, text=True, creationflags=NO_WINDOW).stdout
    return name.lower() in out.lower()


def close_apps(names):
    closed, skipped = [], []
    for raw in names:
        name = str(raw).strip()
        if not APP_NAME.match(name):
            skipped.append(f'{name or "(empty)"}: not a valid .exe name')
        elif name.lower() in PROTECTED:
            skipped.append(f'{name}: protected, never closed')
        elif is_running(name):
            if not DRY_RUN:
                # No /F: a polite close request, so apps can ask to save work.
                subprocess.run(['taskkill', '/IM', name], capture_output=True, creationflags=NO_WINDOW)
            closed.append(name)
    return closed, skipped


# ---------- desktop app launcher ----------

APP_SCRIPT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'focusup_app.py'))


def open_app():
    """Start the desktop app (a second launch just brings the existing window forward)."""
    if not os.path.exists(APP_SCRIPT):
        return {'ok': False, 'error': 'The desktop app was not found next to the companion.'}
    pythonw = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')  # no console window
    cmd = [pythonw if os.path.exists(pythonw) else sys.executable, APP_SCRIPT]
    if DRY_RUN:
        return {'ok': True, 'command': cmd}
    flags = 0x00000008 | 0x00000200 | NO_WINDOW  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    subprocess.Popen(cmd, creationflags=flags, close_fds=True, cwd=os.path.dirname(APP_SCRIPT),
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {'ok': True}


# ---------- protocol ----------

def sync(msg):
    if msg.get('active'):
        notifications_off()
        apps = msg.get('blockedApps')
        closed, skipped = close_apps(apps if isinstance(apps, list) else [])
        return {'ok': True, 'active': True, 'notificationsOff': True, 'closed': closed, 'skipped': skipped}
    restored = notifications_restore()
    return {'ok': True, 'active': False, 'notificationsOff': False, 'restored': restored}


def handle(msg):
    kind = msg.get('type')
    if kind == 'sync':
        return sync(msg)
    if kind == 'open-app':
        return open_app()
    if kind == 'status':
        state = load_state()
        return {'ok': True, 'applied': state['applied'], 'toastEnabled': read_toasts(), 'version': 1}
    return {'ok': False, 'error': 'unknown message type'}


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack('<I', header)
    return json.loads(sys.stdin.buffer.read(length).decode('utf-8'))


def write_message(obj):
    data = json.dumps(obj).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)) + data)
    sys.stdout.buffer.flush()


# ---------- bridge: extension <-> desktop app ----------
# The extension holds a long-lived connection (connectNative) and sends {"type": "bridge-hello"}
# first. After that every {"type": "app", "payload": ...} goes to the desktop app, and whatever
# the app sends comes back to the extension the same way. If the app isn't running the host keeps
# retrying; when it connects, it asks the extension to resend its current state.

def run_bridge():
    from multiprocessing.connection import Client
    lock = threading.Lock()  # guards `conn` and stdout
    conn = [None]

    def to_extension(payload):
        with lock:
            write_message({'type': 'app', 'payload': payload})

    def read_from_app(c):
        try:
            while True:
                to_extension(json.loads(c.recv_bytes().decode('utf-8')))
        except (EOFError, OSError, ValueError):
            pass
        with lock:
            if conn[0] is c:
                conn[0] = None

    def connect_loop():
        while True:
            if conn[0] is None:
                try:
                    with open(IPC_FILE, encoding='utf-8') as f:
                        info = json.load(f)
                    c = Client(('127.0.0.1', int(info['port'])), authkey=bytes.fromhex(info['key']))
                    with lock:
                        conn[0] = c
                    threading.Thread(target=read_from_app, args=(c,), daemon=True).start()
                    to_extension({'type': 'request-sync'})
                except Exception:
                    pass  # app not running (or stale file): try again shortly
            time.sleep(2)

    threading.Thread(target=connect_loop, daemon=True).start()
    while True:
        msg = read_message()
        if msg is None:
            break  # the browser closed the connection
        if msg.get('type') != 'app':
            continue
        with lock:
            c = conn[0]
            if c is not None:
                try:
                    c.send_bytes(json.dumps(msg['payload']).encode('utf-8'))
                except OSError:
                    conn[0] = None
    os._exit(0)


def main():
    if '--restore' in sys.argv:
        print('restored' if notifications_restore() else 'nothing to restore')
        return
    if '--status' in sys.argv:
        print(json.dumps(handle({'type': 'status'})))
        return
    while True:
        try:
            msg = read_message()
            if msg is None:
                break
            if msg.get('type') == 'bridge-hello':
                run_bridge()
                break
            write_message(handle(msg))
        except Exception as e:  # never crash silently: tell the extension and log it
            log(f'error: {e!r}')
            try:
                write_message({'ok': False, 'error': str(e)})
            except Exception:
                pass
            break


if __name__ == '__main__':
    main()
