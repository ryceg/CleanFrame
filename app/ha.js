/* Home Assistant bridge. Reads window.GrayFrameHA from the private build overlay; absent config means no HA features. */
(function () {
  'use strict';
  var C = window.GrayFrameHA && typeof window.GrayFrameHA === 'object' && window.GrayFrameHA.url && window.GrayFrameHA.token ? window.GrayFrameHA : null;
  var E = {
    weather: C && C.weather || 'weather.hobart',
    max: C && C.weather_max || 'sensor.hobart_temp_max_0',
    text: C && C.weather_text || 'sensor.hobart_short_text_0',
    rain: C && C.weather_rain || 'sensor.hobart_rain_chance_0',
    heat: C && C.heat_pump || 'climate.living_room_heat_pump',
    art: C && C.art_entity || 'image.living_room_the_frame_current_artwork'
  };
  var base = C ? String(C.url).replace(/\/+$/, '') : '';
  var states = {}, listeners = [], pending = {}, ws = null, nextId = 1, subId = 0, status = C ? 'connecting' : 'off', retry = 0, timer = 0, authFailed = false;

  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) { /* a listener error must not stop updates */ } } }
  function send(msg) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } return false; }
  function ids() { return Object.keys(E).map(function (k) { return E[k]; }); }

  function merge(target, source) { for (var k in source) if (Object.prototype.hasOwnProperty.call(source, k)) target[k] = source[k]; return target; }
  /* subscribe_entities sends compressed states: a = added/full, c = changes (+ added keys, - removed attribute keys), r = removed. */
  function apply(ev) {
    var id, s, d;
    if (ev.a) for (id in ev.a) if (Object.prototype.hasOwnProperty.call(ev.a, id)) states[id] = { state: ev.a[id].s, attributes: merge({}, ev.a[id].a || {}) };
    if (ev.c) for (id in ev.c) if (Object.prototype.hasOwnProperty.call(ev.c, id)) {
      s = states[id] || (states[id] = { state: null, attributes: {} }); d = ev.c[id];
      if (d['+']) { if (d['+'].s !== undefined) s.state = d['+'].s; if (d['+'].a) merge(s.attributes, d['+'].a); }
      if (d['-'] && d['-'].a) d['-'].a.forEach(function (key) { delete s.attributes[key]; });
    }
    if (ev.r) ev.r.forEach(function (rid) { delete states[rid]; });
    emit();
  }
  function settle(id, ok, error) {
    var done = pending[id];
    if (!done) return;
    delete pending[id];
    done(ok ? null : { message: error && error.message ? 'Home Assistant: ' + error.message : 'Home Assistant did not respond.' });
  }
  function onMessage(ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'auth_required') send({ type: 'auth', access_token: C.token });
    else if (m.type === 'auth_ok') {
      retry = 0; status = 'online'; subId = nextId++;
      send({ id: subId, type: 'subscribe_entities', entity_ids: ids() });
      emit();
    } else if (m.type === 'auth_invalid') { authFailed = true; status = 'auth'; emit(); ws.close(); }
    else if (m.type === 'event' && m.id === subId && m.event) apply(m.event);
    else if (m.type === 'result' && m.id !== subId) settle(m.id, m.success, m.error);
  }
  function schedule() {
    clearTimeout(timer);
    if (!C || document.hidden) return;
    // Bad credentials retry slowly; network failures back off from 2 s to 1 min.
    timer = setTimeout(connect, authFailed ? 300000 : Math.min(60000, 2000 * Math.pow(2, retry++)));
  }
  function connect() {
    clearTimeout(timer);
    if (!C || ws || document.hidden) return;
    try { ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/websocket'); }
    catch (e) { ws = null; status = 'offline'; emit(); schedule(); return; }
    if (status !== 'online') status = 'connecting';
    ws.onmessage = onMessage;
    ws.onclose = function () {
      ws = null; if (status !== 'auth') status = 'offline';
      Object.keys(pending).forEach(function (id) { settle(id, false, { message: 'connection lost.' }); });
      emit(); schedule();
    };
    ws.onerror = function () { /* onclose follows */ };
  }
  function call(domain, service, entityId, done) {
    var id = nextId++, finished = false, guard;
    function finish(err) { if (finished) return; finished = true; clearTimeout(guard); delete pending[id]; done(err); }
    if (!C) { done({ message: 'Home Assistant is not configured.' }); return; }
    pending[id] = finish;
    guard = setTimeout(function () { finish({ message: 'Home Assistant did not respond. Please try again.' }); }, 8000);
    if (!send({ id: id, type: 'call_service', domain: domain, service: service, target: { entity_id: entityId } })) finish({ message: 'Home Assistant is offline.' });
  }

  document.addEventListener('visibilitychange', function () {
    if (!C) return;
    if (document.hidden) { clearTimeout(timer); if (ws) ws.close(); }
    else { retry = 0; connect(); }
  });

  window.FrameHA = {
    configured: !!C,
    entities: E,
    status: function () { return status; },
    state: function (id) { return states[id] || null; },
    on: function (fn) { listeners.push(fn); },
    call: call,
    // entity_picture is a relative proxy URL with a rotating access token.
    picture: function (id) { var s = states[id], p = s && s.state !== 'unavailable' && s.attributes.entity_picture; return p ? (/^https?:/.test(p) ? p : base + p) : ''; },
    start: connect
  };
}());
