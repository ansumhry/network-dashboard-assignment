/* ==========================================================================
   app.js
   The PLAYER and the SYNC between the two panels.

   Core idea: the simulator makes a list of events. Each mode keeps
     { events: [...], index: N }
   The right panel shows events[0..index]. The left panel is drawn from
   events[index].ui. Because BOTH panels are drawn from the same index,
   they can never disagree: Next, Back, Play, scrubbing and Replay all
   just change `index` and call update().
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- helpers ---------- */
  var $ = function (s) { return document.querySelector(s); };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function fmtT(ms) { return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s'; }
  function fmtNum(n) { return Number(n).toLocaleString('en-US'); }
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- state ---------- */
  var COL = { resolver: 16.67, client: 50, server: 83.33 };   // lifeline positions in %
  var MODES = {
    browse: { actors: { resolver: 'DNS resolver', client: 'Browser',      server: 'Web server'   }, serverWord: 'the web server',  idle: 'Enter a web address and press Visit.' },
    mail:   { actors: { resolver: 'DNS resolver', client: 'Mail client',  server: 'Mail server'  }, serverWord: 'the mail server', idle: 'Write a message and press Send.' },
    stream: { actors: { resolver: 'DNS resolver', client: 'Video player', server: 'Video server' }, serverWord: 'the video server', idle: 'Press Play video to start streaming.' }
  };
  var sessions = {
    browse: { events: [], index: -1, meta: {} },
    mail:   { events: [], index: -1, meta: {} },
    stream: { events: [], index: -1, meta: {} }
  };
  var mode = 'browse';
  var speed = 1;
  var timer = null;            // visualization auto-step timer
  var userPaused = false;      // true once the person pressed Pause / Back / Next / scrubbed
  var stream = new Sim.StreamSession();
  var streamTimer = null;      // "video clock": asks for the next segment while playing

  function S() { return sessions[mode]; }
  function currentEvent() { var s = S(); return s.index >= 0 ? s.events[s.index] : null; }

  /* ---------- elements ---------- */
  var stageEl = $('#stage'), rowsEl = $('#rows'), actorsEl = $('#actors'), emptyEl = $('#empty');
  var detailEl = $('#detail'), statusEl = $('#status-text'), dotEl = $('#status-dot'), logEl = $('#log');
  var btnBack = $('#btn-back'), btnNext = $('#btn-next'), btnPlay = $('#btn-play'), btnReplay = $('#btn-replay');
  var scrub = $('#scrub'), stepCount = $('#step-count'), speedSel = $('#speed'), eolToggle = $('#opt-eol');

  /* =====================================================================
     RIGHT PANEL: sequence diagram
     ===================================================================== */
  function makeRow(e, i) {
    var row = document.createElement('div');
    row.className = 'row p-' + e.protocol.toLowerCase() + ' ' + e.dir;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.dataset.i = i;
    row.setAttribute('aria-label', 'Step ' + (i + 1) + ': ' + e.label);

    var gut = document.createElement('span');
    gut.className = 'gutter';
    gut.innerHTML = '<b>' + (i + 1) + '</b><time>' + fmtT(e.t_ms) + '</time>';
    row.appendChild(gut);

    if (e.dir === 'local') {
      var box = document.createElement('span');
      box.className = 'note-box';
      box.textContent = e.label;
      row.appendChild(box);
    } else {
      var from = e.dir === 'c2s' ? COL.client : COL[e.peer];
      var to = e.dir === 'c2s' ? COL[e.peer] : COL.client;
      row.classList.add(to > from ? 'goes-right' : 'goes-left');
      var left = Math.min(from, to), width = Math.abs(to - from);
      var lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.style.left = left + '%';
      lbl.style.width = width + '%';
      lbl.textContent = e.label;
      lbl.title = e.label;
      var arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.style.left = left + '%';
      arrow.style.width = width + '%';
      row.appendChild(lbl);
      row.appendChild(arrow);
    }
    return row;
  }
  function clearRows() {
    rowsEl.querySelectorAll('.row').forEach(function (r) { r.remove(); });
  }
  function addRows(from) {
    var s = S();
    for (var i = from; i < s.events.length; i++) rowsEl.appendChild(makeRow(s.events[i], i));
  }
  function rebuildRows() { clearRows(); addRows(0); }

  function scrollToCurrent() {
    var row = rowsEl.querySelector('.row.current');
    if (!row) { stageEl.scrollTop = 0; return; }
    var sr = stageEl.getBoundingClientRect(), rr = row.getBoundingClientRect();
    var head = actorsEl.offsetHeight;
    var delta = 0;
    if (rr.bottom > sr.bottom - 8) delta = rr.bottom - sr.bottom + 16;
    else if (rr.top < sr.top + head + 8) delta = rr.top - (sr.top + head + 8);
    if (delta) stageEl.scrollBy({ top: delta, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function renderActors() {
    var a = MODES[mode].actors, s = S();
    var ipKnown = s.meta && s.meta.ipStep != null && s.index >= s.meta.ipStep;
    var serverIp = ipKnown ? s.meta.serverIp : (s.events.length && s.meta.ipStep == null && s.index >= 1 ? 'not found' : 'unknown yet');
    actorsEl.innerHTML =
      '<div><strong>' + a.resolver + '</strong><span>' + Sim.RESOLVER_IP + '</span></div>' +
      '<div><strong>' + a.client + '</strong><span>' + Sim.CLIENT_IP + '</span></div>' +
      '<div><strong>' + a.server + '</strong><span>' + escapeHtml(serverIp) + '</span></div>';
  }

  /* Highlight key fields in the raw message, and mark line endings. */
  function renderRaw(raw, hl) {
    var list = (hl || []).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    function piece(t) {
      return escapeHtml(t).replace(/\r\n/g, '<span class="eol">\\r\\n</span>\n');
    }
    if (!list.length) return piece(raw);
    var re = new RegExp('(' + list.map(escRe).join('|') + ')', 'g');
    return raw.split(re).map(function (seg, k) {
      return k % 2 ? '<mark>' + piece(seg) + '</mark>' : piece(seg);
    }).join('');
  }

  function renderDetail() {
    var e = currentEvent(), m = MODES[mode];
    if (!e) {
      detailEl.innerHTML = '<p class="detail-empty">Pick an activity on the left and press its button. Each message will be explained here as it appears.</p>';
      return;
    }
    var dirText;
    if (e.dir === 'local') dirText = 'Inside the ' + m.actors.client.toLowerCase();
    else {
      var peer = m.actors[e.peer];
      dirText = e.dir === 'c2s' ? m.actors.client + ' \u2192 ' + peer : peer + ' \u2192 ' + m.actors.client;
    }
    var html = '<div class="d-head">' +
      '<span class="chip p-' + e.protocol.toLowerCase() + '">' + e.protocol + '</span>' +
      '<h3>' + escapeHtml(e.label) + '</h3>' +
      '<span class="dir ' + e.dir + '">' + escapeHtml(dirText) + '</span></div>' +
      '<p class="d-meta"><span>' + escapeHtml(e.transport) + '</span><span>at ' + fmtT(e.t_ms) + '</span></p>';
    html += '<pre class="raw ' + e.dir + '" tabindex="0">' + renderRaw(e.raw, e.highlight) + '</pre>';
    if (e.note) html += '<p class="d-note">' + escapeHtml(e.note) + '</p>';
    if (e.fields && e.fields.length) {
      html += '<dl class="fields">' + e.fields.map(function (f) {
        return '<div><dt>' + escapeHtml(f[0]) + '</dt><dd>' + escapeHtml(f[1]) + '</dd></div>';
      }).join('') + '</dl>';
    }
    detailEl.innerHTML = html;
  }

  /* =====================================================================
     LEFT PANEL: everything here is drawn from events[index].ui
     ===================================================================== */
  function renderBrowserView(p) {
    var el = $('#preview-browse');
    if (!p) {
      el.innerHTML = '<div class="bv"><div class="bv-bar"><span class="bv-url">about:blank</span></div>' +
        '<div class="bv-body bv-empty">Nothing loaded yet.</div></div>';
      return;
    }
    var body;
    if (p.state === 'error') {
      body = '<div class="bv-error"><h4>Can\u2019t reach this site</h4><p>' + escapeHtml(p.message) + '</p></div>';
    } else if (!p.title) {
      body = '<div class="bv-loading">Loading\u2026</div>';
    } else {
      body = '<h4>' + escapeHtml(p.title) + '</h4><p>' + (p.message ? escapeHtml(p.message) : 'This page was served by ' + escapeHtml(p.host) + '.') + '</p>';
    }
    var files = p.objects.map(function (o) {
      return '<li class="' + (o.done ? 'done' : '') + '">' + escapeHtml(o.name) + '</li>';
    }).join('');
    var done = p.objects.filter(function (o) { return o.done; }).length;
    el.innerHTML = '<div class="bv"><div class="bv-bar"><span class="bv-scheme ' + (p.secure ? 'secure' : '') + '">' + (p.secure ? 'https' : 'http') + '</span><span class="bv-url">' + escapeHtml(p.url) + '</span></div>' +
      '<div class="bv-body">' + body + '</div>' +
      (p.state === 'error' ? '' : '<ul class="bv-files">' + files + '</ul>') +
      '<div class="bv-foot">' + (p.state === 'error' ? 'No connection made' : 'Files loaded ' + done + ' of ' + p.objects.length + '. TCP connections opened: ' + p.conns) + '</div></div>';
  }

  function renderMailCard(m) {
    var el = $('#preview-mail');
    if (!m) {
      el.innerHTML = '<div class="mailcard"><p class="mc-empty">Outbox is empty.</p></div>';
      return;
    }
    var badge = m.state === 'sent' ? 'Accepted by ' + m.server + ' (queue ID ' + m.queueId + ')'
      : m.state === 'error' ? m.message
      : 'Sending\u2026' + (m.server ? ' via ' + m.server : '');
    el.innerHTML = '<div class="mailcard ' + m.state + '"><dl>' +
      '<dt>From</dt><dd>' + escapeHtml(m.from) + '</dd>' +
      '<dt>To</dt><dd>' + escapeHtml(m.to) + '</dd>' +
      '<dt>Subject</dt><dd>' + escapeHtml(m.subject || '(no subject)') + '</dd></dl>' +
      '<p class="mc-badge">' + escapeHtml(badge) + '</p></div>';
  }

  function renderVideo(v) {
    var el = $('#preview-stream');
    var state = v ? v.state : 'idle';
    var label = { idle: 'Ready', buffering: 'Buffering\u2026', playing: 'Playing', paused: 'Paused', ended: 'Finished' }[state];
    var q = v ? v.quality : stream.quality;
    var total = v ? v.total : 10, fetched = v ? v.fetched : 0;
    var segs = '';
    for (var i = 0; i < total; i++) segs += '<i class="' + (i < fetched ? 'on' : '') + '"></i>';
    el.innerHTML = '<div class="screen ' + state + '"><span class="q">' + escapeHtml(q) + '</span><span class="st">' + label + '</span></div>' +
      '<div class="segs" aria-hidden="true">' + segs + '</div>' +
      '<p class="segs-text">Segments fetched: ' + fetched + ' of ' + total + '</p>';
  }

  function tone(e) {
    if (!e) return 'idle';
    var u = e.ui;
    if (u.page) return u.page.state === 'error' ? 'error' : u.page.state === 'done' ? 'done' : 'busy';
    if (u.mail) return u.mail.state === 'error' ? 'error' : u.mail.state === 'sent' ? 'done' : 'busy';
    if (u.video) return u.video.state === 'playing' || u.video.state === 'ended' ? 'done' : u.video.state === 'paused' ? 'idle' : 'busy';
    return 'busy';
  }

  function renderLeft() {
    var s = S(), e = currentEvent();
    statusEl.textContent = e ? e.ui.status : MODES[mode].idle;
    dotEl.className = 'dot ' + tone(e);

    // log = every logged step up to the current one (so Back removes lines)
    var items = [];
    for (var i = 0; i <= s.index; i++) {
      var ev = s.events[i];
      if (ev && ev.ui && ev.ui.log) items.push('<li><time>' + fmtT(ev.t_ms) + '</time><span>' + escapeHtml(ev.ui.log) + '</span></li>');
    }
    logEl.innerHTML = items.join('') || '<li class="log-empty">Nothing has happened yet.</li>';
    logEl.scrollTop = logEl.scrollHeight;

    if (mode === 'browse') renderBrowserView(e && e.ui.page);
    if (mode === 'mail') renderMailCard(e && e.ui.mail);
    if (mode === 'stream') renderVideo(e && e.ui.video);
  }

  function syncStreamControls() {
    var b = $('#btn-video');
    b.textContent = stream.ended ? 'Watch again' : stream.playing ? 'Pause video' : 'Play video';
    $('#quality').value = stream.quality;
  }

  /* =====================================================================
     Player controls
     ===================================================================== */
  function renderControls() {
    var s = S(), n = s.events.length, has = n > 0;
    btnReplay.disabled = !has;
    btnPlay.disabled = !has;
    btnBack.disabled = !has || s.index <= 0;
    btnNext.disabled = !has || s.index >= n - 1;
    btnPlay.textContent = timer ? 'Pause' : 'Play';
    scrub.disabled = !has;
    scrub.max = Math.max(n - 1, 0);
    scrub.value = Math.max(s.index, 0);
    stepCount.textContent = has ? 'Step ' + (s.index + 1) + ' of ' + n : 'No steps yet';
  }

  function update() {
    var s = S();
    var rows = rowsEl.querySelectorAll('.row');
    rows.forEach(function (r, i) {
      r.classList.toggle('shown', i <= s.index);
      r.classList.toggle('current', i === s.index);
      if (i === s.index) r.setAttribute('aria-current', 'step'); else r.removeAttribute('aria-current');
    });
    emptyEl.hidden = s.events.length > 0;
    renderActors();
    renderDetail();
    renderLeft();
    renderControls();
    scrollToCurrent();
  }

  function goto(i) {
    var s = S();
    if (!s.events.length) return;
    s.index = Math.max(0, Math.min(s.events.length - 1, i));
    update();
  }
  function stopAuto() { if (timer) { clearInterval(timer); timer = null; } renderControls(); }
  function startAuto() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      var s = S();
      if (s.index < s.events.length - 1) goto(s.index + 1);
      else stopAuto();
    }, 1100 / speed);
    renderControls();
  }
  function manual(fn) { userPaused = true; stopAuto(); fn(); }

  btnBack.addEventListener('click', function () { manual(function () { goto(S().index - 1); }); });
  btnNext.addEventListener('click', function () { manual(function () { goto(S().index + 1); }); });
  btnReplay.addEventListener('click', function () { userPaused = false; goto(0); startAuto(); });
  btnPlay.addEventListener('click', function () {
    var s = S();
    if (timer) { userPaused = true; stopAuto(); return; }
    userPaused = false;
    if (s.index >= s.events.length - 1) goto(0);
    startAuto();
  });
  scrub.addEventListener('input', function () {
    var target = Number(scrub.value);          // read first: stopAuto() re-draws the slider
    manual(function () { goto(target); });
  });
  speedSel.addEventListener('change', function () {
    speed = Number(speedSel.value);
    if (timer) startAuto();
    manageStreamTimer(true);
  });
  eolToggle.addEventListener('change', function () { detailEl.classList.toggle('show-eol', eolToggle.checked); });

  rowsEl.addEventListener('click', function (e) {
    var row = e.target.closest('.row');
    if (row) manual(function () { goto(Number(row.dataset.i)); });
  });
  rowsEl.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('row')) {
      e.preventDefault();
      manual(function () { goto(Number(e.target.dataset.i)); });
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.target.closest('input, textarea, select, [role="tablist"]')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); manual(function () { goto(S().index + 1); }); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); manual(function () { goto(S().index - 1); }); }
  });

  /* Start a brand-new trace (Browsing and Mail). */
  function loadTrace(m, result) {
    sessions[m] = { events: result.events, index: 0, meta: result.meta };
    rebuildRows();
    userPaused = false;
    update();
    startAuto();
  }

  /* =====================================================================
     Tabs
     ===================================================================== */
  function setMode(m) {
    if (m === mode) return;
    if (mode === 'stream' && stream.playing) { streamAction(function () { return stream.pause(); }); }
    stopAuto();
    mode = m;
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.dataset.mode === m;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    ['browse', 'mail', 'stream'].forEach(function (k) { $('#pane-' + k).hidden = k !== m; });
    rebuildRows();
    userPaused = false;
    update();
    var s = S();
    if (s.events.length && s.index < s.events.length - 1) startAuto();
  }
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { setMode(t.dataset.mode); });
    t.addEventListener('keydown', function (e) {
      var order = ['browse', 'mail', 'stream'], i = order.indexOf(mode);
      if (e.key === 'ArrowRight') { setMode(order[(i + 1) % 3]); $('#tab-' + mode).focus(); }
      if (e.key === 'ArrowLeft')  { setMode(order[(i + 2) % 3]); $('#tab-' + mode).focus(); }
    });
  });

  /* =====================================================================
     Browsing and Mail forms
     ===================================================================== */
  function showError(id, msg) {
    var el = $(id);
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  $('#form-browse').addEventListener('submit', function (e) {
    e.preventDefault();
    showError('#err-browse', '');
    try {
      var result = Sim.browse({
        url: $('#url').value,
        showTransport: $('#opt-transport').checked,
        embedded: $('#opt-embedded').checked,
        connection: $('#opt-conn').value
      });
      loadTrace('browse', result);
    } catch (err) { showError('#err-browse', err.message); }
  });
  $('#form-mail').addEventListener('submit', function (e) {
    e.preventDefault();
    showError('#err-mail', '');
    try {
      var result = Sim.mail({
        from: $('#mail-from').value,
        to: $('#mail-to').value,
        subject: $('#mail-subject').value,
        body: $('#mail-body').value
      });
      loadTrace('mail', result);
    } catch (err) { showError('#err-mail', err.message); }
  });

  /* =====================================================================
     Streaming: the session keeps growing, so new events are APPENDED
     ===================================================================== */
  function streamAction(fn) {
    var s = sessions.stream, before = s.events.length;
    fn();                                    // mutates `stream`
    s.events = stream.events;
    s.meta = stream.meta;
    var grew = s.events.length > before;
    if (mode === 'stream' && grew) {
      addRows(before);
      if (s.index === -1) s.index = 0;
      if (!userPaused && !timer) startAuto();
      update();
    }
    syncStreamControls();
    manageStreamTimer();
  }

  function manageStreamTimer(restart) {
    if (restart && streamTimer) { clearInterval(streamTimer); streamTimer = null; }
    if (stream.playing && !streamTimer) {
      streamTimer = setInterval(function () {
        // The video clock waits while the right panel is still catching up
        // (or while you are stepping back through history), so the two
        // panels never drift apart.
        var s = sessions.stream;
        if (mode !== 'stream' || s.index < s.events.length - 1) return;
        streamAction(function () { stream.tick(); });
      }, 3000 / speed);
    } else if (!stream.playing && streamTimer) {
      clearInterval(streamTimer); streamTimer = null;
    }
  }

  $('#btn-video').addEventListener('click', function () {
    if (stream.ended) {                     // "Watch again": start a fresh session
      stream.reset();
      sessions.stream = { events: [], index: -1, meta: {} };
      rebuildRows();
    }
    userPaused = false;
    streamAction(function () { return stream.playing ? stream.pause() : stream.play(); });
  });
  $('#quality').addEventListener('change', function () {
    var q = $('#quality').value;
    userPaused = false;
    streamAction(function () { return stream.setQuality(q); });
    update();
  });
  $('#btn-reset').addEventListener('click', function () {
    stream.reset();
    if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
    sessions.stream = { events: [], index: -1, meta: {} };
    stopAuto();
    rebuildRows();
    update();
    syncStreamControls();
  });

  /* ---------- go ---------- */
  update();
  syncStreamControls();
})();
