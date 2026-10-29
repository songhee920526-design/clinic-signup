// 금요일 클리닉 신청 - 백엔드 (Netlify Functions + Netlify Blobs)
// 학원 운영 툴(api.mjs)과 완전히 분리: 저장소 이름도 'clinic', 학생·성적 같은 학원 데이터는 건드리지 않음.
//
// 한 주 = "금요일 저녁 7시 ~ 다음 금요일 저녁 7시(한국 시간)". 그 사이 받은 신청은 다음 금요일 명단.
// 금요일 7시가 지나면 화면이 다음 주 금요일로 바뀌어 빈 명단으로 시작함(자동 초기화).
// 지우는 게 아니라 날짜별로 따로 저장하므로 지난 명단은 기록으로 남음.
//
// 원장님 전용 동작(정원 조절·삭제·마감 등)은 PIN을 서버에서 확인함. PIN은 처음에 원장님이 화면에서 직접 정함
// (해시로만 저장). 틀리게 5번 입력하면 10분간 잠김.

import { getStore } from '@netlify/blobs';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const STORE_NAME = 'clinic';
const KEY = 'state';
const MAX_RETRY = 6;

export const TIMES = ['7:00', '7:30', '8:00', '8:30', '9:00'];
export const DEFAULT_CAPACITY = 6;
const MAX_CAPACITY = 20;
const CLOSE_HOUR = 19; // 금요일 저녁 7시(한국 시간)에 다음 주로 넘어감
const WEEKS_AHEAD = 8; // 원장님 화면에서 미리 볼 수 있는 금요일 수
const KEEP_DAYS = 400;
const MAX_NAME = 20;
const MIN_PIN = 4;
const MAX_PIN = 20;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;
const MAX_REASON = 60;

// ---------- 날짜 계산 (한국 시간) ----------

function kstParts(now) {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  return { date: k.toISOString().slice(0, 10), hour: k.getUTCHours(), dow: k.getUTCDay() };
}
export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// 지금 신청을 받고 있는 클리닉 날짜(금요일). 금요일 19시가 되는 순간 다음 주 금요일로 바뀜.
export function targetFriday(now) {
  const p = kstParts(now);
  const diff = (5 - p.dow + 7) % 7;
  let f = addDays(p.date, diff);
  if (diff === 0 && p.hour >= CLOSE_HOUR) f = addDays(f, 7);
  return f;
}
function adminDates(now) {
  const t = targetFriday(now);
  const list = [];
  for (let i = 0; i < WEEKS_AHEAD; i++) list.push(addDays(t, 7 * i));
  return list;
}

// ---------- 상태 ----------

export function emptyState() {
  return { v: 1, pin: null, auth: { fails: 0, lockUntil: 0 }, weeks: {} };
}
function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : emptyState();
  if (!s.weeks || typeof s.weeks !== 'object') s.weeks = {};
  if (!s.auth) s.auth = { fails: 0, lockUntil: 0 };
  if (s.pin === undefined) s.pin = null;
  return s;
}
function weekOf(state, date) {
  const w = state.weeks[date];
  return w || { capacity: null, closed: false, off: false, reason: '', entries: [] };
}
function ensureWeek(state, date) {
  if (!state.weeks[date]) state.weeks[date] = { capacity: null, closed: false, off: false, reason: '', entries: [] };
  return state.weeks[date];
}
function capOf(w) { return w.capacity == null ? DEFAULT_CAPACITY : w.capacity; }
function timeRank(t) { const i = TIMES.indexOf(t); return i < 0 ? 99 : i; }
function sortedEntries(w) {
  return w.entries.slice().sort((a, b) => timeRank(a.time) - timeRank(b.time) || String(a.at).localeCompare(String(b.at)));
}

export function normName(s) {
  return String(s == null ? '' : s).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}
const nameKey = (s) => normName(s).toLowerCase();

function statusOf(w) {
  if (w.off) return 'off';
  if (w.closed) return 'closed';
  if (w.entries.length >= capOf(w)) return 'full';
  return 'open';
}

// 학생에게 보이는 것: 인원수와 상태뿐 (이름은 안 보임)
export function publicView(state, now) {
  const date = targetFriday(now);
  const w = weekOf(state, date);
  const cap = capOf(w);
  return {
    date, capacity: cap, count: w.entries.length, remaining: Math.max(0, cap - w.entries.length),
    status: statusOf(w), reason: w.off ? w.reason || '' : '', times: TIMES, hasPin: !!state.pin,
  };
}

function weekView(state, date) {
  const w = weekOf(state, date);
  return { date, capacity: capOf(w), isDefaultCapacity: w.capacity == null, closed: !!w.closed, off: !!w.off, reason: w.reason || '', entries: sortedEntries(w).map((e) => ({ name: e.name, time: e.time })) };
}
export function adminView(state, now) {
  const today = kstParts(now).date;
  const target = targetFriday(now);
  const prevDate = addDays(target, -7);
  const pw = weekOf(state, prevDate);
  return {
    hasPin: true, today, targetDate: target, defaultCapacity: DEFAULT_CAPACITY, times: TIMES,
    weeks: adminDates(now).map((d) => weekView(state, d)),
    previous: { date: prevDate, isToday: prevDate === today, entries: sortedEntries(pw).map((e) => ({ name: e.name, time: e.time })) },
  };
}

// ---------- PIN ----------

function hashPin(pin, salt) { return scryptSync(String(pin), salt, 32).toString('hex'); }
function makePin(pin) { const salt = randomBytes(16).toString('hex'); return { salt, hash: hashPin(pin, salt) }; }
function pinMatches(state, pin) {
  if (!state.pin) return false;
  const a = Buffer.from(hashPin(pin, state.pin.salt), 'hex');
  const b = Buffer.from(state.pin.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function validPinFormat(pin) {
  const p = String(pin == null ? '' : pin);
  return p.length >= MIN_PIN && p.length <= MAX_PIN && !/\s/.test(p);
}
// 맞으면 null, 틀리면 오류 응답. 틀린 횟수는 state에 기록(dirty)
function checkPin(state, pin, now, flags) {
  if (!state.pin) return { ok: false, error: '먼저 PIN을 정해 주세요', code: 'nopin' };
  if (state.auth.lockUntil && now.getTime() < state.auth.lockUntil) {
    return { ok: false, error: 'PIN을 여러 번 틀려서 잠시 잠겼어요. 10분 뒤에 다시 해 주세요', code: 'locked' };
  }
  if (pinMatches(state, pin)) {
    if (state.auth.fails || state.auth.lockUntil) { state.auth = { fails: 0, lockUntil: 0 }; flags.dirty = true; }
    return null;
  }
  state.auth.fails = (state.auth.fails || 0) + 1;
  if (state.auth.fails >= MAX_FAILS) { state.auth = { fails: 0, lockUntil: now.getTime() + LOCK_MS }; }
  flags.dirty = true;
  return { ok: false, error: 'PIN이 맞지 않아요', code: 'badpin' };
}

// ---------- 동작 ----------

function validName(raw) {
  const n = normName(raw);
  if (!n) return { error: '이름을 입력해 주세요' };
  if (n.length > MAX_NAME) return { error: '이름이 너무 길어요' };
  return { name: n };
}

// state를 직접 고치고 { resp, dirty } 를 돌려줌 (저장은 호출한 쪽에서)
export function apply(state, body, now) {
  const flags = { dirty: false };
  const action = body && body.action;
  const today = kstParts(now).date;
  const cutoff = addDays(today, -KEEP_DAYS);
  for (const d of Object.keys(state.weeks)) if (d < cutoff) { delete state.weeks[d]; flags.dirty = true; }

  const finish = (resp) => ({ resp, dirty: flags.dirty });

  // ---- 학생 동작 ----
  if (action === 'signup') {
    const v = validName(body.name);
    if (v.error) return finish({ ok: false, error: v.error });
    if (!TIMES.includes(body.time)) return finish({ ok: false, error: '희망 시간을 골라 주세요' });
    const date = targetFriday(now);
    const w = weekOf(state, date);
    if (w.off) return finish({ ok: false, error: w.reason ? '이번 주는 클리닉이 없어요 (' + w.reason + ')' : '이번 주는 클리닉이 없어요' });
    if (w.closed) return finish({ ok: false, error: '신청이 마감됐어요' });
    const key = nameKey(v.name);
    const ex = w.entries.find((e) => nameKey(e.name) === key);
    if (ex) {
      const changed = ex.time !== body.time;
      if (changed) {
        const ww = ensureWeek(state, date);
        ww.entries.find((e) => nameKey(e.name) === key).time = body.time;
        flags.dirty = true;
      }
      return finish({ ok: true, changed, name: ex.name, date, time: body.time, data: publicView(state, now) });
    }
    if (w.entries.length >= capOf(w)) return finish({ ok: false, error: '정원이 모두 찼어요' });
    ensureWeek(state, date).entries.push({ name: v.name, time: body.time, at: now.toISOString() });
    flags.dirty = true;
    return finish({ ok: true, changed: false, name: v.name, date, time: body.time, data: publicView(state, now) });
  }
  if (action === 'cancel') {
    const v = validName(body.name);
    if (v.error) return finish({ ok: false, error: v.error });
    const date = targetFriday(now);
    const w = weekOf(state, date);
    const key = nameKey(v.name);
    if (!w.entries.some((e) => nameKey(e.name) === key)) return finish({ ok: false, error: '신청 내역을 찾을 수 없어요' });
    const ww = ensureWeek(state, date);
    ww.entries = ww.entries.filter((e) => nameKey(e.name) !== key);
    flags.dirty = true;
    return finish({ ok: true, data: publicView(state, now) });
  }

  // ---- 원장님 동작 (PIN 필요) ----
  if (action === 'setPin') {
    if (!validPinFormat(body.newPin)) return finish({ ok: false, error: 'PIN은 공백 없이 ' + MIN_PIN + '자 이상으로 정해 주세요' });
    if (state.pin) {
      const bad = checkPin(state, body.pin, now, flags);
      if (bad) return finish(bad);
    }
    state.pin = makePin(body.newPin);
    state.auth = { fails: 0, lockUntil: 0 };
    flags.dirty = true;
    return finish({ ok: true, data: adminView(state, now) });
  }

  const adminActions = ['adminState', 'setCapacity', 'setClosed', 'setOff', 'removeEntry', 'addEntry'];
  if (!adminActions.includes(action)) return finish({ ok: false, error: 'unknown action' });

  const bad = checkPin(state, body.pin, now, flags);
  if (bad) return finish(bad);

  if (action === 'adminState') return finish({ ok: true, data: adminView(state, now) });

  const date = body.date;
  const allowed = adminDates(now).concat([addDays(targetFriday(now), -7)]);
  if (!allowed.includes(date)) return finish({ ok: false, error: '날짜를 확인해 주세요' });

  if (action === 'setCapacity') {
    const c = Number(body.capacity);
    if (!Number.isInteger(c) || c < 1 || c > MAX_CAPACITY) return finish({ ok: false, error: '정원은 1~' + MAX_CAPACITY + '명 사이로 정해 주세요' });
    ensureWeek(state, date).capacity = c;
  } else if (action === 'setClosed') {
    ensureWeek(state, date).closed = !!body.closed;
  } else if (action === 'setOff') {
    const w = ensureWeek(state, date);
    w.off = !!body.off;
    w.reason = w.off ? String(body.reason == null ? '' : body.reason).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_REASON) : '';
  } else if (action === 'removeEntry') {
    const key = nameKey(body.name);
    const w = ensureWeek(state, date);
    const before = w.entries.length;
    w.entries = w.entries.filter((e) => nameKey(e.name) !== key);
    if (w.entries.length === before) return finish({ ok: false, error: '그 이름은 명단에 없어요' });
  } else if (action === 'addEntry') {
    const v = validName(body.name);
    if (v.error) return finish({ ok: false, error: v.error });
    if (!TIMES.includes(body.time)) return finish({ ok: false, error: '시간을 골라 주세요' });
    const w = ensureWeek(state, date);
    const key = nameKey(v.name);
    const ex = w.entries.find((e) => nameKey(e.name) === key);
    if (ex) ex.time = body.time; // 이미 있으면 시간만 바꿈 (정원은 원장님이 직접 정하므로 넘겨도 추가됨)
    else w.entries.push({ name: v.name, time: body.time, at: now.toISOString() });
  }
  flags.dirty = true;
  return finish({ ok: true, data: adminView(state, now) });
}

// ---------- Netlify Blobs 연동 ----------

async function load(store) {
  const r = await store.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
  if (!r) return { state: emptyState(), etag: null };
  return { state: normalize(r.data), etag: r.etag };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function createHandler(storeFactory, clock = () => new Date()) {
  return async (req) => {
    try {
      const store = storeFactory();
      if (req.method === 'GET') {
        const { state } = await load(store);
        return json({ ok: true, data: publicView(state, clock()) });
      }
      if (req.method === 'POST') {
        const body = await req.json();
        let lastErr;
        for (let i = 0; i < MAX_RETRY; i++) {
          const { state, etag } = await load(store);
          const { resp, dirty } = apply(state, body, clock());
          if (!dirty) return json(resp);
          const { modified } = await store.set(KEY, JSON.stringify(state), etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
          if (modified) return json(resp);
          lastErr = new Error('conflict');
        }
        throw lastErr || new Error('저장 충돌이 반복됐어요');
      }
      return json({ ok: false, error: 'unsupported method' }, 405);
    } catch (err) {
      return json({ ok: false, error: '잠시 후 다시 시도해 주세요' }, 500);
    }
  };
}

export default createHandler(() => getStore(STORE_NAME));
