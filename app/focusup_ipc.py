"""Local link between the desktop app and the native messaging host (which Brave starts).

The app listens on 127.0.0.1 (random port). Connections must pass multiprocessing's
HMAC handshake using a random key stored in %LOCALAPPDATA%\\FocusUp\\ipc.json, which only
your Windows account can read. Messages are JSON bytes (never pickle).
"""
import json
import os
import queue
import secrets
import threading
from multiprocessing.connection import Listener

DATA_DIR = os.environ.get('FOCUSUP_DATA_DIR') or os.path.join(os.environ.get('LOCALAPPDATA', '.'), 'FocusUp')
IPC_FILE = os.path.join(DATA_DIR, 'ipc.json')
MIRROR_FILE = os.path.join(DATA_DIR, 'mirror.json')


def load_mirror():
    """Last (sessions, projects) received from the extension, so the app works offline.

    Older mirror files were just a list of sessions; those still load.
    """
    try:
        with open(MIRROR_FILE, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return [], []
    if isinstance(data, list):
        return data, []
    if isinstance(data, dict):
        sessions, projects = data.get('sessions'), data.get('projects')
        return (sessions if isinstance(sessions, list) else []), (projects if isinstance(projects, list) else [])
    return [], []


def save_mirror(sessions, projects):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = MIRROR_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'sessions': sessions, 'projects': projects}, f)
    os.replace(tmp, MIRROR_FILE)


class AppServer(threading.Thread):
    """Accepts the host's connection and turns traffic into events on `self.events`.

    Events: ('connected', None), ('disconnected', None), ('payload', dict).
    """

    def __init__(self):
        super().__init__(daemon=True)
        self.events = queue.Queue()
        self._lock = threading.Lock()
        self._conn = None
        key = secrets.token_bytes(32)
        self._listener = Listener(('127.0.0.1', 0), authkey=key)
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(IPC_FILE, 'w', encoding='utf-8') as f:
            json.dump({'port': self._listener.address[1], 'key': key.hex()}, f)
        self._closed = False

    def run(self):
        while not self._closed:
            try:
                conn = self._listener.accept()  # includes the key handshake
            except Exception:
                if self._closed:
                    return
                continue  # failed handshake or dropped client: keep listening
            with self._lock:
                old, self._conn = self._conn, conn
            if old:
                try:
                    old.close()
                except OSError:
                    pass
            self.events.put(('connected', None))
            threading.Thread(target=self._read, args=(conn,), daemon=True).start()

    def _read(self, conn):
        try:
            while True:
                self.events.put(('payload', json.loads(conn.recv_bytes().decode('utf-8'))))
        except (EOFError, OSError, ValueError):
            pass
        with self._lock:
            current = self._conn is conn
            if current:
                self._conn = None
        if current:
            self.events.put(('disconnected', None))

    def send(self, payload):
        with self._lock:
            conn = self._conn
            if conn is None:
                return False
            try:
                conn.send_bytes(json.dumps(payload).encode('utf-8'))
                return True
            except OSError:
                return False

    def close(self):
        self._closed = True
        with self._lock:
            conn, self._conn = self._conn, None
        for closable in (conn, self._listener):
            try:
                if closable:
                    closable.close()
            except OSError:
                pass
        try:
            os.remove(IPC_FILE)
        except OSError:
            pass
