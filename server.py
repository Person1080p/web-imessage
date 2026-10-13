#!/usr/bin/env python3
"""web-imessage — read and reply to iMessages from any browser on your network.

Reads ~/Library/Messages/chat.db (read-only) and sends through Messages.app via
AppleScript. Standard library only; runs on the system python3.

    python3 server.py                 # start (prints URL + password)
    python3 server.py --set-password  # choose a new password (logs out all browsers)
"""
import datetime
import glob
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import socket
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import calls

HOME = os.path.expanduser('~')
ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, 'static')
DB_PATH = os.environ.get('WEBIM_DB', os.path.join(HOME, 'Library/Messages/chat.db'))
ADDRESSBOOK_DIR = os.environ.get('WEBIM_ADDRESSBOOK', os.path.join(HOME, 'Library/Application Support/AddressBook'))
CONF_DIR = os.environ.get('WEBIM_CONF', os.path.join(HOME, '.web-imessage'))
CONF_PATH = os.path.join(CONF_DIR, 'config.json')
STATE_PATH = os.path.join(CONF_DIR, 'state.json')
CACHE_DIR = os.path.join(HOME, 'Library/Caches/web-imessage')
# Messages.app is sandboxed and silently fails to send files from many locations;
# ~/Pictures is one it can always read.
UPLOAD_DIR = os.path.join(HOME, 'Pictures', 'web-imessage-uploads')
DRY_RUN = os.environ.get('WEBIM_DRY_RUN') == '1'

APPLE_EPOCH = 978307200
SESSION_DAYS = 30
MAX_UPLOAD = 100 * 1024 * 1024
REACTIONS = {0: 'love', 1: 'like', 2: 'dislike', 3: 'laugh', 4: 'emphasize', 5: 'question', 6: 'emoji', 7: 'sticker'}
BROWSER_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'}


# ---------------------------------------------------------------- config / state

def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_config():
    conf = load_json(CONF_PATH, {})
    changed = False
    defaults = {'host': '0.0.0.0', 'port': 8642, 'https_port': 8643}
    for k, v in defaults.items():
        if k not in conf:
            conf[k] = v
            changed = True
    if not conf.get('password'):
        conf['password'] = secrets.token_urlsafe(9)
        changed = True
    if not conf.get('secret'):
        conf['secret'] = secrets.token_hex(32)
        changed = True
    if changed:
        save_json(CONF_PATH, conf)
    return conf


CONFIG = None
CONFIG_MTIME = None


def reload_config_if_changed():
    """Pick up edits to config.json (e.g. --set-password) without a restart."""
    global CONFIG, CONFIG_MTIME
    try:
        mtime = os.stat(CONF_PATH).st_mtime_ns
    except OSError:
        return
    if mtime != CONFIG_MTIME:
        conf = load_json(CONF_PATH, None)
        if conf and conf.get('password') and conf.get('secret'):
            if CONFIG_MTIME is not None and conf['password'] != CONFIG['password']:
                print('Password changed; existing sessions signed out.')
            CONFIG.update(conf)
        CONFIG_MTIME = mtime


STATE_LOCK = threading.Lock()
STATE = {}  # {"viewed": {conv_id: apple_date}}


def set_viewed(conv_id, apple_date):
    with STATE_LOCK:
        viewed = STATE.setdefault('viewed', {})
        if apple_date > viewed.get(str(conv_id), 0):
            viewed[str(conv_id)] = apple_date
            save_json(STATE_PATH, STATE)


def get_viewed(conv_id):
    with STATE_LOCK:
        return STATE.get('viewed', {}).get(str(conv_id), 0)


# ---------------------------------------------------------------- auth

def make_token():
    exp = int(time.time()) + SESSION_DAYS * 86400
    sig = hmac.new(CONFIG['secret'].encode(), str(exp).encode(), hashlib.sha256).hexdigest()
    return '%d.%s' % (exp, sig)


def check_token(token):
    try:
        exp, sig = token.split('.', 1)
        good = hmac.new(CONFIG['secret'].encode(), exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except (ValueError, AttributeError):
        return False


LOGIN_FAILS = {}  # ip -> [timestamps]


def login_blocked(ip):
    now = time.time()
    fails = [t for t in LOGIN_FAILS.get(ip, []) if now - t < 600]
    LOGIN_FAILS[ip] = fails
    return len(fails) >= 8


# ---------------------------------------------------------------- helpers

def apple_to_ms(d):
    if not d:
        return None
    if d > 1e12:  # nanoseconds (High Sierra and later)
        d = d / 1e9
    return int((d + APPLE_EPOCH) * 1000)


def now_apple():
    return int((time.time() - APPLE_EPOCH) * 1e9)


def decode_attributed_body(blob):
    """Extract the plain string from a typedstream-archived NSAttributedString."""
    if not blob:
        return None
    try:
        idx = blob.find(b'NSString')
        if idx < 0:
            return None
        idx = blob.find(b'+', idx + 8)
        if idx < 0:
            return None
        idx += 1
        n = blob[idx]
        idx += 1
        if n == 0x81:
            n = int.from_bytes(blob[idx:idx + 2], 'little')
            idx += 2
        elif n == 0x82:
            n = int.from_bytes(blob[idx:idx + 4], 'little')
            idx += 4
        elif n == 0x83:
            n = int.from_bytes(blob[idx:idx + 8], 'little')
            idx += 8
        return blob[idx:idx + n].decode('utf-8', errors='replace')
    except (IndexError, ValueError):
        return None


def message_text(text, body):
    t = text if text else decode_attributed_body(body)
    if t is None:
        return ''
    # U+FFFC marks where attachments sit inline; U+FFFD comes from bad decodes.
    return t.replace('￼', '').replace('�', '').strip()


def normalize_handle(h):
    if not h:
        return ''
    h = h.strip()
    if '@' in h:
        return h.lower()
    digits = re.sub(r'\D', '', h)
    if not digits:
        return h.lower()
    return digits[-10:] if len(digits) >= 10 else digits


def pretty_handle(h):
    m = re.match(r'^\+?1?(\d{3})(\d{3})(\d{4})$', h or '')
    return '(%s) %s-%s' % m.groups() if m else h


def display_name(handle):
    return CONTACTS.name(handle) or pretty_handle(handle)


def lan_addresses():
    addrs = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        addrs.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(addrs)


# ---------------------------------------------------------------- contacts

def ab_label(label):
    """'_$!<Mobile>!$_' -> 'mobile'; custom labels pass through."""
    if not label:
        return ''
    m = re.match(r'^_\$!<(.+)>!\$_$', label)
    return (m.group(1) if m else label).lower()


def ab_birthday(ts):
    """Core Data timestamp -> 'March 4, 1990' (or 'March 4' when the year wasn't set)."""
    if ts is None:
        return None
    try:
        d = datetime.datetime(2001, 1, 1) + datetime.timedelta(seconds=float(ts) + 43200)
    except (OverflowError, ValueError):
        return None
    month_day = '%s %d' % (d.strftime('%B'), d.day)
    return month_day if d.year < 1700 else '%s, %d' % (month_day, d.year)


class Contacts:
    def __init__(self):
        self.lock = threading.Lock()
        self.by_handle = {}   # normalized handle -> name
        self.details = {}     # normalized handle -> full contact card
        self.photos = {}      # normalized handle -> jpeg bytes
        self.people = []      # [{name, handles}]
        self.loaded_at = 0

    @staticmethod
    def _read_source(path):
        """Returns {record_pk: card} for one AddressBook database."""
        conn = sqlite3.connect('file:%s?mode=ro' % urllib.parse.quote(path), uri=True)
        try:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

            def pick(table, wanted):
                have = {r[1] for r in conn.execute('PRAGMA table_info(%s)' % table)}
                return ', '.join(c if c in have else 'NULL' for c in wanted)

            rec_cols = ['Z_PK', 'ZFIRSTNAME', 'ZLASTNAME', 'ZORGANIZATION', 'ZNICKNAME', 'ZTHUMBNAILIMAGEDATA',
                        'ZJOBTITLE', 'ZDEPARTMENT', 'ZBIRTHDAY']
            cards = {}
            for pk, first, last, org, nick, img, job, dept, bday in conn.execute(
                    'SELECT %s FROM ZABCDRECORD' % pick('ZABCDRECORD', rec_cols)):
                name = ' '.join(x for x in (first, last) if x) or nick or org
                if not name:
                    continue
                cards[pk] = {
                    'name': name, 'nickname': nick if nick != name else None,
                    'organization': org if (first or last) else None, 'jobTitle': job, 'department': dept,
                    'birthday': ab_birthday(bday), 'phones': [], 'emails': [], 'addresses': [], 'urls': [],
                    'note': None, '_img': img,
                }
            for owner, value, label in conn.execute(
                    'SELECT %s FROM ZABCDPHONENUMBER' % pick('ZABCDPHONENUMBER', ['ZOWNER', 'ZFULLNUMBER', 'ZLABEL'])):
                if owner in cards and value:
                    cards[owner]['phones'].append({'label': ab_label(label) or 'phone', 'value': value})
            for owner, value, label in conn.execute(
                    'SELECT %s FROM ZABCDEMAILADDRESS' % pick('ZABCDEMAILADDRESS', ['ZOWNER', 'ZADDRESS', 'ZLABEL'])):
                if owner in cards and value:
                    cards[owner]['emails'].append({'label': ab_label(label) or 'email', 'value': value})
            if 'ZABCDPOSTALADDRESS' in tables:
                q = 'SELECT %s FROM ZABCDPOSTALADDRESS' % pick(
                    'ZABCDPOSTALADDRESS', ['ZOWNER', 'ZLABEL', 'ZSTREET', 'ZCITY', 'ZSTATE', 'ZZIPCODE', 'ZCOUNTRYNAME'])
                for owner, label, street, city, state, zipc, country in conn.execute(q):
                    if owner not in cards:
                        continue
                    locality = ' '.join(x for x in ((city + ',') if city else None, state, zipc) if x).rstrip(',')
                    lines = [x for x in (street, locality, country) if x]
                    if lines:
                        cards[owner]['addresses'].append({'label': ab_label(label) or 'address', 'lines': lines})
            if 'ZABCDURLADDRESS' in tables:
                for owner, value, label in conn.execute(
                        'SELECT %s FROM ZABCDURLADDRESS' % pick('ZABCDURLADDRESS', ['ZOWNER', 'ZURL', 'ZLABEL'])):
                    if owner in cards and value:
                        cards[owner]['urls'].append({'label': ab_label(label) or 'homepage', 'value': value})
            if 'ZABCDNOTE' in tables:
                for owner, text in conn.execute('SELECT %s FROM ZABCDNOTE' % pick('ZABCDNOTE', ['ZCONTACT', 'ZTEXT'])):
                    if owner in cards and text:
                        cards[owner]['note'] = text
            return cards
        finally:
            conn.close()

    def refresh(self):
        by_handle, details, photos, people = {}, {}, {}, []
        paths = glob.glob(os.path.join(ADDRESSBOOK_DIR, 'Sources', '*', 'AddressBook-v22.abcddb'))
        paths.append(os.path.join(ADDRESSBOOK_DIR, 'AddressBook-v22.abcddb'))
        for path in paths:
            if not os.path.exists(path):
                continue
            try:
                cards = self._read_source(path)
            except sqlite3.Error as e:
                print('contacts: could not read %s: %s' % (path, e), file=sys.stderr)
                continue
            for card in cards.values():
                img = card.pop('_img')
                handles = [x['value'] for x in card['phones'] + card['emails']]
                if not handles:
                    continue
                jpeg = None
                if img:
                    start = img.find(b'\xff\xd8')
                    if start >= 0:
                        jpeg = bytes(img[start:])
                for h in handles:
                    key = normalize_handle(h)
                    if key not in by_handle:
                        by_handle[key] = card['name']
                        details[key] = card
                    if jpeg and key not in photos:
                        photos[key] = jpeg
                people.append({'name': card['name'], 'handles': handles})
        with self.lock:
            self.by_handle, self.details, self.photos = by_handle, details, photos
            self.people = sorted(people, key=lambda p: p['name'].lower())
            self.loaded_at = time.time()

    def name(self, handle):
        return self.by_handle.get(normalize_handle(handle))

    def card(self, handle):
        return self.details.get(normalize_handle(handle))

    def photo(self, handle):
        return self.photos.get(normalize_handle(handle))

    def has_photo(self, handle):
        return normalize_handle(handle) in self.photos


CONTACTS = Contacts()


# ---------------------------------------------------------------- database

class NoAccess(Exception):
    pass


def db():
    try:
        conn = sqlite3.connect('file:%s?mode=ro' % urllib.parse.quote(DB_PATH), uri=True, timeout=5)
        conn.execute('SELECT 1 FROM message LIMIT 1')
    except sqlite3.Error as e:
        raise NoAccess(str(e))
    conn.row_factory = sqlite3.Row
    conn.create_function('body_text', 2, message_text, deterministic=True)
    return conn


_COLS = {}


def cols(conn, table):
    if table not in _COLS:
        _COLS[table] = {r[1] for r in conn.execute('PRAGMA table_info(%s)' % table)}
    return _COLS[table]


def opt(conn, table, alias, col, default='NULL'):
    return '%s.%s' % (alias, col) if col in cols(conn, table) else '%s AS %s' % (default, col)


class Conversations:
    """Groups chat rows into conversations. 1:1 chats with the same person across
    iMessage/SMS/RCS are merged; the conversation id is the lowest chat ROWID."""

    def __init__(self):
        self.lock = threading.Lock()
        self.version = None
        self.convs = {}       # conv_id -> dict
        self.chat_conv = {}   # chat rowid -> conv_id

    def ensure(self, conn):
        v = WATCHER.version
        with self.lock:
            if self.version == v and self.convs:
                return
        parts = {}
        for r in conn.execute('SELECT chj.chat_id, h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id'):
            parts.setdefault(r[0], []).append(r[1])
        groups = {}
        for r in conn.execute('SELECT ROWID, guid, chat_identifier, display_name, style, service_name FROM chat ORDER BY ROWID'):
            is_group = r['style'] == 43 or len(parts.get(r['ROWID'], [])) > 1
            key = ('g', r['guid']) if is_group else ('p', normalize_handle(r['chat_identifier']))
            g = groups.get(key)
            if g is None:
                g = groups[key] = {
                    'id': r['ROWID'], 'chats': [], 'guids': {}, 'isGroup': is_group,
                    'displayName': r['display_name'] or None,
                    'participants': list(parts.get(r['ROWID'], [])) or ([r['chat_identifier']] if not is_group else []),
                }
            g['chats'].append(r['ROWID'])
            g['guids'][r['ROWID']] = (r['guid'], r['service_name'] or '')
            if r['display_name']:
                g['displayName'] = r['display_name']
            for p in parts.get(r['ROWID'], []):
                if p not in g['participants']:
                    g['participants'].append(p)
        convs = {g['id']: g for g in groups.values()}
        chat_conv = {c: g['id'] for g in groups.values() for c in g['chats']}
        with self.lock:
            self.convs, self.chat_conv, self.version = convs, chat_conv, v

    def get(self, conn, conv_id):
        self.ensure(conn)
        return self.convs.get(conv_id)


CONVS = Conversations()


def conv_title(c):
    if c['displayName']:
        return c['displayName']
    names = [CONTACTS.name(p) or p for p in c['participants']]
    if not names:
        return 'Unknown'
    if len(names) == 1:
        return names[0]
    firsts = [n.split(' ')[0] if CONTACTS.name(p) else n for n, p in zip(names, c['participants'])]
    return ', '.join(firsts)


def placeholders(n):
    return ','.join('?' * n)


def system_text(m, sender_name, other_name):
    who = 'You' if m['is_from_me'] else (sender_name or 'Someone')
    it, action = m['item_type'], m['group_action_type']
    if it == 1:
        return '%s %s %s' % (who, 'removed' if action == 1 else 'added', other_name or 'someone')
    if it == 2:
        return '%s named the conversation “%s”' % (who, m['group_title']) if m['group_title'] else '%s removed the conversation name' % who
    if it == 3:
        if action == 1:
            return '%s changed the group photo' % who
        if action == 2:
            return '%s removed the group photo' % who
        return '%s left the conversation' % who
    if it == 4:
        return '%s shared their location' % who
    if it == 6:
        return 'FaceTime call'
    return None


def message_select(conn):
    o = lambda c, d='NULL': opt(conn, 'message', 'm', c, d)
    return '''SELECT m.ROWID AS id, m.guid, m.text, m.attributedBody, m.is_from_me, m.date, m.date_read,
        m.date_delivered, m.is_delivered, m.is_read, m.is_sent, m.error, m.service, m.handle_id,
        h.id AS handle, m.cache_has_attachments, m.item_type, m.group_title, m.group_action_type,
        m.other_handle, m.associated_message_type, m.associated_message_guid, {}, {}, {}, {}, {}, {},
        cmj.chat_id, cmj.message_date
      FROM chat_message_join cmj
      JOIN message m ON m.ROWID = cmj.message_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id'''.format(
        o('thread_originator_guid'), o('date_edited', '0'), o('date_retracted', '0'),
        o('is_audio_message', '0'), o('balloon_bundle_id'), o('associated_message_emoji'))


def target_guid(assoc):
    if not assoc:
        return None
    if '/' in assoc:
        return assoc.split('/', 1)[1]
    if ':' in assoc:
        return assoc.split(':', 1)[1]
    return assoc


def load_attachments(conn, msg_ids):
    out = {}
    if not msg_ids:
        return out
    acol = lambda c, d='NULL': opt(conn, 'attachment', 'a', c, d)
    q = '''SELECT maj.message_id, a.ROWID AS id, a.filename, a.mime_type, a.transfer_name, a.total_bytes,
           a.uti, {}, {} FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
           WHERE maj.message_id IN ({}) ORDER BY a.ROWID'''.format(
        acol('is_sticker', '0'), acol('hide_attachment', '0'), placeholders(len(msg_ids)))
    for r in conn.execute(q, msg_ids):
        name = r['transfer_name'] or os.path.basename(r['filename'] or '') or 'attachment'
        if r['hide_attachment'] or name.endswith('.pluginPayloadAttachment'):
            continue
        mime = r['mime_type'] or mimetypes.guess_type(name)[0] or 'application/octet-stream'
        kind = 'file'
        if mime.startswith('image/'):
            kind = 'image'
        elif mime.startswith('video/'):
            kind = 'video'
        elif mime.startswith('audio/'):
            kind = 'audio'
        out.setdefault(r['message_id'], []).append({
            'id': r['id'], 'name': name, 'mime': mime, 'kind': kind, 'size': r['total_bytes'] or 0,
            'sticker': bool(r['is_sticker']), 'missing': not r['filename'],
        })
    return out


def serialize_messages(conn, conv, rows, include_reactions=True):
    rows = list(rows)
    ids = [r['id'] for r in rows]
    atts = load_attachments(conn, [r['id'] for r in rows if r['cache_has_attachments']])

    # Replies: fetch the text of the messages being replied to.
    reply_guids = list({r['thread_originator_guid'] for r in rows if r['thread_originator_guid']})
    originals = {}
    if reply_guids:
        q = 'SELECT m.guid, m.text, m.attributedBody, m.is_from_me, h.id AS handle FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.guid IN (%s)' % placeholders(len(reply_guids))
        for o in conn.execute(q, reply_guids):
            originals[o['guid']] = {
                'text': message_text(o['text'], o['attributedBody'])[:200] or 'Attachment',
                'fromMe': bool(o['is_from_me']),
                'sender': None if o['is_from_me'] else (CONTACTS.name(o['handle']) or o['handle']),
            }

    reactions = {}
    if include_reactions and rows:
        guids = {r['guid'] for r in rows}
        oldest = min(r['message_date'] for r in rows)
        q = message_select(conn) + '''
            WHERE cmj.chat_id IN ({}) AND m.associated_message_type BETWEEN 2000 AND 3999 AND cmj.message_date >= ?
            ORDER BY cmj.message_date'''.format(placeholders(len(conv['chats'])))
        state = {}
        for r in conn.execute(q, conv['chats'] + [oldest]):
            tg = target_guid(r['associated_message_guid'])
            if tg not in guids:
                continue
            t = r['associated_message_type']
            who = 'me' if r['is_from_me'] else (r['handle'] or '?')
            if t >= 3000:
                state.pop((tg, who), None)
            else:
                state[(tg, who)] = {
                    'type': REACTIONS.get(t - 2000, 'love'), 'emoji': r['associated_message_emoji'],
                    'fromMe': bool(r['is_from_me']),
                    'sender': None if r['is_from_me'] else (CONTACTS.name(r['handle']) or r['handle']),
                }
        for (tg, _), v in state.items():
            reactions.setdefault(tg, []).append(v)

    out = []
    for r in rows:
        sender_name = None if r['is_from_me'] else display_name(r['handle'])
        item = {
            'id': r['id'], 'guid': r['guid'], 'date': apple_to_ms(r['date']),
            'cursor': '%d_%d' % (r['message_date'] or 0, r['id']),
            'fromMe': bool(r['is_from_me']), 'sender': r['handle'], 'senderName': sender_name,
            'service': r['service'] or '',
        }
        if r['item_type']:
            other = None
            if r['other_handle']:
                h = conn.execute('SELECT id FROM handle WHERE ROWID = ?', (r['other_handle'],)).fetchone()
                if h:
                    other = display_name(h[0])
            text = system_text(r, sender_name, other)
            if not text:
                continue
            item.update(system=True, text=text)
            out.append(item)
            continue
        text = message_text(r['text'], r['attributedBody'])
        a = atts.get(r['id'], [])
        if r['date_retracted'] or (r['date_edited'] and not text and not a):
            item.update(system=True, text='%s unsent a message' % ('You' if r['is_from_me'] else (sender_name or 'Someone')))
            out.append(item)
            continue
        if not text and not a:
            if r['balloon_bundle_id']:
                text = '[Message from an iMessage app — open on iPhone]'
            elif r['is_audio_message']:
                text = '[Audio message]'
            else:
                continue
        item.update(
            text=text, attachments=a, reactions=reactions.get(r['guid'], []),
            edited=bool(r['date_edited']), error=r['error'] or 0,
            delivered=bool(r['is_delivered']) and bool(r['date_delivered']),
            dateDelivered=apple_to_ms(r['date_delivered']), dateRead=apple_to_ms(r['date_read']) if r['is_from_me'] else None,
            sent=bool(r['is_sent']),
            replyTo=originals.get(r['thread_originator_guid']) if r['thread_originator_guid'] else None,
        )
        out.append(item)
    return out


def preview_for(conn, r):
    if r['item_type']:
        return 'Group update'
    t = r['associated_message_type'] or 0
    if 2000 <= t < 3000:
        return message_text(r['text'], r['attributedBody']) or 'Reacted to a message'
    text = message_text(r['text'], r['attributedBody'])
    if text:
        return text[:160]
    if r['cache_has_attachments']:
        a = load_attachments(conn, [r['id']]).get(r['id'], [])
        if a:
            k = a[0]['kind']
            return {'image': 'Photo', 'video': 'Video', 'audio': 'Audio message'}.get(k, a[0]['name'])
        return 'Attachment'
    return ''


def list_conversations(conn, limit=400):
    CONVS.ensure(conn)
    latest = {}
    for chat_id, msg_id, d in conn.execute(
            'SELECT chat_id, message_id, MAX(message_date) FROM chat_message_join GROUP BY chat_id'):
        cid = CONVS.chat_conv.get(chat_id)
        if cid is not None and (cid not in latest or d > latest[cid][1]):
            latest[cid] = (msg_id, d)
    order = sorted(latest.items(), key=lambda kv: -kv[1][1])[:limit]
    if not order:
        return []
    msg_ids = [v[0] for _, v in order]
    q = '''SELECT m.ROWID AS id, m.text, m.attributedBody, m.is_from_me, m.date, m.cache_has_attachments,
           m.associated_message_type, m.item_type, m.service, m.error, h.id AS handle
           FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.ROWID IN (%s)''' % placeholders(len(msg_ids))
    msgs = {r['id']: r for r in conn.execute(q, msg_ids)}

    # Unread = incoming, not read in Messages, and newer than when we last viewed it here.
    unread = {}
    since = now_apple() - 60 * 86400 * 10**9
    for chat_id, d in conn.execute(
            '''SELECT cmj.chat_id, cmj.message_date FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
               WHERE m.is_read = 0 AND m.is_from_me = 0 AND m.item_type = 0
               AND (m.associated_message_type IS NULL OR m.associated_message_type = 0) AND cmj.message_date > ?''', (since,)):
        cid = CONVS.chat_conv.get(chat_id)
        if cid is not None and d > get_viewed(cid):
            unread[cid] = unread.get(cid, 0) + 1

    out = []
    for cid, (msg_id, d) in order:
        c = CONVS.convs[cid]
        m = msgs.get(msg_id)
        out.append({
            'id': cid, 'title': conv_title(c), 'name': c['displayName'], 'isGroup': c['isGroup'], 'participants': [
                {'handle': p, 'name': CONTACTS.name(p), 'hasPhoto': CONTACTS.has_photo(p)} for p in c['participants']],
            'date': apple_to_ms(d), 'snippet': preview_for(conn, m) if m else '',
            'fromMe': bool(m['is_from_me']) if m else False, 'lastId': msg_id,
            'service': (m['service'] if m else '') or '', 'unread': unread.get(cid, 0),
            'error': bool(m['error']) if m and m['is_from_me'] else False,
        })
    return out


def parse_cursor(s):
    try:
        d, i = s.split('_')
        return int(d), int(i)
    except (ValueError, AttributeError):
        return None


def get_messages(conn, conv, before=None, since=None, limit=60):
    q = message_select(conn) + ' WHERE cmj.chat_id IN (%s) AND (m.associated_message_type IS NULL OR m.associated_message_type < 2000 OR m.associated_message_type >= 4000)' % placeholders(len(conv['chats']))
    args = list(conv['chats'])
    if before:
        q += ' AND (cmj.message_date < ? OR (cmj.message_date = ? AND m.ROWID < ?))'
        args += [before[0], before[0], before[1]]
    if since:
        q += ' AND (cmj.message_date > ? OR (cmj.message_date = ? AND m.ROWID >= ?))'
        args += [since[0], since[0], since[1]]
        limit = max(limit, 3000)
    q += ' ORDER BY cmj.message_date DESC, m.ROWID DESC LIMIT ?'
    args.append(limit + 1)
    rows = conn.execute(q, args).fetchall()
    has_more = len(rows) > limit
    rows = list(reversed(rows[:limit]))
    return {'messages': serialize_messages(conn, conv, rows), 'hasMore': has_more}


def search_messages(conn, term, limit=80):
    CONVS.ensure(conn)
    like = '%' + term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
    q = '''SELECT m.ROWID AS id, m.text, m.attributedBody, m.is_from_me, h.id AS handle, cmj.chat_id, cmj.message_date
           FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
           WHERE m.item_type = 0 AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
           AND body_text(m.text, m.attributedBody) LIKE ? ESCAPE '\\'
           ORDER BY cmj.message_date DESC LIMIT ?'''
    out = []
    for r in conn.execute(q, (like, limit)):
        cid = CONVS.chat_conv.get(r['chat_id'])
        if cid is None:
            continue
        out.append({
            'convId': cid, 'convTitle': conv_title(CONVS.convs[cid]), 'id': r['id'],
            'cursor': '%d_%d' % (r['message_date'], r['id']), 'date': apple_to_ms(r['message_date']),
            'text': message_text(r['text'], r['attributedBody'])[:300], 'fromMe': bool(r['is_from_me']),
            'senderName': None if r['is_from_me'] else (CONTACTS.name(r['handle']) or r['handle']),
        })
    return out


URL_RE = re.compile(r'(?:https?://|www\.)[^\s<>"\'￼]+[^\s<>"\'.,:;!?)\]￼]', re.I)


def conversation_details(conn, conv):
    """Contact cards for each participant plus the photos, links and files shared in the conversation."""
    chats = conv['chats']
    ph = placeholders(len(chats))
    people = [{'handle': h, 'name': CONTACTS.name(h), 'hasPhoto': CONTACTS.has_photo(h), 'card': CONTACTS.card(h)}
              for h in conv['participants']]

    base = ('FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id '
            'JOIN message_attachment_join maj ON maj.message_id = m.ROWID JOIN attachment a ON a.ROWID = maj.attachment_id '
            'WHERE cmj.chat_id IN (%s) AND a.filename IS NOT NULL' % ph)
    media = " AND (a.mime_type LIKE 'image/%' OR a.mime_type LIKE 'video/%')"
    if 'is_sticker' in cols(conn, 'attachment'):
        media += ' AND IFNULL(a.is_sticker, 0) = 0'
    photos = [{'id': r[0], 'kind': 'video' if (r[1] or '').startswith('video/') else 'image',
               'date': apple_to_ms(r[2]), 'fromMe': bool(r[3])}
              for r in conn.execute('SELECT a.ROWID, a.mime_type, cmj.message_date, m.is_from_me ' + base + media +
                                    ' ORDER BY cmj.message_date DESC LIMIT 120', chats)]
    photo_count = conn.execute('SELECT COUNT(*) ' + base + media, chats).fetchone()[0]

    files = []
    q = ('SELECT a.ROWID, a.transfer_name, a.filename, a.total_bytes, cmj.message_date, m.is_from_me ' + base +
         " AND NOT (IFNULL(a.mime_type, '') LIKE 'image/%' OR IFNULL(a.mime_type, '') LIKE 'video/%'"
         " OR IFNULL(a.mime_type, '') LIKE 'audio/%') ORDER BY cmj.message_date DESC LIMIT 60")
    for aid, tname, fname, size, d, me in conn.execute(q, chats):
        name = tname or os.path.basename(fname or '')
        if not name.endswith('.pluginPayloadAttachment'):
            files.append({'id': aid, 'name': name, 'size': size or 0, 'date': apple_to_ms(d), 'fromMe': bool(me)})

    links, seen = [], set()
    q = ('SELECT m.text, m.attributedBody, cmj.message_date, m.is_from_me FROM chat_message_join cmj '
         'JOIN message m ON m.ROWID = cmj.message_id WHERE cmj.chat_id IN (%s) '
         'AND (m.associated_message_type IS NULL OR m.associated_message_type = 0) '
         "AND (m.text LIKE '%%http%%' OR m.text LIKE '%%www.%%' OR instr(m.attributedBody, CAST('http' AS BLOB)) > 0) "
         'ORDER BY cmj.message_date DESC LIMIT 400' % ph)
    for text, body, d, me in conn.execute(q, chats):
        for url in URL_RE.findall(message_text(text, body)):
            full = url if url.lower().startswith('http') else 'https://' + url
            if full not in seen:
                seen.add(full)
                host = urllib.parse.urlsplit(full).netloc.lower()
                links.append({'url': full, 'host': host[4:] if host.startswith('www.') else host,
                              'date': apple_to_ms(d), 'fromMe': bool(me)})
        if len(links) >= 60:
            break

    count, first = conn.execute(
        'SELECT COUNT(*), MIN(cmj.message_date) FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id '
        'WHERE cmj.chat_id IN (%s) AND m.item_type = 0 '
        'AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)' % ph, chats).fetchone()
    return {
        'people': people, 'isGroup': conv['isGroup'], 'name': conv['displayName'],
        'photos': photos, 'photoCount': photo_count, 'files': files, 'links': links,
        'messageCount': count, 'since': apple_to_ms(first),
        'services': sorted({svc for _, svc in conv['guids'].values() if svc}),
    }


def find_conv_for_handle(conn, handle):
    CONVS.ensure(conn)
    key = normalize_handle(handle)
    for c in CONVS.convs.values():
        if not c['isGroup'] and c['participants'] and normalize_handle(c['participants'][0]) == key:
            return c['id']
    return None


def attachment_path(conn, att_id):
    r = conn.execute('SELECT filename, mime_type, transfer_name FROM attachment WHERE ROWID = ?', (att_id,)).fetchone()
    if not r or not r['filename']:
        return None, None, None
    path = os.path.realpath(os.path.expanduser(r['filename']))
    allowed = [os.path.realpath(os.path.join(HOME, 'Library/Messages')),
               os.path.realpath(os.path.join(HOME, 'Library/Containers/com.apple.MobileSMS')),
               os.path.realpath(UPLOAD_DIR)]
    if not any(path.startswith(a + os.sep) for a in allowed) and not os.environ.get('WEBIM_DB'):
        return None, None, None
    name = r['transfer_name'] or os.path.basename(path)
    mime = r['mime_type'] or mimetypes.guess_type(name)[0] or 'application/octet-stream'
    return path, mime, name


def converted(src, att_id, kind):
    """Convert HEIC/TIFF images to JPEG (optionally thumbnailed) and CAF/AMR audio to M4A, cached."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    try:
        mtime = int(os.path.getmtime(src))
    except OSError:
        return None
    ext = 'm4a' if kind == 'audio' else 'jpg'
    out = os.path.join(CACHE_DIR, '%d-%s-%d.%s' % (att_id, kind, mtime, ext))
    if os.path.exists(out):
        return out
    tmp = out + '.part.' + ext
    if kind == 'audio':
        cmd = ['afconvert', '-f', 'm4af', '-d', 'aac', src, tmp]
    else:
        cmd = ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80']
        if kind == 'thumb':
            cmd += ['-Z', '1200']
        cmd += [src, '--out', tmp]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True)
        os.replace(tmp, out)
        return out
    except (subprocess.SubprocessError, OSError):
        try:
            os.remove(tmp)
        except OSError:
            pass
        return None


# ---------------------------------------------------------------- sending

SEND_TO_CHAT = '''
on run argv
    set chatId to item 1 of argv
    set msgKind to item 2 of argv
    set payload to item 3 of argv
    if msgKind is "file" then
        set payload to POSIX file payload
    end if
    tell application "Messages"
        send payload to chat id chatId
    end tell
end run
'''

SEND_TO_HANDLE = '''
on run argv
    set addr to item 1 of argv
    set msgKind to item 2 of argv
    set payload to item 3 of argv
    set svcType to item 4 of argv
    if msgKind is "file" then
        set payload to POSIX file payload
    end if
    tell application "Messages"
        if svcType is "SMS" then
            set svc to 1st account whose service type = SMS
        else
            set svc to 1st account whose service type = iMessage
        end if
        send payload to participant addr of svc
    end tell
end run
'''

SEND_LOCK = threading.Lock()


def osascript(script, args):
    if DRY_RUN:
        print('[dry-run] osascript', args)
        return True, ''
    with SEND_LOCK:
        p = subprocess.run(['osascript', '-'] + list(args), input=script, capture_output=True, text=True, timeout=45)
    return p.returncode == 0, (p.stderr or '').strip()


def send_to_conv(conn, conv, kind, payload):
    # Prefer the chat that was used most recently.
    best, best_d = None, -1
    for chat_id in conv['chats']:
        r = conn.execute('SELECT MAX(message_date) FROM chat_message_join WHERE chat_id = ?', (chat_id,)).fetchone()
        if (r[0] or 0) > best_d:
            best, best_d = chat_id, r[0] or 0
    guid, service = conv['guids'][best]
    ok, err = osascript(SEND_TO_CHAT, [guid, kind, payload])
    if ok:
        return True, ''
    if not conv['isGroup'] and conv['participants']:
        handle = conv['participants'][0]
        order = ['SMS', 'iMessage'] if service.upper() in ('SMS', 'RCS') else ['iMessage', 'SMS']
        for svc in order:
            ok, err2 = osascript(SEND_TO_HANDLE, [handle, kind, payload, svc])
            if ok:
                return True, ''
            err = err2 or err
    return False, err


def send_to_handle(handle, kind, payload, service='iMessage'):
    ok, err = osascript(SEND_TO_HANDLE, [handle, kind, payload, service])
    if not ok and service == 'iMessage':
        ok, err = osascript(SEND_TO_HANDLE, [handle, kind, payload, 'SMS'])
    return ok, err


def save_upload(name, data):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    safe = re.sub(r'[^\w.\- ]', '_', os.path.basename(name or 'file'))[:120] or 'file'
    path = os.path.join(UPLOAD_DIR, '%d-%s-%s' % (int(time.time()), secrets.token_hex(3), safe))
    with open(path, 'wb') as f:
        f.write(data)
    return path


def cleanup_uploads():
    cutoff = time.time() - 3 * 86400
    for p in glob.glob(os.path.join(UPLOAD_DIR, '*')):
        try:
            if os.path.getmtime(p) < cutoff:
                os.remove(p)
        except OSError:
            pass


# ---------------------------------------------------------------- change watcher

class Watcher(threading.Thread):
    daemon = True

    def __init__(self):
        super().__init__()
        self.cond = threading.Condition()
        self.version = 0
        self.sig = None

    def run(self):
        last_contacts = 0
        while True:
            sig = []
            for suffix in ('', '-wal'):
                try:
                    st = os.stat(DB_PATH + suffix)
                    sig.append((st.st_mtime_ns, st.st_size))
                except OSError:
                    sig.append(None)
            if sig != self.sig:
                self.sig = sig
                with self.cond:
                    self.version += 1
                    self.cond.notify_all()
            reload_config_if_changed()
            if time.time() - last_contacts > 600:
                last_contacts = time.time()
                try:
                    CONTACTS.refresh()
                except Exception as e:  # never let contacts kill the watcher
                    print('contacts refresh failed:', e, file=sys.stderr)
            time.sleep(0.5)

    def wait(self, seen, timeout):
        with self.cond:
            self.cond.wait_for(lambda: self.version != seen, timeout)
            return self.version

    def poke(self):
        with self.cond:
            self.cond.notify_all()

    def wait_any(self, seen, seen_call, timeout):
        with self.cond:
            self.cond.wait_for(lambda: self.version != seen or CALLS.version != seen_call, timeout)
            return self.version, CALLS.version


WATCHER = Watcher()
CALLS = calls.CallManager(CONF_DIR, WATCHER.poke)
TLS = {'port': None, 'ca': None}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = 'web-imessage'

    def log_message(self, fmt, *args):
        if os.environ.get('WEBIM_LOG'):
            super().log_message(fmt, *args)

    def setup(self):
        if isinstance(self.request, ssl.SSLSocket):
            self.request.settimeout(15)
            self.request.do_handshake()
            self.request.settimeout(None)
        super().setup()

    # -- plumbing
    def client_ip(self):
        return self.client_address[0]

    def authed(self):
        c = cookies.SimpleCookie(self.headers.get('Cookie', ''))
        return 'webim' in c and check_token(c['webim'].value)

    def send_json(self, obj, status=200, extra_headers=None):
        body = json.dumps(obj, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit=1024 * 1024):
        n = int(self.headers.get('Content-Length') or 0)
        if n > limit:
            raise ValueError('too large')
        return self.rfile.read(n) if n else b''

    def read_json(self):
        if 'application/json' not in (self.headers.get('Content-Type') or ''):
            raise ValueError('expected json')
        return json.loads(self.read_body() or b'{}')

    def send_file(self, path, mime, name=None, cache=True, download=False):
        try:
            size = os.path.getsize(path)
            f = open(path, 'rb')
        except OSError:
            return self.send_json({'error': 'not found'}, 404)
        with f:
            start, end, status = 0, size - 1, 200
            rng = self.headers.get('Range')
            m = re.match(r'bytes=(\d*)-(\d*)$', rng or '')
            if m and size:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                if start > end:
                    self.send_response(416)
                    self.send_header('Content-Range', 'bytes */%d' % size)
                    self.end_headers()
                    return
                status = 206
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Accept-Ranges', 'bytes')
            if status == 206:
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
            self.send_header('Cache-Control', 'private, max-age=31536000' if cache else 'no-cache')
            if name:
                self.send_header('Content-Disposition', "%s; filename*=UTF-8''%s" % ('attachment' if download else 'inline', urllib.parse.quote(name)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            f.seek(start)
            remaining = end - start + 1
            try:
                while remaining > 0:
                    chunk = f.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    # -- routing
    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def route(self, method):
        url = urllib.parse.urlsplit(self.path)
        path, qs = url.path, urllib.parse.parse_qs(url.query)
        q = lambda k, d=None: qs.get(k, [d])[0]
        try:
            if path == '/ca.crt' and TLS['ca']:
                return self.send_file(TLS['ca'], 'application/x-x509-ca-cert', 'web-imessage-ca.crt', cache=False, download=True)
            if not path.startswith('/api/'):
                return self.static(path)
            if path == '/api/login' and method == 'POST':
                return self.login()
            if path == '/api/logout' and method == 'POST':
                return self.send_json({'ok': True}, extra_headers={'Set-Cookie': 'webim=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'})
            if not self.authed():
                return self.send_json({'error': 'auth'}, 401)
            if path == '/api/events':
                return self.events()
            if path == '/api/avatar':
                img = CONTACTS.photo(q('h', ''))
                if not img:
                    return self.send_json({'error': 'none'}, 404)
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Content-Length', str(len(img)))
                self.send_header('Cache-Control', 'private, max-age=3600')
                self.end_headers()
                self.wfile.write(img)
                return
            if path == '/api/contacts':
                with CONTACTS.lock:
                    return self.send_json({'contacts': CONTACTS.people})
            if path.startswith('/api/call/'):
                return self.call_api(method, path, q)

            conn = db()
            try:
                return self.api(method, path, q, conn)
            finally:
                conn.close()
        except NoAccess as e:
            self.send_json({'error': 'no_access', 'detail': str(e)}, 503)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ValueError as e:
            self.send_json({'error': str(e)}, 400)
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                self.send_json({'error': 'server', 'detail': str(e)}, 500)
            except Exception:
                pass

    def api(self, method, path, q, conn):
        if path == '/api/me':
            return self.send_json({'ok': True, 'version': WATCHER.version})
        if path == '/api/conversations' and method == 'GET':
            return self.send_json({'conversations': list_conversations(conn), 'version': WATCHER.version})
        if path == '/api/search':
            term = (q('q') or '').strip()
            return self.send_json({'results': search_messages(conn, term) if len(term) >= 2 else []})
        if path == '/api/lookup':
            return self.send_json({'convId': find_conv_for_handle(conn, q('h', ''))})
        if path == '/api/new' and method == 'POST':
            return self.new_conversation(conn)

        m = re.match(r'^/api/attachments/(\d+)$', path)
        if m:
            return self.attachment(conn, int(m.group(1)), q('v'))

        m = re.match(r'^/api/conversations/(\d+)/(messages|send|send-file|read|details)$', path)
        if m:
            conv = CONVS.get(conn, int(m.group(1)))
            if not conv:
                return self.send_json({'error': 'no such conversation'}, 404)
            action = m.group(2)
            if action == 'details':
                return self.send_json(conversation_details(conn, conv))
            if action == 'messages':
                return self.send_json(get_messages(
                    conn, conv, before=parse_cursor(q('before')), since=parse_cursor(q('since')),
                    limit=min(int(q('limit', '60')), 200)))
            if method != 'POST':
                return self.send_json({'error': 'method'}, 405)
            if action == 'read':
                d = conn.execute('SELECT MAX(message_date) FROM chat_message_join WHERE chat_id IN (%s)' % placeholders(len(conv['chats'])), conv['chats']).fetchone()[0]
                set_viewed(conv['id'], d or 0)
                return self.send_json({'ok': True})
            if action == 'send':
                text = (self.read_json().get('text') or '').strip()
                if not text:
                    raise ValueError('empty message')
                ok, err = send_to_conv(conn, conv, 'text', text)
                return self.send_json({'ok': ok, 'error': err}, 200 if ok else 502)
            if action == 'send-file':
                data = self.read_body(MAX_UPLOAD)
                fpath = save_upload(q('name', 'file'), data)
                ok, err = send_to_conv(conn, conv, 'file', fpath)
                return self.send_json({'ok': ok, 'error': err}, 200 if ok else 502)
        return self.send_json({'error': 'not found'}, 404)

    def new_conversation(self, conn):
        if self.headers.get('Content-Type', '').startswith('application/json'):
            body = self.read_json()
            to, text, name, data = body.get('to', '').strip(), (body.get('text') or '').strip(), None, None
        else:
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            to, name, text = qs.get('to', [''])[0].strip(), qs.get('name', ['file'])[0], ''
            data = self.read_body(MAX_UPLOAD)
        if not to:
            raise ValueError('missing recipient')
        existing = find_conv_for_handle(conn, to)
        if existing:
            conv = CONVS.get(conn, existing)
            ok, err = send_to_conv(conn, conv, 'file' if data else 'text', save_upload(name, data) if data else text)
        else:
            if '@' not in to:
                digits = re.sub(r'[^\d+]', '', to)
                if len(digits.lstrip('+')) == 10 and not digits.startswith('+'):
                    digits = '+1' + digits
                to = digits
            ok, err = send_to_handle(to, 'file' if data else 'text', save_upload(name, data) if data else text)
        if not ok:
            return self.send_json({'ok': False, 'error': err}, 502)
        conv_id = existing
        deadline = time.time() + 8
        while conv_id is None and time.time() < deadline:
            time.sleep(0.5)
            c2 = db()
            try:
                CONVS.version = None
                conv_id = find_conv_for_handle(c2, to)
            finally:
                c2.close()
        return self.send_json({'ok': True, 'convId': conv_id})

    def attachment(self, conn, att_id, variant):
        path, mime, name = attachment_path(conn, att_id)
        if not path or not os.path.exists(path):
            return self.send_json({'error': 'attachment not available'}, 404)
        if mime.startswith('image/') and variant in ('thumb', 'view') and mime not in BROWSER_IMAGE_TYPES:
            out = converted(path, att_id, 'thumb' if variant == 'thumb' else 'full')
            if out:
                return self.send_file(out, 'image/jpeg', os.path.splitext(name)[0] + '.jpg')
        if variant == 'thumb' and mime in ('image/jpeg', 'image/png') and os.path.getsize(path) > 600 * 1024:
            out = converted(path, att_id, 'thumb')
            if out:
                return self.send_file(out, 'image/jpeg', name)
        if mime.startswith('audio/') and variant == 'view' and mime not in ('audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/ogg'):
            out = converted(path, att_id, 'audio')
            if out:
                return self.send_file(out, 'audio/mp4', os.path.splitext(name)[0] + '.m4a')
        return self.send_file(path, mime, name, download=(variant == 'download'))

    def call_api(self, method, path, q):
        if path == '/api/call/status':
            return self.send_json({'call': CALLS.snapshot(), 'setup': CALLS.setup(), 'httpsPort': TLS['port'],
                                   'secure': isinstance(self.request, ssl.SSLSocket)})
        if path == '/api/call/ws':
            return self.call_socket(q('video') == '1')
        if path == '/api/call/debug':
            return self.send_json({'tree': CALLS.dump(), 'perm': CALLS.perm})
        if method != 'POST':
            return self.send_json({'error': 'method'}, 405)
        if path == '/api/call/start':
            body = self.read_json()
            kind = body.get('kind', 'phone')
            if kind not in ('phone', 'audio', 'video'):
                raise ValueError('bad call type')
            CALLS.start_call(body.get('handle') or '', kind)
            return self.send_json({'ok': True})
        if path == '/api/call/answer':
            return self.send_json({'ok': CALLS.command('accept')})
        if path == '/api/call/decline':
            return self.send_json({'ok': CALLS.command('decline')})
        if path == '/api/call/end':
            return self.send_json({'ok': CALLS.end_call()})
        return self.send_json({'error': 'not found'}, 404)

    def call_socket(self, want_video):
        # Cookies already authenticated us; also refuse sockets opened by other sites.
        origin = urllib.parse.urlsplit(self.headers.get('Origin') or '').netloc
        if origin and origin != self.headers.get('Host'):
            return self.send_json({'error': 'origin'}, 403)
        ws = calls.WebSocket.accept(self)
        if not ws:
            return self.send_json({'error': 'expected websocket'}, 400)
        if not CALLS.available():
            ws.send(json.dumps({'type': 'error', 'message': 'call helper is not built'}))
            ws.close()
            return
        CALLS.attach(ws, want_video)
        try:
            while True:
                msg = ws.recv()
                if msg is None:
                    break
                op, data = msg
                if op == 0x2 and data[:1] == b'\x01':
                    CALLS.feed_mic(ws, data[1:])
                elif op == 0x1:
                    try:
                        cmd = json.loads(data)
                    except ValueError:
                        continue
                    if cmd.get('video'):
                        CALLS.start_video(ws)
        finally:
            CALLS.detach(ws)

    def events(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()
        seen, seen_call = WATCHER.version, CALLS.version
        call_event = lambda: ('event: call\ndata: %s\n\n' % json.dumps(CALLS.snapshot())).encode()
        try:
            self.wfile.write(('event: hello\ndata: %d\n\n' % seen).encode() + call_event())
            self.wfile.flush()
            while True:
                v, vc = WATCHER.wait_any(seen, seen_call, 20)
                if vc != seen_call:
                    seen_call = vc
                    self.wfile.write(call_event())
                elif v != seen:
                    seen = v
                    time.sleep(0.25)  # let Messages finish its write burst
                    seen = WATCHER.version
                    self.wfile.write(('event: change\ndata: %d\n\n' % seen).encode())
                else:
                    self.wfile.write(b': ping\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def login(self):
        ip = self.client_ip()
        if login_blocked(ip):
            return self.send_json({'error': 'Too many attempts. Try again in a few minutes.'}, 429)
        try:
            pw = self.read_json().get('password', '')
        except ValueError:
            pw = ''
        if not hmac.compare_digest(pw.encode(), CONFIG['password'].encode()):
            LOGIN_FAILS.setdefault(ip, []).append(time.time())
            time.sleep(0.7)
            return self.send_json({'error': 'Wrong password'}, 403)
        cookie = 'webim=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Strict' % (make_token(), SESSION_DAYS * 86400)
        return self.send_json({'ok': True}, extra_headers={'Set-Cookie': cookie})

    def static(self, path):
        if path in ('/', ''):
            path = '/index.html'
        full = os.path.realpath(os.path.join(STATIC_DIR, path.lstrip('/')))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, 'index.html')  # SPA fallback
        mime = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        if full.endswith('.webmanifest'):
            mime = 'application/manifest+json'
        if mime.startswith('text/') or mime in ('application/javascript', 'application/manifest+json'):
            mime += '; charset=utf-8'
        return self.send_file(full, mime, cache=False)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def handle_error(self, request, client_address):
        err = sys.exc_info()[1]
        if isinstance(err, (ssl.SSLError, ConnectionError, TimeoutError, socket.timeout)):
            return  # e.g. a browser rejecting the self-signed certificate
        super().handle_error(request, client_address)


def start_https(host, port):
    try:
        cert, key, ca = calls.ensure_tls(os.path.join(CONF_DIR, 'tls'), lan_addresses())
    except (OSError, subprocess.SubprocessError) as e:
        print('https disabled: could not create a certificate (%s)' % e)
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd = Server((host, port), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    TLS.update(port=port, ca=ca)
    return httpd


def main():
    global CONFIG, STATE
    CONFIG = load_config()
    if '--set-password' in sys.argv:
        import getpass
        pw = getpass.getpass('New password: ')
        if len(pw) < 6:
            sys.exit('Password must be at least 6 characters.')
        if getpass.getpass('Repeat password: ') != pw:
            sys.exit('Passwords did not match; nothing changed.')
        CONFIG['password'] = pw
        CONFIG['secret'] = secrets.token_hex(32)  # invalidates existing sessions
        save_json(CONF_PATH, CONFIG)
        print('Password updated. A running server picks it up within a second; all browsers are signed out.')
        return
    STATE = load_json(STATE_PATH, {})
    reload_config_if_changed()
    mimetypes.add_type('application/javascript', '.js')
    mimetypes.add_type('image/heic', '.heic')
    mimetypes.add_type('image/heif', '.heif')

    try:
        db().close()
    except NoAccess as e:
        print('\n!! Cannot read %s (%s)' % (DB_PATH, e))
        print('!! Grant Full Disk Access to the app running this server (e.g. Terminal):')
        print('!!   System Settings → Privacy & Security → Full Disk Access\n')

    CONTACTS.refresh()
    cleanup_uploads()
    WATCHER.start()
    CALLS.start(CONFIG)

    host, port = CONFIG['host'], int(os.environ.get('WEBIM_PORT', CONFIG['port']))
    https_port = int(os.environ.get('WEBIM_HTTPS_PORT', CONFIG['https_port']))
    httpd = Server((host, port), Handler)
    secure = start_https(host, https_port)
    print('\nweb-imessage is running')
    for a in ['localhost'] + lan_addresses() + [n for n in calls.local_hostnames() if n.endswith('.local')][:1]:
        print('   http://%s:%d' % (a, port) + ('    https://%s:%d' % (a, https_port) if secure else ''))
    if secure:
        print('\nCalls need the https address. To avoid certificate warnings, open http://<this-mac>:%d/ca.crt'
              ' on the other computer and install it as a trusted root certificate.' % port)
    if not CALLS.available():
        print('Calls: helper not built (run ./start.sh, which builds bridge/callbridge).')
    print('\nPassword: %s   (change with: python3 server.py --set-password)\n' % CONFIG['password'])
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nbye')


if __name__ == '__main__':
    main()
