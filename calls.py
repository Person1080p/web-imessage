"""Call pass-through for web-imessage.

Phone (via iPhone) and FaceTime calls run on the Mac; this module moves their audio (and the
FaceTime window's video) to the browser and the browser's microphone back into the call:

  call audio  -> default output "BlackHole 2ch"  -> callbridge audio -> WebSocket -> browser speakers
  browser mic -> WebSocket -> callbridge audio -> "BlackHole 16ch" (default input) -> the call

`callbridge watch` follows the call UI through Accessibility to report ringing/active/idle and to
press Accept / Decline / End / Call. Browsers only allow microphone access on https, so this module
also creates a small local certificate authority and an https certificate for the server.
"""
import base64
import hashlib
import json
import os
import re
import struct
import subprocess
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
HELPER = os.environ.get('WEBIM_CALL_HELPER') or os.path.join(ROOT, 'bridge', 'callbridge')
RATE = 24000
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


# ---------------------------------------------------------------- TLS

CA_CONFIG = """[req]
distinguished_name = dn
prompt = no
[dn]
CN = web-imessage
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
"""


def local_hostnames():
    names = {'localhost'}
    try:
        bonjour = subprocess.run(['scutil', '--get', 'LocalHostName'], capture_output=True, text=True, timeout=5).stdout.strip()
        if bonjour:
            names.update({bonjour, bonjour + '.local'})
    except (OSError, subprocess.SubprocessError):
        pass
    import socket
    host = socket.gethostname()
    if host:
        names.add(host)
        names.add(host if host.endswith('.local') else host + '.local')
    return sorted(names)


def ensure_tls(tls_dir, ips):
    """Create (once) a local CA and (whenever the Mac's names/IPs change) a server certificate it signs."""
    os.makedirs(tls_dir, exist_ok=True)
    os.chmod(tls_dir, 0o700)
    p = lambda name: os.path.join(tls_dir, name)

    def openssl(*args):
        subprocess.run(['openssl'] + list(args), check=True, capture_output=True, timeout=60)

    with open(p('openssl.cnf'), 'w') as f:
        f.write(CA_CONFIG)
    names = local_hostnames()
    if not (os.path.exists(p('ca.key')) and os.path.exists(p('ca.crt'))):
        openssl('genrsa', '-out', p('ca.key'), '2048')
        openssl('req', '-x509', '-new', '-key', p('ca.key'), '-sha256', '-days', '3650', '-config', p('openssl.cnf'),
                '-extensions', 'v3_ca', '-subj', '/CN=web-imessage on %s' % names[0], '-out', p('ca.crt'))
        for stale in ('server.crt', 'sans.txt'):
            if os.path.exists(p(stale)):
                os.remove(p(stale))
    sans = ','.join(['DNS:' + n for n in names] + ['IP:' + ip for ip in sorted(set(['127.0.0.1'] + list(ips)))])
    current = open(p('sans.txt')).read() if os.path.exists(p('sans.txt')) else ''
    if current != sans or not os.path.exists(p('server.crt')):
        with open(p('server.ext'), 'w') as f:
            f.write('basicConstraints = CA:FALSE\nkeyUsage = critical, digitalSignature, keyEncipherment\n'
                    'extendedKeyUsage = serverAuth\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid\n'
                    'subjectAltName = %s\n' % sans)
        openssl('genrsa', '-out', p('server.key'), '2048')
        openssl('req', '-new', '-key', p('server.key'), '-config', p('openssl.cnf'), '-subj', '/CN=%s' % names[-1], '-out', p('server.csr'))
        openssl('x509', '-req', '-in', p('server.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial',
                '-days', '820', '-sha256', '-extfile', p('server.ext'), '-out', p('server.crt'))
        with open(p('sans.txt'), 'w') as f:
            f.write(sans)
    for key in ('ca.key', 'server.key'):
        os.chmod(p(key), 0o600)
    return p('server.crt'), p('server.key'), p('ca.crt')


# ---------------------------------------------------------------- WebSocket (RFC 6455, server side)

class WebSocket:
    def __init__(self, rfile, wfile):
        self.rfile, self.wfile = rfile, wfile
        self.lock = threading.Lock()
        self.closed = False

    @classmethod
    def accept(cls, handler):
        h = handler.headers
        key = h.get('Sec-WebSocket-Key')
        if 'websocket' not in (h.get('Upgrade') or '').lower() or not key:
            return None
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        handler.wfile.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                             'Sec-WebSocket-Accept: %s\r\n\r\n' % accept).encode())
        handler.close_connection = True
        return cls(handler.rfile, handler.wfile)

    def _read(self, n):
        data = self.rfile.read(n)
        if len(data) < n:
            raise ConnectionError('websocket closed')
        return data

    def recv(self):
        """Returns (opcode, payload) for a complete text/binary message, or None once closed."""
        message, first_op = b'', None
        while True:
            try:
                b1, b2 = self._read(2)
                n = b2 & 0x7F
                if n == 126:
                    n = struct.unpack('>H', self._read(2))[0]
                elif n == 127:
                    n = struct.unpack('>Q', self._read(8))[0]
                if n > 16 * 1024 * 1024:
                    raise ConnectionError('frame too large')
                mask = self._read(4) if b2 & 0x80 else None
                payload = self._read(n)
            except (ConnectionError, OSError, ValueError):
                self.closed = True
                return None
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload)) if n < 64 else _unmask(payload, mask)
            op = b1 & 0x0F
            if op == 0x8:
                self.close()
                return None
            if op == 0x9:
                self.send(payload, 0xA)
                continue
            if op == 0xA:
                continue
            if op != 0x0:
                first_op, message = op, payload
            else:
                message += payload
            if b1 & 0x80:
                return first_op, message

    def send(self, payload, opcode=0x2):
        if self.closed:
            return False
        if isinstance(payload, str):
            payload, opcode = payload.encode(), 0x1
        n = len(payload)
        if n < 126:
            header = struct.pack('>BB', 0x80 | opcode, n)
        elif n < 65536:
            header = struct.pack('>BBH', 0x80 | opcode, 126, n)
        else:
            header = struct.pack('>BBQ', 0x80 | opcode, 127, n)
        try:
            with self.lock:
                self.wfile.write(header + payload)
            return True
        except (OSError, ValueError):
            self.closed = True
            return False

    def close(self):
        if not self.closed:
            self.send(b'', 0x8)
        self.closed = True


def _unmask(payload, mask):
    # XOR in 8-byte words; per-byte Python loops are too slow for 50 audio frames a second.
    n = len(payload)
    m8 = int.from_bytes(mask * 2, 'little')
    whole = n - n % 8
    out = bytearray(n)
    for i in range(0, whole, 8):
        out[i:i + 8] = (int.from_bytes(payload[i:i + 8], 'little') ^ m8).to_bytes(8, 'little')
    for i in range(whole, n):
        out[i] = payload[i] ^ mask[i % 4]
    return bytes(out)


# ---------------------------------------------------------------- call manager

class CallManager:
    def __init__(self, conf_dir, notify):
        self.notify = notify  # wakes the server's event streams
        self.lock = threading.RLock()
        self.version = 0
        self.state = {'state': 'idle', 'caller': '', 'detail': '', 'since': None, 'outgoing': None}
        self.perm = {'ax': None, 'screen': None}
        self.watcher = None
        self.ws = None
        self.audio = None
        self.video = None
        self.state_file = os.path.join(conf_dir, 'audio-defaults.json')
        self.dump_ready = threading.Event()
        self.last_dump = None
        self.capture_device = 'BlackHole 2ch'
        self.mic_device = 'BlackHole 16ch'
        self._devices = (0, [])
        self._idle_timer = None

    # -- lifecycle
    def available(self):
        return os.access(HELPER, os.X_OK)

    def start(self, config):
        self.capture_device = config.get('call_capture_device', self.capture_device)
        self.mic_device = config.get('call_mic_device', self.mic_device)
        if not self.available():
            return
        if os.path.exists(self.state_file):  # a previous run died mid-call: put the Mac's audio back
            subprocess.run([HELPER, 'restore', self.state_file], timeout=10)
        if not os.environ.get('WEBIM_NO_WATCH'):
            self._spawn_watcher()

    def _spawn_watcher(self):
        try:
            p = subprocess.Popen([HELPER, 'watch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True, bufsize=1)
        except OSError as e:
            print('calls: could not start watcher:', e)
            return
        self.watcher = p
        threading.Thread(target=self._read_watcher, args=(p,), daemon=True).start()

    def _read_watcher(self, p):
        for line in p.stdout:
            try:
                self._on_event(json.loads(line))
            except ValueError:
                pass
        time.sleep(3)
        if self.watcher is p:
            self._spawn_watcher()

    def _on_event(self, ev):
        kind = ev.get('event')
        if kind == 'perm':
            changed = self.perm != {'ax': ev.get('ax'), 'screen': ev.get('screen')}
            self.perm = {'ax': ev.get('ax'), 'screen': ev.get('screen')}
            if changed:
                self._bump()
        elif kind == 'state':
            with self.lock:
                prev, new = self.state['state'], ev.get('state', 'idle')
                self.state['state'] = new
                if new == 'ringing':
                    self.state.update(caller=ev.get('caller', ''), detail=ev.get('detail', ''))
                if new == 'active' and prev != 'active':
                    self.state['since'] = time.time()
                if new == 'idle':
                    self.state.update(since=None, outgoing=None, caller='', detail='')
                    self._schedule_hangup()
            self._bump()
        elif kind == 'dump':
            self.last_dump = ev.get('tree')
            self.dump_ready.set()

    def _schedule_hangup(self):
        # The call ended on the Mac (or the other side hung up): release the audio devices shortly after.
        if self._idle_timer:
            self._idle_timer.cancel()

        def release():
            with self.lock:
                if self.state['state'] == 'idle' and not self.state['outgoing']:
                    ws, self.ws = self.ws, None
                    if ws:
                        ws.send(json.dumps({'type': 'ended'}))
                        ws.close()
                    self._stop_media()
        self._idle_timer = threading.Timer(2.5, release)
        self._idle_timer.daemon = True
        self._idle_timer.start()

    def _bump(self):
        self.version += 1
        self.notify()

    def command(self, cmd):
        p = self.watcher
        if not p or p.poll() is not None:
            return False
        try:
            p.stdin.write(cmd + '\n')
            p.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    # -- status
    def snapshot(self):
        with self.lock:
            s = dict(self.state)
        s['elapsed'] = int(time.time() - s['since']) if s.get('since') else None
        s.pop('since', None)
        s['bridged'] = self.ws is not None
        return s

    def devices(self):
        ts, devs = self._devices
        if time.time() - ts > 10 and self.available():
            try:
                devs = json.loads(subprocess.run([HELPER, 'devices'], capture_output=True, text=True, timeout=10).stdout or '[]')
            except (OSError, ValueError, subprocess.SubprocessError):
                devs = []
            self._devices = (time.time(), devs)
        return devs

    def setup(self):
        names = [d.get('name', '') for d in self.devices()]
        has = lambda want: any(n == want or want.lower() in n.lower() for n in names)
        return {
            'helper': self.available(),
            'captureDevice': self.capture_device, 'micDevice': self.mic_device,
            'hasCapture': has(self.capture_device), 'hasMic': has(self.mic_device),
            'ax': self.perm['ax'], 'screen': self.perm['screen'],
        }

    def dump(self):
        self.dump_ready.clear()
        if not self.command('dump'):
            return None
        self.dump_ready.wait(8)
        return self.last_dump

    # -- call control
    def start_call(self, handle, kind):
        scheme = {'phone': 'tel:', 'audio': 'facetime-audio:', 'video': 'facetime:'}[kind]
        target = handle.strip() if '@' in handle else re.sub(r'[^\d+*#]', '', handle)
        if not target:
            raise ValueError('missing number')
        subprocess.run(['open', scheme + target], check=True, timeout=10)
        with self.lock:
            self.state['outgoing'] = {'handle': handle, 'kind': kind, 'at': time.time()}
        self.command('confirm')
        self._bump()

    def end_call(self):
        ok = self.command('end')
        with self.lock:
            self.state['outgoing'] = None
        self._schedule_hangup()
        return ok

    # -- media bridge
    def attach(self, ws, want_video):
        """Connect a browser to the call: route the Mac's audio through the virtual devices."""
        with self.lock:
            old, self.ws = self.ws, ws
            if old:
                old.close()
            self._stop_media()
            try:
                self.audio = subprocess.Popen(
                    [HELPER, 'audio', '--capture', self.capture_device, '--play', self.mic_device,
                     '--rate', str(RATE), '--state', self.state_file],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            except OSError as e:
                ws.send(json.dumps({'type': 'error', 'message': str(e)}))
                return False
            audio = self.audio
        threading.Thread(target=self._pump_audio, args=(audio, ws), daemon=True).start()
        threading.Thread(target=self._pump_errors, args=(audio, ws), daemon=True).start()
        if want_video:
            self.start_video(ws)
        return True

    def _pump_audio(self, proc, ws):
        fd = proc.stdout.fileno()
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk or not ws.send(b'\x01' + chunk):
                break

    @staticmethod
    def _pump_errors(proc, ws):
        for line in proc.stderr:
            msg = line.decode(errors='replace').strip()
            if msg:
                ws.send(json.dumps({'type': 'error', 'message': msg.replace('callbridge: ', '')}))

    def start_video(self, ws):
        with self.lock:
            if self.video and self.video.poll() is None:
                return
            try:
                self.video = subprocess.Popen([HELPER, 'video', '--fps', '12'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            except OSError:
                return
            proc = self.video

        def pump():
            out = proc.stdout
            while True:
                head = out.read(4)
                if len(head) < 4:
                    break
                n = struct.unpack('>I', head)[0]
                frame = out.read(n)
                if len(frame) < n or not ws.send(b'\x02' + frame):
                    break
        threading.Thread(target=pump, daemon=True).start()

    def feed_mic(self, ws, data):
        p = self.audio
        if self.ws is not ws or not p or p.poll() is not None:
            return
        try:
            p.stdin.write(data)
            p.stdin.flush()
        except (OSError, ValueError):
            pass

    def detach(self, ws):
        with self.lock:
            if self.ws is ws:
                self.ws = None
                self._stop_media()

    def _stop_media(self):
        for attr in ('audio', 'video'):
            p = getattr(self, attr)
            setattr(self, attr, None)
            if not p or p.poll() is not None:
                continue
            try:
                if p.stdin:
                    p.stdin.close()  # EOF makes the audio helper restore the Mac's default devices
                p.terminate()
                p.wait(3)
            except (OSError, subprocess.SubprocessError):
                p.kill()
