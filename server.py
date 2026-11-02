"""Piano Tutor local server: serves the app to devices on your Wi-Fi (e.g. an iPad).

  python3 server.py            # normal use (http on 8000, https on 8443 when certs/ exists)
  python3 server.py --debug    # also collect browser errors into debug.log

Also provides:
  GET  /midi/library.json      list of .mid files in ./midi
  GET  /api/notes?song=TITLE   notes text for a piece (from ./notes/TITLE.txt)
  PUT  /api/notes?song=TITLE   save notes text
  GET/PUT /api/progress?song=TITLE   section status + practice log (./progress/TITLE.json)
  GET  /setup                  iPad setup page (install the local certificate for https)
  GET  /ca.crt                 the local certificate authority, for installing on the iPad
"""
import datetime
import functools
import http.server
import json
import os
import re
import socket
import ssl
import threading
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
MIDI_DIR = os.path.join(HERE, 'midi')
NOTES_DIR = os.path.join(HERE, 'notes')
PROGRESS_DIR = os.path.join(HERE, 'progress')
DEBUG = '--debug' in sys.argv
PORT = 8000
HTTPS_PORT = 8443
CERT_DIR = os.path.join(HERE, 'certs')
MAX_NOTES_BYTES = 2_000_000
MAX_FILES = 500  # per folder (notes/, progress/)

DEBUG_SCRIPT = b"""<script>
(function () {
  function send(kind, msg) { try { fetch('/api/log', { method: 'POST', body: kind + ' | ' + msg, keepalive: true }); } catch (e) {} }
  window.addEventListener('error', function (e) { send('ERROR', e.message + ' @ ' + (e.filename || '') + ':' + e.lineno); });
  window.addEventListener('unhandledrejection', function (e) { send('REJECT', String(e.reason && (e.reason.stack || e.reason))); });
  ['error', 'warn'].forEach(function (k) {
    var orig = console[k];
    console[k] = function () { send('CONSOLE.' + k, [].map.call(arguments, String).join(' ')); orig.apply(console, arguments); };
  });
  send('HELLO', navigator.userAgent);
})();
</script>
"""


SETUP_PAGE = '''<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Piano Tutor setup</title>
<body style="font:17px -apple-system,sans-serif;max-width:640px;margin:30px auto;padding:0 18px;background:#14161b;color:#e9eaee;line-height:1.5">
<h1>Piano Tutor: iPad setup</h1>
<p>Keeping the screen on while playing only works over a secure connection. Do this once:</p>
<ol>
<li><a style="color:#8fb4ff" href="/ca.crt"><b>Download the Piano Tutor certificate</b></a> and tap <b>Allow</b>.</li>
<li>Open <b>Settings</b> &rarr; <b>General</b> &rarr; <b>VPN &amp; Device Management</b>, tap <b>Piano Tutor local CA</b>, then <b>Install</b>.</li>
<li>Open <b>Settings</b> &rarr; <b>General</b> &rarr; <b>About</b> &rarr; <b>Certificate Trust Settings</b> and switch on <b>Piano Tutor local CA</b>.</li>
<li>Open <a style="color:#8fb4ff" href="https://{HOST}:8443/"><b>https://{HOST}:8443</b></a> and add it to your Home Screen (Share &rarr; Add to Home Screen).</li>
</ol>
<p style="color:#9097a3">The certificate only works for this Mac's local network name and home-network addresses, and the key that created it has been deleted, so it cannot be used for any other website. It expires in about a year. To remove it: Settings &rarr; General &rarr; VPN &amp; Device Management.</p>
</body>'''


def song_path(song, folder, ext):
    safe = re.sub(r'[\x00-\x1f/\\:*?"<>|]', '_', song).strip(' .')[:120] or 'untitled'
    return os.path.join(folder, safe + ext)


# Only these files are served. An allowlist rather than a blocklist: macOS paths are
# case-insensitive and URLs can be percent-encoded, so blocking /certs/ alone is not enough.
STATIC = re.compile(r'/(index\.html|styles\.css|manifest\.webmanifest|sw\.js|js/[a-z]+\.js'
                    r'|fonts/Bravura\.woff2|icons/icon-\d+\.png|midi/[^/\\]+(?i:\.midi?))?')


def body_length(headers, limit):
    try:
        n = int(headers.get('Content-Length', 0))
    except ValueError:
        return None
    return n if 0 <= n <= limit else None


# API path -> (folder, extension, content type)
STORES = {
    '/api/notes': (NOTES_DIR, '.txt', 'text/plain; charset=utf-8'),
    '/api/progress': (PROGRESS_DIR, '.json', 'application/json'),
}


def trusted_host(header):
    # Blocks DNS rebinding: a website can point its own domain at this server, but cannot
    # make the browser send an IP address, localhost or a .local name as the Host.
    name = re.sub(r':\d+$', '', header or '').strip('[]').lower()
    if name == 'localhost' or name.endswith('.local'):
        return True
    return re.fullmatch(r'[\d.]+|[0-9a-f:]+', name) is not None


class Handler(http.server.SimpleHTTPRequestHandler):
    def parse_request(self):
        if not super().parse_request():
            return False
        # Only plain paths from a page on this server's own address
        if not self.path.startswith('/') or not trusted_host(self.headers.get('Host')):
            self.send_error(403)
            return False
        return True

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_body(self, code, body, ctype):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def song_param(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        return (q.get('song') or [''])[0]

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/midi/library.json':
            files = sorted(f for f in os.listdir(MIDI_DIR) if f.lower().endswith(('.mid', '.midi'))) if os.path.isdir(MIDI_DIR) else []
            listing = [{'name': f, 'size': os.path.getsize(os.path.join(MIDI_DIR, f))} for f in files]
            return self.send_body(200, json.dumps(listing).encode(), 'application/json')
        if path in STORES:
            folder, ext, ctype = STORES[path]
            p = song_path(self.song_param(), folder, ext)
            if not os.path.exists(p):
                return self.send_body(404, b'', 'text/plain')
            with open(p, 'rb') as f:
                return self.send_body(200, f.read(), ctype)
        if DEBUG and path in ('/', '/index.html'):
            with open(os.path.join(HERE, 'index.html'), 'rb') as f:
                body = f.read().replace(b'<script src="js/theory.js">', DEBUG_SCRIPT + b'<script src="js/theory.js">', 1)
            return self.send_body(200, body, 'text/html; charset=utf-8')
        if path == '/ca.crt':
            with open(os.path.join(CERT_DIR, 'PianoTutor-CA.crt'), 'rb') as f:
                return self.send_body(200, f.read(), 'application/x-x509-ca-cert')
        if path == '/setup':
            host = re.sub(r'[^A-Za-z0-9.-]', '', self.headers.get('Host', '').split(':')[0])
            return self.send_body(200, SETUP_PAGE.replace('{HOST}', host).encode(), 'text/html; charset=utf-8')
        if not STATIC.fullmatch(urllib.parse.unquote(path)):
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if not STATIC.fullmatch(urllib.parse.unquote(urllib.parse.urlparse(self.path).path)):
            return self.send_error(404)
        return super().do_HEAD()

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        if path not in STORES:
            return self.send_error(404)
        folder, ext, _ = STORES[path]
        n = body_length(self.headers, MAX_NOTES_BYTES)
        if n is None:
            return self.send_error(413)
        text = self.rfile.read(n)
        os.makedirs(folder, exist_ok=True)
        p = song_path(self.song_param(), folder, ext)
        if not os.path.exists(p) and len(os.listdir(folder)) >= MAX_FILES:
            return self.send_error(507)
        tmp = f'{p}.{threading.get_ident()}.tmp'
        with open(tmp, 'wb') as f:
            f.write(text)
        os.replace(tmp, p)
        return self.send_body(200, json.dumps({'file': os.path.relpath(p, HERE)}).encode(), 'application/json')

    def do_POST(self):
        if not DEBUG or urllib.parse.urlparse(self.path).path != '/api/log':
            return self.send_error(404)
        n = body_length(self.headers, 20000)
        if n is None:
            return self.send_error(413)
        msg = self.rfile.read(n).decode('utf-8', 'replace')
        with open(os.path.join(HERE, 'debug.log'), 'a') as f:
            f.write(f'{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {self.client_address[0]} {msg}\n')
        return self.send_body(204, b'', 'text/plain')

    def log_message(self, fmt, *args):
        pass


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except OSError:
        return None


def main():
    os.makedirs(MIDI_DIR, exist_ok=True)
    try:
        host = subprocess.run(['scutil', '--get', 'LocalHostName'], capture_output=True, text=True).stdout.strip()
    except OSError:
        host = ''
    handler = functools.partial(Handler, directory=HERE)
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), handler)
    chain, key = os.path.join(CERT_DIR, 'server-chain.crt'), os.path.join(CERT_DIR, 'server.key')
    secure = None
    if os.path.exists(chain) and os.path.exists(key):
        secure = http.server.ThreadingHTTPServer(('0.0.0.0', HTTPS_PORT), handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(chain, key)
        secure.socket = ctx.wrap_socket(secure.socket, server_side=True)
        threading.Thread(target=secure.serve_forever, daemon=True).start()
    print('Piano Tutor is running. On your iPad (same Wi-Fi), open:\n')
    if host and secure:
        print(f'    https://{host}.local:{HTTPS_PORT}      (keeps the iPad screen on while playing)\n')
        print(f'    First time on a new iPad? Set it up at  http://{host}.local:{PORT}/setup\n')
    elif host:
        print(f'    http://{host}.local:{PORT}\n')
    ip = lan_ip()
    if ip:
        print(f'    (if the name does not load: http://{ip}:{PORT})\n')
    print(f'MIDI library folder: {MIDI_DIR}')
    print(f'Practice notes are saved in: {NOTES_DIR}')
    print(f'Section progress and practice time are saved in: {PROGRESS_DIR}')
    print('\nLeave this window open while you practise. Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')


if __name__ == '__main__':
    main()
