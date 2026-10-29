(function () {
  var API = '/.netlify/functions/clinic';
  var el = function (id) { return document.getElementById(id); };
  var pin = '';
  var view = null;
  var idx = 0;
  var busy = false;

  function fmtDate(ymd) {
    var p = ymd.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return p[1] + '월 ' + p[2] + '일(' + '일월화수목금토'[d.getUTCDay()] + ')';
  }
  function show(id, on) { el(id).classList.toggle('hidden', !on); }
  function setMsg(id, kind, text) { var m = el(id); m.className = 'msg ' + kind; m.textContent = text || ''; }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function recall(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  function post(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }
  function admin(action, extra) {
    var b = { action: action, pin: pin };
    for (var k in extra) b[k] = extra[k];
    return post(b);
  }

  function entriesText(list) {
    if (!list.length) return '신청한 학생이 없어요';
    return list.map(function (e) { return e.time + ' ' + e.name; }).join(' · ');
  }

  function render() {
    var w = view.weeks[idx];
    el('wLabel').textContent = fmtDate(w.date);
    el('wSub').textContent = idx === 0 ? '지금 신청 받는 클리닉' : (idx === 1 ? '다음 주' : idx + '주 뒤');
    el('prev').style.visibility = idx === 0 ? 'hidden' : 'visible';
    el('next').style.visibility = idx === view.weeks.length - 1 ? 'hidden' : 'visible';
    el('capNum').textContent = w.capacity;
    var left = Math.max(0, w.capacity - w.entries.length);
    var status = w.off ? '클리닉 없음' : (w.closed ? '마감됨' : (left > 0 ? '남은 자리 ' + left : '정원 마감'));
    el('stat').textContent = '신청 ' + w.entries.length + '명 · ' + status;
    el('capNote').textContent = w.isDefaultCapacity ? '' : '이번 주만 바꾼 정원이에요 (기본 ' + view.defaultCapacity + '명)';
    el('closeBtn').textContent = w.closed ? '신청 다시 열기' : '신청 마감하기';
    el('offBtn').textContent = w.off ? '클리닉 없음 해제' : '이번 주 클리닉 없음';
    show('offBox', w.off);
    if (w.off && document.activeElement !== el('reason')) el('reason').value = w.reason;
    var list = el('list');
    list.innerHTML = '';
    if (!w.entries.length) {
      var em = document.createElement('div'); em.className = 'empty'; em.textContent = '아직 신청한 학생이 없어요'; list.appendChild(em);
    }
    w.entries.forEach(function (e) {
      var r = document.createElement('div'); r.className = 'row';
      var t = document.createElement('span'); t.className = 't'; t.textContent = e.time;
      var n = document.createElement('span'); n.className = 'n'; n.textContent = e.name;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'small'; b.textContent = '삭제';
      b.setAttribute('data-del', e.name);
      b.onclick = function () { run('removeEntry', { date: w.date, name: e.name }); };
      r.appendChild(t); r.appendChild(n); r.appendChild(b);
      list.appendChild(r);
    });
    var p = view.previous;
    el('prevLabel').textContent = (p.isToday ? '오늘 진행 중 · ' : '지난 클리닉 · ') + fmtDate(p.date);
    el('prevText').textContent = entriesText(p.entries);
  }

  function run(action, extra) {
    if (busy) return Promise.resolve();
    busy = true;
    return admin(action, extra).then(function (j) {
      if (j.ok) { view = j.data; setMsg('msg', 'info', ''); render(); }
      else if (j.code === 'badpin' || j.code === 'locked' || j.code === 'nopin') { logout(j.error); }
      else setMsg('msg', 'err', j.error || '저장하지 못했어요');
    }).catch(function () { setMsg('msg', 'err', '연결이 불안정해요. 잠시 후 다시 해 주세요'); })
      .then(function () { busy = false; });
  }

  function enter(v) {
    view = v;
    if (idx >= view.weeks.length) idx = 0;
    show('setupCard', false); show('loginCard', false); show('main', true);
    render();
  }
  function logout(message) {
    pin = ''; view = null; store('clinicPin', null);
    show('main', false); show('setupCard', false); show('loginCard', true);
    setMsg('lpMsg', message ? 'err' : 'info', message || '');
  }

  function tryLogin(p, quiet) {
    pin = p;
    return admin('adminState', {}).then(function (j) {
      if (j.ok) { if (el('remember').checked) store('clinicPin', p); enter(j.data); }
      else {
        pin = '';
        if (j.code === 'badpin') store('clinicPin', null);
        show('loginCard', true);
        if (!quiet || j.code === 'locked') setMsg('lpMsg', 'err', j.error);
      }
    }).catch(function () { show('loginCard', true); setMsg('lpMsg', 'err', '연결이 불안정해요. 잠시 후 다시 해 주세요'); });
  }

  el('lpGo').onclick = function () {
    var p = el('lp').value;
    if (!p) { setMsg('lpMsg', 'err', 'PIN을 입력해 주세요'); return; }
    tryLogin(p, false);
  };
  el('lp').onkeydown = function (e) { if (e.key === 'Enter') el('lpGo').onclick(); };
  el('logout').onclick = function () { logout(''); el('lp').value = ''; };

  el('spGo').onclick = function () {
    var a = el('sp1').value, b = el('sp2').value;
    if (a !== b) { setMsg('spMsg', 'err', '두 PIN이 달라요. 다시 입력해 주세요'); return; }
    post({ action: 'setPin', newPin: a }).then(function (j) {
      if (!j.ok) { setMsg('spMsg', 'err', j.error); return; }
      pin = a; store('clinicPin', a); enter(j.data);
    }).catch(function () { setMsg('spMsg', 'err', '연결이 불안정해요. 잠시 후 다시 해 주세요'); });
  };

  el('cpGo').onclick = function () {
    var cur = el('cp0').value, nw = el('cp1').value;
    post({ action: 'setPin', pin: cur, newPin: nw }).then(function (j) {
      if (!j.ok) { setMsg('cpMsg', 'err', j.error); return; }
      pin = nw; store('clinicPin', recall('clinicPin') ? nw : null);
      el('cp0').value = ''; el('cp1').value = '';
      setMsg('cpMsg', 'ok', 'PIN을 바꿨어요');
    }).catch(function () { setMsg('cpMsg', 'err', '연결이 불안정해요. 잠시 후 다시 해 주세요'); });
  };

  el('prev').onclick = function () { if (idx > 0) { idx--; render(); } };
  el('next').onclick = function () { if (view && idx < view.weeks.length - 1) { idx++; render(); } };
  el('capMinus').onclick = function () { var w = view.weeks[idx]; if (w.capacity > 1) run('setCapacity', { date: w.date, capacity: w.capacity - 1 }); };
  el('capPlus').onclick = function () { var w = view.weeks[idx]; if (w.capacity < 20) run('setCapacity', { date: w.date, capacity: w.capacity + 1 }); };
  el('closeBtn').onclick = function () { var w = view.weeks[idx]; run('setClosed', { date: w.date, closed: !w.closed }); };
  el('offBtn').onclick = function () { var w = view.weeks[idx]; run('setOff', { date: w.date, off: !w.off, reason: w.reason }); };
  el('reasonSave').onclick = function () { var w = view.weeks[idx]; run('setOff', { date: w.date, off: true, reason: el('reason').value }); };
  el('ab').onclick = function () {
    var n = el('an').value.trim();
    if (!n) { setMsg('msg', 'err', '추가할 이름을 입력해 주세요'); return; }
    var w = view.weeks[idx];
    run('addEntry', { date: w.date, name: n, time: el('at').value }).then(function () { el('an').value = ''; });
  };

  function buildTimeSelect(times) {
    var s = el('at'); s.innerHTML = '';
    times.forEach(function (t) { var o = document.createElement('option'); o.value = t; o.textContent = t; s.appendChild(o); });
  }
  buildTimeSelect(['7:00', '7:30', '8:00', '8:30', '9:00']);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && pin && view && !busy) {
      admin('adminState', {}).then(function (j) { if (j.ok) { view = j.data; render(); } }).catch(function () {});
    }
  });

  fetch(API, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) throw new Error('fail');
    if (!j.data.hasPin) { show('setupCard', true); return; }
    var saved = recall('clinicPin');
    if (saved) tryLogin(saved, true);
    else show('loginCard', true);
  }).catch(function () { show('loginCard', true); setMsg('lpMsg', 'err', '불러오지 못했어요. 새로고침해 주세요'); });
})();
