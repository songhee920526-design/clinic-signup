import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSite, openPage, settle, waitFor } from './harness.mjs';

const kst = (s) => new Date(s + '+09:00');
const PIN = '123456';

async function withPin(site) { await site.post({ action: 'setPin', newPin: PIN }); }
const adm = (site, action, extra = {}) => site.post({ action, pin: PIN, ...extra });

// ---------- 날짜(주) 계산 ----------
test('신청 대상 금요일: 금요일 19시 정각에 다음 주로 넘어감', async () => {
  const { clinic } = await makeSite();
  const t = (s) => clinic.targetFriday(kst(s));
  assert.equal(t('2026-10-29T20:35:00'), '2026-10-30'); // 목요일
  assert.equal(t('2026-10-30T00:00:00'), '2026-10-30'); // 금요일 자정
  assert.equal(t('2026-10-30T18:59:59'), '2026-10-30'); // 7시 직전
  assert.equal(t('2026-10-30T19:00:00'), '2026-11-06'); // 7시 정각 → 다음 주
  assert.equal(t('2026-10-31T10:00:00'), '2026-11-06'); // 토요일
  assert.equal(t('2026-11-01T23:59:59'), '2026-11-06'); // 일요일
  assert.equal(t('2026-11-02T08:00:00'), '2026-11-06'); // 월요일
  assert.equal(t('2026-11-05T12:00:00'), '2026-11-06'); // 목요일
  assert.equal(t('2026-11-06T19:00:00'), '2026-11-13');
});

test('UTC 기준 시각이 아니라 한국 시간으로 계산함', async () => {
  const { clinic } = await makeSite();
  // 한국 금요일 18:30 = UTC 금요일 09:30, 한국 금요일 19:30 = UTC 금요일 10:30
  assert.equal(clinic.targetFriday(new Date('2026-10-30T09:30:00Z')), '2026-10-30');
  assert.equal(clinic.targetFriday(new Date('2026-10-30T10:30:00Z')), '2026-11-06');
  // 한국 토요일 새벽 = UTC 금요일 밤
  assert.equal(clinic.targetFriday(new Date('2026-10-30T16:00:00Z')), '2026-11-06');
});

// ---------- 신청·정원 ----------
test('신청, 정원 6명, 7번째는 마감', async () => {
  const s = await makeSite();
  for (let i = 1; i <= 6; i++) {
    const r = await s.post({ action: 'signup', name: '학생' + i, time: '7:00' });
    assert.equal(r.ok, true, 'signup ' + i);
  }
  const r7 = await s.post({ action: 'signup', name: '학생7', time: '7:00' });
  assert.equal(r7.ok, false);
  assert.match(r7.error, /정원/);
  const v = (await s.get()).data;
  assert.equal(v.count, 6); assert.equal(v.capacity, 6); assert.equal(v.remaining, 0); assert.equal(v.status, 'full');
});

test('같은 이름으로 다시 신청하면 시간만 바뀌고 정원이 차도 가능', async () => {
  const s = await makeSite();
  for (let i = 1; i <= 6; i++) await s.post({ action: 'signup', name: '학생' + i, time: '7:00' });
  const r = await s.post({ action: 'signup', name: '학생3', time: '8:30' });
  assert.equal(r.ok, true); assert.equal(r.changed, true);
  assert.equal((await s.get()).data.count, 6);
});

test('이름 정리: 공백·대소문자 무시, 빈 이름·잘못된 시간은 거절', async () => {
  const s = await makeSite();
  assert.equal((await s.post({ action: 'signup', name: '  Kim   Min ', time: '7:30' })).ok, true);
  const dup = await s.post({ action: 'signup', name: 'kim min', time: '8:00' });
  assert.equal(dup.ok, true); assert.equal(dup.changed, true);
  assert.equal((await s.get()).data.count, 1);
  assert.equal((await s.post({ action: 'signup', name: '   ', time: '7:00' })).ok, false);
  assert.equal((await s.post({ action: 'signup', name: '가나다', time: '6:30' })).ok, false);
  assert.equal((await s.post({ action: 'signup', name: '가나다', time: '9:30' })).ok, false);
  assert.equal((await s.post({ action: 'signup', name: 'x'.repeat(21), time: '7:00' })).ok, false);
});

test('신청 취소: 자리가 비고, 없는 이름은 오류', async () => {
  const s = await makeSite();
  await s.post({ action: 'signup', name: '홍길동', time: '7:00' });
  assert.equal((await s.post({ action: 'cancel', name: '없는애' })).ok, false);
  const r = await s.post({ action: 'cancel', name: '홍길동' });
  assert.equal(r.ok, true); assert.equal(r.data.count, 0);
});

test('학생에게 내려가는 정보에는 이름이 없음', async () => {
  const s = await makeSite();
  await s.post({ action: 'signup', name: '비밀이름', time: '7:00' });
  const raw = JSON.stringify(await s.get());
  assert.ok(!raw.includes('비밀이름'));
  const r = JSON.stringify(await s.post({ action: 'signup', name: '다른이름', time: '7:00' }));
  assert.ok(!r.includes('비밀이름'));
});

// ---------- 자동 초기화 ----------
test('금요일 7시가 지나면 다음 주 빈 명단, 지난 명단은 기록으로 남음', async () => {
  const s = await makeSite('2026-10-30T18:00:00+09:00');
  await s.post({ action: 'signup', name: '민수', time: '7:30' });
  await setupAndCheck(s);
  async function setupAndCheck(s) {
    await withPin(s);
    assert.equal((await s.get()).data.count, 1);
    s.clock.now = kst('2026-10-30T19:00:01');
    const v = (await s.get()).data;
    assert.equal(v.date, '2026-11-06'); assert.equal(v.count, 0); assert.equal(v.status, 'open');
    // 같은 이름으로 다음 주에 새로 신청 가능
    assert.equal((await s.post({ action: 'signup', name: '민수', time: '8:00' })).ok, true);
    const a = (await adm(s, 'adminState')).data;
    assert.equal(a.previous.date, '2026-10-30'); assert.equal(a.previous.isToday, true);
    assert.deepEqual(a.previous.entries, [{ name: '민수', time: '7:30' }]);
    assert.equal(a.targetDate, '2026-11-06');
    assert.deepEqual(a.weeks[0].entries, [{ name: '민수', time: '8:00' }]);
    // 다음 날이 되면 "오늘 진행 중"이 아니라 "지난 클리닉"
    s.clock.now = kst('2026-10-31T09:00:00');
    assert.equal((await adm(s, 'adminState')).data.previous.isToday, false);
  }
});

// ---------- PIN ----------
test('PIN 없이는 원장님 동작이 모두 막힘 (학생이 정원을 바꿀 수 없음)', async () => {
  const s = await makeSite();
  for (const a of ['adminState', 'setCapacity', 'setClosed', 'setOff', 'removeEntry', 'addEntry']) {
    const r = await s.post({ action: a, pin: '', date: '2026-10-30', capacity: 20 });
    assert.equal(r.ok, false, a);
  }
  await withPin(s);
  for (const a of ['adminState', 'setCapacity', 'setClosed', 'setOff', 'removeEntry', 'addEntry']) {
    for (const bad of [undefined, '', '0000', '123456 ', 123457]) {
      const r = await s.post({ action: a, pin: bad, date: '2026-10-30', capacity: 20, closed: true, off: true });
      assert.equal(r.ok, false, a + ' ' + String(bad));
    }
  }
  assert.equal((await s.get()).data.capacity, 6);
});

test('PIN은 해시로만 저장되고, 처음 정한 뒤에는 현재 PIN 없이 못 바꿈', async () => {
  const s = await makeSite();
  assert.equal((await s.get()).data.hasPin, false);
  assert.equal((await s.post({ action: 'setPin', newPin: '12' })).ok, false); // 너무 짧음
  assert.equal((await s.post({ action: 'setPin', newPin: PIN })).ok, true);
  assert.ok(!JSON.stringify(s.store.peek()).includes(PIN));
  assert.equal((await s.get()).data.hasPin, true);
  assert.equal((await s.post({ action: 'setPin', newPin: '999999' })).ok, false); // 현재 PIN 없음
  assert.equal((await s.post({ action: 'setPin', pin: 'wrong', newPin: '999999' })).ok, false);
  assert.equal((await s.post({ action: 'setPin', pin: PIN, newPin: '999999' })).ok, true);
  assert.equal((await adm(s, 'adminState')).ok, false); // 옛 PIN
  assert.equal((await s.post({ action: 'adminState', pin: '999999' })).ok, true);
});

test('PIN 5번 틀리면 10분 잠김, 잠긴 동안은 맞는 PIN도 거절, 10분 뒤 풀림', async () => {
  const s = await makeSite();
  await withPin(s);
  for (let i = 0; i < 5; i++) assert.equal((await s.post({ action: 'adminState', pin: 'nope' + i })).code === 'badpin' || i === 4, true);
  const locked = await adm(s, 'adminState');
  assert.equal(locked.ok, false); assert.equal(locked.code, 'locked');
  s.clock.now = new Date(s.clock.now.getTime() + 9 * 60 * 1000);
  assert.equal((await adm(s, 'adminState')).code, 'locked');
  s.clock.now = new Date(s.clock.now.getTime() + 2 * 60 * 1000);
  assert.equal((await adm(s, 'adminState')).ok, true);
});

// ---------- 원장님 동작 ----------
test('정원 조절은 그 주에만 적용되고 다음 주는 기본 6명으로 돌아옴', async () => {
  const s = await makeSite(); await withPin(s);
  const r = await adm(s, 'setCapacity', { date: '2026-10-30', capacity: 4 });
  assert.equal(r.ok, true);
  assert.equal((await s.get()).data.capacity, 4);
  assert.equal(r.data.weeks[0].isDefaultCapacity, false);
  assert.equal(r.data.weeks[1].capacity, 6);
  for (const bad of [0, 21, 2.5, 'a', null]) assert.equal((await adm(s, 'setCapacity', { date: '2026-10-30', capacity: bad })).ok, false);
  s.clock.now = kst('2026-10-30T19:00:00');
  assert.equal((await s.get()).data.capacity, 6);
});

test('정원을 줄여도 이미 신청한 학생은 유지, 새 신청만 막음', async () => {
  const s = await makeSite(); await withPin(s);
  for (let i = 1; i <= 4; i++) await s.post({ action: 'signup', name: '학생' + i, time: '7:00' });
  await adm(s, 'setCapacity', { date: '2026-10-30', capacity: 3 });
  assert.equal((await s.get()).data.count, 4);
  assert.equal((await s.post({ action: 'signup', name: '새학생', time: '7:00' })).ok, false);
  assert.equal((await s.post({ action: 'signup', name: '학생1', time: '9:00' })).ok, true); // 기존 학생 시간 변경은 가능
});

test('마감 / 클리닉 없음(사유) / 해제', async () => {
  const s = await makeSite(); await withPin(s);
  await adm(s, 'setClosed', { date: '2026-10-30', closed: true });
  let g = (await s.get()).data; assert.equal(g.status, 'closed');
  assert.equal((await s.post({ action: 'signup', name: '가', time: '7:00' })).ok, false);
  await adm(s, 'setClosed', { date: '2026-10-30', closed: false });
  assert.equal((await s.post({ action: 'signup', name: '가', time: '7:00' })).ok, true);
  await adm(s, 'setOff', { date: '2026-10-30', off: true, reason: '시험 기간이라 쉬어요' });
  g = (await s.get()).data; assert.equal(g.status, 'off'); assert.equal(g.reason, '시험 기간이라 쉬어요');
  const r = await s.post({ action: 'signup', name: '나', time: '7:00' });
  assert.equal(r.ok, false); assert.match(r.error, /클리닉이 없어요/);
  await adm(s, 'setOff', { date: '2026-10-30', off: false });
  g = (await s.get()).data; assert.equal(g.status, 'open'); assert.equal(g.reason, '');
});

test('미리 정해 둔 주(방학 등)가 되면 자동으로 "클리닉 없음"으로 보임', async () => {
  const s = await makeSite(); await withPin(s);
  await adm(s, 'setOff', { date: '2026-11-13', off: true, reason: '모의고사 주간' });
  assert.equal((await s.get()).data.status, 'open');
  s.clock.now = kst('2026-11-06T19:00:00'); // 11/13 주가 아직 아님
  assert.equal((await s.get()).data.date, '2026-11-13');
  assert.equal((await s.get()).data.status, 'off');
  s.clock.now = kst('2026-11-13T19:00:00'); // 그 다음 주는 정상
  assert.equal((await s.get()).data.status, 'open');
});

test('명단 삭제·직접 추가(정원 넘겨도 추가 가능)·날짜 검증', async () => {
  const s = await makeSite(); await withPin(s);
  for (let i = 1; i <= 6; i++) await s.post({ action: 'signup', name: '학생' + i, time: '7:00' });
  const add = await adm(s, 'addEntry', { date: '2026-10-30', name: '추가생', time: '9:00' });
  assert.equal(add.ok, true); assert.equal(add.data.weeks[0].entries.length, 7);
  assert.equal(add.data.weeks[0].entries.at(-1).name, '추가생'); // 시간순 정렬(9:00이 마지막)
  assert.equal((await adm(s, 'removeEntry', { date: '2026-10-30', name: '학생2' })).data.weeks[0].entries.length, 6);
  assert.equal((await adm(s, 'removeEntry', { date: '2026-10-30', name: '없는이름' })).ok, false);
  assert.equal((await adm(s, 'addEntry', { date: '2026-10-30', name: '가', time: '6:00' })).ok, false);
  assert.equal((await adm(s, 'setCapacity', { date: '2025-01-03', capacity: 5 })).ok, false);
  assert.equal((await adm(s, 'setCapacity', { date: '2026-10-29', capacity: 5 })).ok, false); // 금요일이 아닌 날
});

test('명단은 시간순, 같은 시간이면 신청 순서', async () => {
  const s = await makeSite(); await withPin(s);
  s.clock.now = kst('2026-10-29T20:00:00'); await s.post({ action: 'signup', name: 'C', time: '8:30' });
  s.clock.now = kst('2026-10-29T20:01:00'); await s.post({ action: 'signup', name: 'A', time: '7:00' });
  s.clock.now = kst('2026-10-29T20:02:00'); await s.post({ action: 'signup', name: 'B', time: '7:00' });
  const e = (await adm(s, 'adminState')).data.weeks[0].entries.map((x) => x.name);
  assert.deepEqual(e, ['A', 'B', 'C']);
});

test('동시에 신청해도 서로 덮어쓰지 않음 (저장 충돌 재시도)', async () => {
  const s = await makeSite();
  const rs = await Promise.all(['가', '나', '다', '라', '마'].map((n) => s.post({ action: 'signup', name: n, time: '7:00' })));
  assert.ok(rs.every((r) => r.ok));
  assert.equal((await s.get()).data.count, 5);
});

test('동시에 마지막 자리를 신청하면 정원을 넘지 않음', async () => {
  const s = await makeSite();
  for (let i = 1; i <= 5; i++) await s.post({ action: 'signup', name: '학생' + i, time: '7:00' });
  const rs = await Promise.all(['가', '나', '다'].map((n) => s.post({ action: 'signup', name: n, time: '7:00' })));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal((await s.get()).data.count, 6);
});

test('지원하지 않는 요청은 오류, 학원 데이터 같은 건 아예 없음', async () => {
  const s = await makeSite();
  assert.equal((await s.post({ action: 'exportAll' })).ok, false);
  assert.equal((await s.post({ action: 'importData' })).ok, false);
  const raw = s.store.peek();
  assert.ok(raw === null || Object.keys(raw).every((k) => ['v', 'pin', 'auth', 'weeks'].includes(k)));
});

// ---------- 화면 ----------
test('학생 화면: 이름·시간 골라 신청 → 인원 반영, 시간 변경, 취소', async () => {
  const s = await makeSite();
  const { win, doc, errors } = await openPage(s);
  assert.deepEqual(errors, []);
  assert.match(doc.getElementById('dateLine').textContent, /10월 30일\(금\) 저녁 7시 클리닉/);
  assert.equal(doc.getElementById('cnt').textContent, '0 / 6명');
  assert.equal(doc.querySelectorAll('#times button').length, 5);
  assert.deepEqual([...doc.querySelectorAll('#times button')].map((b) => b.textContent), ['7:00', '7:30', '8:00', '8:30', '9:00']);

  doc.getElementById('go').click(); // 이름 없이
  assert.match(doc.getElementById('msg').textContent, /이름/);
  doc.getElementById('nm').value = '홍길동';
  doc.getElementById('go').click(); // 시간 없이
  assert.match(doc.getElementById('msg').textContent, /시간/);

  doc.querySelector('#times button[data-t="7:30"]').click();
  assert.equal(doc.querySelector('#times button.on').textContent, '7:30');
  doc.getElementById('go').click();
  await waitFor(() => /신청됐어요/.test(doc.getElementById('msg').textContent), 4000, '신청 완료');
  assert.match(doc.getElementById('msg').textContent, /홍길동 학생, 10월 30일\(금\) 7:30 신청됐어요/);
  assert.equal(doc.getElementById('cnt').textContent, '1 / 6명');
  assert.equal(s.store.peek().weeks['2026-10-30'].entries[0].time, '7:30');

  doc.querySelector('#times button[data-t="9:00"]').click();
  doc.getElementById('go').click();
  await waitFor(() => /바꿨어요/.test(doc.getElementById('msg').textContent), 4000, '시간 변경');
  assert.equal(doc.getElementById('cnt').textContent, '1 / 6명');

  doc.getElementById('cancel').click();
  await waitFor(() => /취소했어요/.test(doc.getElementById('msg').textContent), 4000, '취소');
  assert.equal(doc.getElementById('cnt').textContent, '0 / 6명');
  assert.equal(win.localStorage.getItem('clinicName'), '홍길동');
  win.close();
});

test('학생 화면: 정원 마감·클리닉 없음 안내', async () => {
  const s = await makeSite(); await withPin(s);
  for (let i = 1; i <= 6; i++) await s.post({ action: 'signup', name: '학생' + i, time: '7:00' });
  let p = await openPage(s);
  assert.match(p.doc.getElementById('banner').textContent, /정원이 모두 찼어요/);
  p.doc.getElementById('nm').value = '새학생';
  p.doc.querySelector('#times button').click();
  p.doc.getElementById('go').click();
  await waitFor(() => /정원/.test(p.doc.getElementById('msg').textContent), 4000, '정원 오류');
  p.win.close();

  await adm(s, 'setOff', { date: '2026-10-30', off: true, reason: '시험 기간이라 쉬어요' });
  p = await openPage(s);
  assert.match(p.doc.getElementById('banner').textContent, /이번 주는 클리닉이 없어요 · 시험 기간이라 쉬어요/);
  assert.ok(p.doc.getElementById('formArea').classList.contains('hidden'));
  p.win.close();
});

test('원장님 화면: 처음 PIN 정하기 → 정원·마감·없음·명단 조작 → 나갔다 PIN으로 다시 열기', async () => {
  const s = await makeSite();
  await s.post({ action: 'signup', name: '민수', time: '8:00' });
  let { win, doc, errors } = await openPage(s, 'admin.html');
  assert.deepEqual(errors, []);
  const vis = (id) => !doc.getElementById(id).classList.contains('hidden');
  assert.ok(vis('setupCard') && !vis('main'));

  doc.getElementById('sp1').value = PIN; doc.getElementById('sp2').value = '111111';
  doc.getElementById('spGo').click();
  assert.match(doc.getElementById('spMsg').textContent, /달라요/);
  doc.getElementById('sp2').value = PIN;
  doc.getElementById('spGo').click();
  await waitFor(() => vis('main'), 4000, '관리 화면');
  assert.equal(doc.getElementById('capNum').textContent, '6');
  assert.match(doc.getElementById('stat').textContent, /신청 1명 · 남은 자리 5/);

  doc.getElementById('capPlus').click();
  await waitFor(() => doc.getElementById('capNum').textContent === '7', 4000, '정원 7');
  doc.getElementById('capMinus').click();
  await waitFor(() => doc.getElementById('capNum').textContent === '6', 4000, '정원 6');
  doc.getElementById('capMinus').click();
  await waitFor(() => doc.getElementById('capNum').textContent === '5', 4000, '정원 5');
  assert.equal((await s.get()).data.capacity, 5);

  doc.getElementById('closeBtn').click();
  await waitFor(() => /마감됨/.test(doc.getElementById('stat').textContent), 4000, '마감');
  assert.equal(doc.getElementById('closeBtn').textContent, '신청 다시 열기');

  doc.getElementById('an').value = '직접추가';
  doc.getElementById('at').value = '7:00';
  doc.getElementById('ab').click();
  await waitFor(() => doc.querySelectorAll('#list .row').length === 2, 4000, '명단 2명');
  assert.equal(doc.querySelector('#list .row .n').textContent, '직접추가'); // 7:00이 8:00보다 먼저
  doc.querySelector('button[data-del="민수"]').click();
  await waitFor(() => doc.querySelectorAll('#list .row').length === 1, 4000, '삭제');

  // 다음 주로 넘겨서 "클리닉 없음" 설정
  doc.getElementById('next').click();
  assert.match(doc.getElementById('wLabel').textContent, /11월 6일\(금\)/);
  assert.equal(doc.getElementById('capNum').textContent, '6');
  doc.getElementById('offBtn').click();
  await waitFor(() => !doc.getElementById('offBox').classList.contains('hidden'), 4000, '사유 칸');
  doc.getElementById('reason').value = '방학';
  doc.getElementById('reasonSave').click();
  await waitFor(() => s.store.peek().weeks['2026-11-06'].reason === '방학', 4000, '사유 저장');

  doc.getElementById('logout').click();
  assert.ok(vis('loginCard') && !vis('main'));
  doc.getElementById('lp').value = 'wrong';
  doc.getElementById('lpGo').click();
  await waitFor(() => /맞지 않아요/.test(doc.getElementById('lpMsg').textContent), 4000, '틀린 PIN');
  doc.getElementById('lp').value = PIN;
  doc.getElementById('lpGo').click();
  await waitFor(() => vis('main'), 4000, '다시 열기');
  win.close();
});

test('원장님 화면: 기억해 둔 PIN으로 바로 열리고, 틀리면 로그인 화면', async () => {
  const s = await makeSite(); await withPin(s);
  let p = await openPage(s, 'admin.html', { storage: { clinicPin: PIN } });
  assert.ok(!p.doc.getElementById('main').classList.contains('hidden'));
  p.win.close();
  p = await openPage(s, 'admin.html', { storage: { clinicPin: 'old' } });
  assert.ok(p.doc.getElementById('main').classList.contains('hidden'));
  assert.ok(!p.doc.getElementById('loginCard').classList.contains('hidden'));
  p.win.close();
});

test('두 화면 모두 어두운 색 면을 쓰지 않음(밝은 배경) / 검색 제외 표시', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../public/clinic.css', import.meta.url), 'utf8');
  assert.match(css, /background:\s*#f4f6fb/);
  for (const f of ['index.html', 'admin.html']) assert.match(fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8'), /noindex/);
  assert.match(fs.readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'), /noindex/);
});
