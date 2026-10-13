'use strict';
// Phone and FaceTime pass-through: the call runs on the Mac, its audio (and FaceTime video) streams here,
// and this computer's microphone streams back. Uses helpers from app.js (api, postJSON, avatar, toast, ...).

const call = {
  s: { state: 'idle' },   // latest state from the server
  open: false,            // the in-call panel is showing
  ws: null, ctx: null, stream: null, mic: null, player: null,
  handle: '', name: '', kind: 'phone',
  muted: false, showVideo: true, sawActive: false, startedAt: null,
  tick: null, videoUrl: null, ring: null, notification: null, ending: false,
};
const CALL_KIND_LABEL = { phone: 'Phone call', audio: 'FaceTime Audio', video: 'FaceTime Video' };

function personFor(handle, name) {
  const key = (handle || '').replace(/\D/g, '').slice(-10);
  for (const c of state.convs) {
    for (const p of c.participants || []) {
      if ((handle && (p.handle === handle || (key.length >= 7 && p.handle.replace(/\D/g, '').endsWith(key))))
          || (name && p.name && p.name === name)) return p;
    }
  }
  return { handle: handle || name || '?', name: name || null, hasPhoto: false };
}

function fmtDuration(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ------------------------------------------------------------------ setup checks

async function callRequirements() {
  const s = await api('/api/call/status');
  const st = s.setup;
  const missing = [];
  if (!window.isSecureContext || !navigator.mediaDevices) missing.push('secure');
  if (!st.helper) missing.push('helper');
  if (!st.hasCapture || !st.hasMic) missing.push('audio');
  if (st.ax === false) missing.push('ax');
  if (st.screen === false) missing.push('screen');
  return { s, missing };
}

function showCallSetup(s, retry) {
  const st = s.setup;
  const secureUrl = s.httpsPort ? `https://${location.hostname}:${s.httpsPort}/${location.hash}` : null;
  const secure = window.isSecureContext && !!navigator.mediaDevices;
  const brew = 'brew install --cask blackhole-2ch blackhole-16ch';
  const steps = [
    {
      ok: secure, title: 'Open the secure address',
      body: secureUrl
        ? `Browsers only allow the microphone on https pages. Open <a href="${esc(secureUrl)}">${esc(secureUrl.replace(/\/#.*$/, ''))}</a>.
           To avoid the certificate warning, <a href="/ca.crt" download>download the certificate</a>, open it, choose
           <b>Install Certificate…</b> → <b>Current User</b> → <b>Place all certificates in the following store</b> →
           <b>Trusted Root Certification Authorities</b>, then restart the browser.`
        : 'The server could not create an https certificate; check the terminal on the Mac.',
    },
    {
      ok: st.hasCapture && st.hasMic, title: 'Install two virtual audio devices on the Mac',
      body: `In Terminal on the Mac, run this (it asks for the Mac's password):
             <span class="cmd"><code>${brew}</code><button data-copy="${brew}">Copy</button></span>
             They carry the call's sound to this browser and your microphone back into the call.`,
    },
    {
      ok: st.ax !== false, unknown: st.ax == null, title: 'Let the server see and answer calls',
      body: 'On the Mac: System Settings → Privacy &amp; Security → <b>Accessibility</b> → turn on <b>Terminal</b> (the app running the server).',
    },
    {
      ok: st.screen !== false, unknown: st.screen == null, title: 'Let the server see call banners and FaceTime video',
      body: 'On the Mac: System Settings → Privacy &amp; Security → <b>Screen &amp; System Audio Recording</b> → turn on <b>Terminal</b>. Since macOS 26, call banners can only be read from the screen.',
    },
    {
      ok: null, title: 'Phone calls go through your iPhone',
      body: 'On the iPhone: Settings → Apps → Phone → <b>Calls on Other Devices</b> → turn on this Mac. FaceTime must be signed in on the Mac.',
    },
  ];
  if (!st.helper) steps.splice(1, 0, { ok: false, title: 'Build the call helper', body: 'Restart the server on the Mac with <code>./start.sh</code>; it builds the helper automatically.' });
  const mark = (x) => (x.ok === null || x.unknown ? '<span class="mark info">i</span>' : x.ok ? '<span class="mark ok">✓</span>' : `<span class="mark ${x.optional ? 'info' : 'no'}">${x.optional ? '–' : '!'}</span>`);
  $('setupBody').innerHTML = steps.map((x) => `<div class="setup-step${x.ok ? ' done' : ''}">${mark(x)}<div><span class="st-title">${x.title}</span><p>${x.body}</p></div></div>`).join('')
    + `<div class="setup-actions"><button class="btn primary" id="setupRetry">Check Again</button></div>`;
  $('callSetup').hidden = false;
  $('setupRetry').onclick = async () => {
    const r = await callRequirements().catch(() => null);
    if (r && !r.missing.length) { $('callSetup').hidden = true; if (retry) retry(); }
    else if (r) { showCallSetup(r.s, retry); toast('Still needs setup'); }
  };
}
$('callSetup').addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { copyText(copy.dataset.copy); return; }
  if (e.target === $('callSetup') || e.target.closest('[data-close]')) $('callSetup').hidden = true;
});

// ------------------------------------------------------------------ choosing and starting calls

function chooseCall(anchor, handle, name) {
  const menu = $('callChooser');
  const isPhone = !String(handle).includes('@');
  const opts = [
    isPhone && ['phone', 'Phone Call', 'through your iPhone', DICON.call],
    ['audio', 'FaceTime Audio', '', DICON.call],
    ['video', 'FaceTime Video', '', DICON.video],
  ].filter(Boolean);
  menu.innerHTML = opts.map(([k, label, sub, icon]) => `<button class="menu-row" data-kind="${k}">${icon}<span>${label}${sub ? `<small>${sub}</small>` : ''}</span></button>`).join('');
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.min(window.innerHeight - 180, r.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 248, r.right - 240)) + 'px';
  menu.hidden = false;
  menu.onclick = (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    menu.hidden = true;
    startCall(handle, name, b.dataset.kind);
  };
}
document.addEventListener('click', (e) => {
  if (!$('callChooser').hidden && !e.target.closest('#callChooser, [data-act="call"], #callBtn')) $('callChooser').hidden = true;
});
$('callBtn').addEventListener('click', () => {
  const c = state.convById.get(state.currentId);
  const p = c && c.participants && c.participants[0];
  if (p) chooseCall($('callBtn'), p.handle, p.name || fmtHandle(p.handle));
});

async function startCall(handle, name, kind) {
  if (call.open) { toast('You are already in a call'); return; }
  let req;
  try { req = await callRequirements(); } catch (e) { return; }
  if (req.missing.length) { showCallSetup(req.s, () => startCall(handle, name, kind)); return; }
  openCallHud(handle, name, kind, 'Connecting…');
  try {
    await connectMedia(kind === 'video');
    await postJSON('/api/call/start', { handle, kind });
    setCallStatus(kind === 'phone' ? 'Calling via iPhone…' : 'Calling…');
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not start the call: ' + e.message, 5000);
    teardownCall();
  }
}

async function answerIncoming() {
  const s = call.s;
  stopRinging();
  hideBanner();
  let req;
  try { req = await callRequirements(); } catch (e) { return; }
  if (req.missing.length) { showCallSetup(req.s, answerIncoming); return; }
  const kind = /video/i.test(s.detail) ? 'video' : /facetime/i.test(s.detail) ? 'audio' : 'phone';
  const p = personFor('', s.caller);
  openCallHud(p.handle, s.caller || 'Unknown caller', kind, 'Connecting…');
  try {
    await connectMedia(kind === 'video');
    await postJSON('/api/call/answer');
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not answer: ' + e.message, 5000);
    teardownCall();
  }
}

async function joinActiveCall() {
  hideBanner();
  let req;
  try { req = await callRequirements(); } catch (e) { return; }
  if (req.missing.length) { showCallSetup(req.s, joinActiveCall); return; }
  openCallHud('', 'Call on the Mac', 'phone', 'Connecting…');
  try {
    await connectMedia(false);
    call.sawActive = true;
    call.startedAt = Date.now() - (call.s.elapsed || 0) * 1000;
  } catch (e) {
    toast('Could not join: ' + e.message, 5000);
    teardownCall();
  }
}

function endCall() {
  postJSON('/api/call/end').catch(() => {});
  setCallStatus('Ending…');
  teardownCall(400);
}

// ------------------------------------------------------------------ media

async function connectMedia(video) {
  call.ctx = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
  await call.ctx.audioWorklet.addModule('/call-worklet.js');
  call.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  if (!call.open) throw new Error('cancelled');
  const src = call.ctx.createMediaStreamSource(call.stream);
  call.mic = new AudioWorkletNode(call.ctx, 'mic-capture');
  const sink = call.ctx.createGain();
  sink.gain.value = 0; // keeps the capture node running without echoing the mic locally
  src.connect(call.mic).connect(sink).connect(call.ctx.destination);
  call.player = new AudioWorkletNode(call.ctx, 'net-player', { numberOfInputs: 0, outputChannelCount: [1] });
  call.player.connect(call.ctx.destination);
  call.player.port.onmessage = (e) => showLevel(e.data.level);

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/call/ws?video=${video ? 1 : 0}`);
  ws.binaryType = 'arraybuffer';
  call.ws = ws;
  call.mic.port.onmessage = (e) => {
    if (call.muted || ws.readyState !== WebSocket.OPEN) return;
    const pcm = new Uint8Array(e.data.pcm);
    const msg = new Uint8Array(pcm.length + 1);
    msg[0] = 1;
    msg.set(pcm, 1);
    ws.send(msg);
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let m = {};
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'error') toast('Call audio: ' + m.message, 6000);
      if (m.type === 'ended') endedRemotely();
      return;
    }
    const kind = new Uint8Array(e.data, 0, 1)[0];
    if (kind === 1) {
      const pcm = e.data.slice(1);
      call.player.port.postMessage(pcm, [pcm]);
    } else if (kind === 2) {
      showVideoFrame(new Uint8Array(e.data, 1));
    }
  };
  ws.onclose = () => { if (call.open && call.ws === ws && !call.ending) setCallStatus('Audio disconnected'); };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not connect to the Mac'));
    setTimeout(() => reject(new Error('timed out connecting to the Mac')), 10000);
  });
  if (call.ctx.state === 'suspended') await call.ctx.resume();
}

function showVideoFrame(bytes) {
  if (!call.open) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  const old = call.videoUrl;
  call.videoUrl = url;
  $('callVideoImg').src = url;
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  if (call.showVideo && $('callVideo').hidden) {
    $('callVideo').hidden = false;
    $('callHud').classList.add('has-video');
  }
}

function showLevel(level) {
  const bars = $('callLevel').children;
  const v = Math.min(1, level * 3);
  for (let i = 0; i < bars.length; i++) bars[i].style.transform = `scaleY(${0.25 + v * (0.75 - Math.abs(i - 1.5) * 0.15)})`;
}

// ------------------------------------------------------------------ in-call panel

function openCallHud(handle, name, kind, status) {
  Object.assign(call, { open: true, handle, name, kind, muted: false, sawActive: false, startedAt: null, showVideo: true, ending: false });
  const p = personFor(handle, name);
  $('callAvatar').innerHTML = avatar(p, 'lg');
  $('callName').textContent = name || fmtHandle(handle);
  $('callVideo').hidden = true;
  $('callHud').classList.remove('has-video', 'closing');
  $('callVideoBtn').hidden = kind !== 'video';
  $('callVideoBtn').setAttribute('aria-pressed', 'true');
  $('callMute').setAttribute('aria-pressed', 'false');
  $('callMute').querySelector('span').textContent = 'mute';
  setCallStatus(status);
  $('callHud').hidden = false;
  clearInterval(call.tick);
  call.tick = setInterval(updateCallTimer, 1000);
}

function setCallStatus(text) { $('callStatus').textContent = text; }

function updateCallTimer() {
  if (!call.open || !call.startedAt || call.ending) return;
  setCallStatus(fmtDuration(Date.now() - call.startedAt) + (call.muted ? ' · muted' : ''));
}

function endedRemotely() {
  if (!call.open || call.ending) return;
  setCallStatus('Call ended');
  teardownCall(1200);
}

function teardownCall(delay = 0) {
  call.ending = true;
  clearInterval(call.tick);
  const ws = call.ws;
  call.ws = null;
  if (ws) try { ws.close(); } catch (e) { /* already closed */ }
  if (call.stream) call.stream.getTracks().forEach((t) => t.stop());
  if (call.ctx) call.ctx.close().catch(() => {});
  Object.assign(call, { stream: null, ctx: null, mic: null, player: null });
  if (call.videoUrl) { URL.revokeObjectURL(call.videoUrl); call.videoUrl = null; }
  setTimeout(() => {
    const hud = $('callHud');
    const done = () => { hud.hidden = true; hud.classList.remove('closing'); call.open = false; call.ending = false; };
    if (speed()) { hud.classList.add('closing'); setTimeout(done, 280 * speed()); } else done();
  }, delay);
}

$('callEnd').addEventListener('click', endCall);
$('callMute').addEventListener('click', () => {
  call.muted = !call.muted;
  if (call.stream) call.stream.getAudioTracks().forEach((t) => { t.enabled = !call.muted; });
  $('callMute').setAttribute('aria-pressed', String(call.muted));
  $('callMute').querySelector('span').textContent = call.muted ? 'unmute' : 'mute';
  updateCallTimer();
});
$('callVideoBtn').addEventListener('click', () => {
  call.showVideo = !call.showVideo;
  $('callVideoBtn').setAttribute('aria-pressed', String(call.showVideo));
  $('callVideo').hidden = !call.showVideo || !call.videoUrl;
  $('callHud').classList.toggle('has-video', !$('callVideo').hidden);
  if (call.showVideo && call.ws) call.ws.send(JSON.stringify({ video: true }));
});

// ------------------------------------------------------------------ incoming calls

function showBanner(mode, title, detail, person) {
  const b = $('callBanner');
  b.dataset.mode = mode;
  $('bannerAvatar').innerHTML = avatar(person, 'md');
  $('bannerName').textContent = title;
  $('bannerDetail').textContent = detail;
  $('bannerAccept').setAttribute('aria-label', mode === 'join' ? 'Join call audio' : 'Accept');
  $('bannerDecline').setAttribute('aria-label', mode === 'join' ? 'End call' : 'Decline');
  b.classList.toggle('join', mode === 'join');
  b.hidden = false;
}

function hideBanner() {
  stopRinging();
  if (call.notification) { call.notification.close(); call.notification = null; }
  $('callBanner').hidden = true;
}

$('bannerAccept').addEventListener('click', () => ($('callBanner').dataset.mode === 'join' ? joinActiveCall() : answerIncoming()));
$('bannerDecline').addEventListener('click', () => {
  postJSON($('callBanner').dataset.mode === 'join' ? '/api/call/end' : '/api/call/decline').catch(() => {});
  hideBanner();
});

function startRinging() {
  if (call.ring) return;
  let ctx;
  try { ctx = new AudioContext(); } catch (e) { return; }
  const chime = () => {
    const t = ctx.currentTime + 0.02;
    [[1318.5, 0], [1046.5, 0.16], [1318.5, 0.32], [1046.5, 0.48]].forEach(([f, d]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.2, t + d + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(t + d);
      o.stop(t + d + 0.32);
    });
  };
  chime();
  call.ring = { ctx, timer: setInterval(chime, 2600) };
}

function stopRinging() {
  if (!call.ring) return;
  clearInterval(call.ring.timer);
  call.ring.ctx.close().catch(() => {});
  call.ring = null;
}

function onCallState(s) {
  const prev = call.s || { state: 'idle' };
  call.s = s;
  if (s.state === 'ringing' && !call.open) {
    const p = personFor('', s.caller);
    const fresh = $('callBanner').hidden || $('callBanner').dataset.mode !== 'incoming';
    showBanner('incoming', s.caller || 'Incoming call', s.detail || 'Incoming call', p);
    if (fresh) {
      startRinging();
      if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        call.notification = new Notification(s.caller || 'Incoming call', { body: s.detail || 'Incoming call', icon: '/icon.svg', requireInteraction: true, tag: 'call' });
        call.notification.onclick = () => { window.focus(); };
      }
    }
  } else if (s.state === 'active' && !call.open && !s.bridged) {
    if ($('callBanner').dataset.mode !== 'join' || $('callBanner').hidden) {
      hideBanner();
      showBanner('join', 'Call in progress on the Mac', 'Join to talk from this browser', { handle: 'call', name: null });
    }
  } else if (s.state !== 'ringing') {
    if (!$('callBanner').hidden && !(s.state === 'active' && !call.open && !s.bridged)) hideBanner();
  }
  if (call.open && !call.ending) {
    if (s.state === 'active') {
      call.sawActive = true;
      if (!call.startedAt) call.startedAt = Date.now() - (s.elapsed || 0) * 1000;
      updateCallTimer();
    } else if (s.state === 'idle' && (call.sawActive || prev.state === 'active')) {
      endedRemotely();
    }
  }
}
