(function () {
  var API = '/.netlify/functions/clinic';
  var el = function (id) { return document.getElementById(id); };
  var view = null;
  var sel = null;
  var busy = false;

  function fmtDate(ymd) {
    var p = ymd.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return p[1] + '월 ' + p[2] + '일(' + '일월화수목금토'[d.getUTCDay()] + ')';
  }
  function setMsg(kind, text) { var m = el('msg'); m.className = 'msg ' + kind; m.textContent = text || ''; }
  function getName() { return el('nm').value.replace(/\s+/g, ' ').trim(); }
  function saveName(n) { try { localStorage.setItem('clinicName', n); } catch (e) {} }

  function render() {
    var v = view;
    el('dateLine').textContent = fmtDate(v.date) + ' 저녁 7시 클리닉';
    el('deadline').textContent = '신청은 ' + fmtDate(v.date) + ' 저녁 7시까지 받아요';
    el('cnt').textContent = v.count + ' / ' + v.capacity + '명';
    el('bar').style.width = Math.min(100, Math.round(v.count / v.capacity * 100)) + '%';
    el('barBox').className = 'bar' + (v.status === 'full' ? ' full' : '');
    var b = el('banner');
    b.className = 'banner hidden';
    el('formArea').className = '';
    el('barRow').className = 'barrow';
    if (v.status === 'off') {
      b.className = 'banner off';
      b.textContent = v.reason ? '이번 주는 클리닉이 없어요 · ' + v.reason : '이번 주는 클리닉이 없어요';
      el('formArea').className = 'hidden';
      el('barRow').className = 'barrow hidden';
    } else if (v.status === 'closed') {
      b.className = 'banner closed';
      b.textContent = '이번 주 신청이 마감됐어요';
    } else if (v.status === 'full') {
      b.className = 'banner closed';
      b.textContent = '정원이 모두 찼어요 (' + v.capacity + '명)';
    }
  }

  function buildTimes() {
    var box = el('times');
    box.innerHTML = '';
    view.times.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = t;
      b.setAttribute('data-t', t);
      b.onclick = function () {
        sel = t;
        Array.prototype.forEach.call(box.children, function (x) { x.className = x === b ? 'on' : ''; });
      };
      box.appendChild(b);
    });
  }

  function load(first) {
    return fetch(API, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'fail');
      var firstTime = !view;
      view = j.data;
      if (firstTime) buildTimes();
      render();
    }).catch(function () {
      if (first) el('dateLine').textContent = '불러오지 못했어요. 새로고침해 주세요';
    });
  }

  function post(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }

  el('go').onclick = function () {
    if (busy) return;
    var n = getName();
    if (!n) { setMsg('err', '이름을 입력해 주세요'); return; }
    if (!sel) { setMsg('err', '희망 시간을 골라 주세요'); return; }
    busy = true; setMsg('info', '신청하는 중…');
    post({ action: 'signup', name: n, time: sel }).then(function (j) {
      if (j.ok) {
        saveName(n);
        view = j.data; render();
        setMsg('ok', j.name + ' 학생, ' + fmtDate(j.date) + ' ' + j.time + (j.changed ? '으로 시간을 바꿨어요' : ' 신청됐어요'));
      } else {
        setMsg('err', j.error || '신청하지 못했어요');
        load();
      }
    }).catch(function () { setMsg('err', '연결이 불안정해요. 잠시 후 다시 해 주세요'); })
      .then(function () { busy = false; });
  };

  el('cancel').onclick = function () {
    if (busy) return;
    var n = getName();
    if (!n) { setMsg('err', '취소할 이름을 입력해 주세요'); return; }
    busy = true; setMsg('info', '취소하는 중…');
    post({ action: 'cancel', name: n }).then(function (j) {
      if (j.ok) { view = j.data; render(); setMsg('info', n + ' 학생의 신청을 취소했어요'); }
      else setMsg('err', j.error || '취소하지 못했어요');
    }).catch(function () { setMsg('err', '연결이 불안정해요. 잠시 후 다시 해 주세요'); })
      .then(function () { busy = false; });
  };

  try { var saved = localStorage.getItem('clinicName'); if (saved) el('nm').value = saved; } catch (e) {}
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  load(true);
})();
