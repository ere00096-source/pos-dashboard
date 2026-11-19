'use strict';
// ---------- 판매량 예측 ----------
// 채널 + 판매단위(88코드)의 하루 판매가(판매금액 ÷ 판매수량)가 입력한 판매가 ±N% 안인 날들의 평균 판매수량 = 예상 일 판매량.
// 납품가 채널은 대시보드와 같이 매익률로 판매가 환산한 금액을 쓴다. 판매수량은 RAW(판매단위) 그대로.
const sim = {model: null};

// 채널+88코드+날짜별 합계 (같은 날 여러 행이면 더함)
function simDays(model, ch, c88, year){
  const m = new Map();
  for (const x of model.facts){
    if (x.ch !== ch || x.c88 !== c88 || (year && x.date.slice(0, 4) !== year)) continue;
    const o = m.get(x.date) || {date: x.date, qty: 0, amount: 0, round: x.round};
    o.qty += x.qty; o.amount += x.amount; if (!o.round && x.round) o.round = x.round;
    m.set(x.date, o);
  }
  return [...m.values()].filter(d => d.qty > 0 && d.amount > 0).map(d => ({...d, price: d.amount / d.qty})).sort((a, b) => a.date < b.date ? -1 : 1);
}
function simEstimate(days, price, tol){
  const lo = price * (1 - tol), hi = price * (1 + tol);
  const hit = days.filter(d => d.price >= lo && d.price <= hi);
  const qs = hit.map(d => d.qty).sort((a, b) => a - b);
  const avg = qs.length ? qs.reduce((s, v) => s + v, 0) / qs.length : null;
  const med = qs.length ? (qs.length % 2 ? qs[(qs.length - 1) / 2] : (qs[qs.length / 2 - 1] + qs[qs.length / 2]) / 2) : null;
  return {lo, hi, hit, avg, med, min: qs[0], max: qs[qs.length - 1]};
}
// 판매가 구간별 요약 (10원 단위 반올림)
function simBands(days){
  const m = new Map();
  for (const d of days){
    const p = Math.round(d.price / 10) * 10;
    const o = m.get(p) || {price: p, days: 0, qty: 0};
    o.days++; o.qty += d.qty; m.set(p, o);
  }
  return [...m.values()].map(o => ({...o, avg: o.qty / o.days})).sort((a, b) => a.price - b.price);
}
function simProducts(model, ch){
  const by = new Map();
  for (const x of model.facts){
    if (x.ch !== ch || !(x.qty > 0)) continue;
    for (const mp of x.maps){
      const o = by.get(mp.productCode) || {code: mp.productCode, amount: 0, c88: new Map()};
      o.amount += x.amount;
      const c = o.c88.get(x.c88) || {c88: x.c88, qty: 0, conv: mp.conv, name: mp.eanName};
      c.qty += x.qty; o.c88.set(x.c88, c);
      by.set(mp.productCode, o);
    }
  }
  return [...by.values()].sort((a, b) => b.amount - a.amount);
}
async function loadSim(){
  $('sResult').replaceChildren(el('p', '데이터를 불러오는 중이에요...', 'sub'));
  try {
    const [pos, mapping, product, promo, channels, margin] = await Promise.all(['pos', 'mapping', 'product', 'promo', 'channels', 'margin'].map(getAll));
    sim.model = buildDashModel({pos, mapping, product, promo, channels, margin});
    const model = sim.model;
    if (!model.facts.length){ $('sResult').replaceChildren(el('p', '분석할 POS 데이터가 없어요. 채널 기준 · 88코드 매칭표 · POS RAW를 먼저 올려 주세요.', 'msg warn')); return; }
    const chs = [...new Set(model.facts.map(x => x.ch))].sort((a, b) => a.localeCompare(b, 'ko'));
    fillSelect($('sCh'), chs.map(c => [c, c]), true);
    const years = [...new Set(model.facts.map(x => x.date.slice(0, 4)))].sort().reverse();
    fillSelect($('sYear'), [...years.map(y => [y, y + '년']), ['', '전체 기간']], true);
    simFillProducts();
  } catch (e) {
    console.error(e);
    $('sResult').replaceChildren(el('p', `불러오지 못했어요: ${e.message}`, 'msg err'));
  }
}
function simFillProducts(){
  const model = sim.model, ch = $('sCh').value;
  const list = simProducts(model, ch);
  sim.products = list;
  fillSelect($('sProd'), list.map(p => { const pr = model.prod.get(p.code); return [p.code, `${pr && pr.name ? pr.name : '(이름 없음)'} (${p.code})`]; }), true);
  simFill88();
}
function simFill88(){
  const p = (sim.products || []).find(x => x.code === $('sProd').value);
  const list = p ? [...p.c88.values()].sort((a, b) => b.qty - a.qty) : [];
  fillSelect($('s88'), list.map(c => [c.c88, `${c.c88}${c.name ? ' ' + c.name : ''}${c.conv != null ? ` (전환수량 ${c.conv})` : ''}`]), true);
  renderSim();
}
const simFmtP = v => v == null || !isFinite(v) ? '–' : Math.round(v).toLocaleString('ko-KR') + '원';
function renderSim(){
  const model = sim.model, box = $('sResult');
  if (!model) return;
  box.replaceChildren();
  const ch = $('sCh').value, c88 = $('s88').value, year = $('sYear').value;
  const price = Number(String($('sPrice').value).replace(/[,\s원]/g, '')), tol = Number($('sTol').value) / 100;
  if (!ch || !c88){ box.append(el('p', '이 채널에 판매된 제품이 없어요.', 'sub')); return; }
  const days = simDays(model, ch, c88, year);
  if (!days.length){ box.append(el('p', '선택한 기간에 판매 기록이 없어요.', 'sub')); return; }
  const conv = (() => { const p = (sim.products || []).find(x => x.code === $('sProd').value); const c = p && p.c88.get(c88); return c ? c.conv : null; })();
  const roundLabel = new Map(model.roundList.map(r => [r.key, r.label]));
  if (price > 0 && tol >= 0){
    const r = simEstimate(days, price, tol);
    const card = el('div', null, 'card');
    card.append(el('h2', `판매가 ${simFmtP(price)}일 때 예상 일 판매량`));
    card.append(el('p', `비교 범위: ${simFmtP(r.lo)} ~ ${simFmtP(r.hi)} (±${(tol * 100).toLocaleString('ko-KR', {maximumFractionDigits: 2})}%) · ${year ? year + '년' : '전체 기간'} 판매일 ${days.length.toLocaleString()}일 중 ${r.hit.length.toLocaleString()}일 해당`, 'sub'));
    if (r.hit.length){
      const st = el('div', null, 'stats');
      const tile = (lab, v, sub) => { const d = el('div', null, 'stat'); d.append(el('span', lab), el('b', v)); if (sub) d.append(el('small', sub)); return d; };
      st.append(tile('예상 일 판매량 (평균)', fmt1(r.avg) + '개', conv != null && conv !== 1 ? `낱개 환산 ${fmt1(r.avg * conv)}개` : ''),
        tile('중앙값', fmt1(r.med) + '개'), tile('최소 ~ 최대', `${fmt0(r.min)} ~ ${fmt0(r.max)}개`), tile('해당 일수', r.hit.length + '일'));
      card.append(st);
      const h = el('div', null, 'tbl'); h.style.marginTop = '12px';
      table(h, ['날짜', '행사차수', '판매가', '판매수량', '판매금액'], r.hit.map(d => [d.date, roundLabel.get(d.round) || '차수 외', simFmtP(d.price), fmt0(d.qty), fmt0(d.amount)]), i => i >= 2);
      card.append(h);
    } else {
      card.append(el('p', '이 범위의 판매가로 팔린 날이 없어요. 아래 판매가별 평균에서 가까운 판매가를 참고하세요.', 'msg warn'));
      const near = [...days].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)).slice(0, 5);
      card.append(el('p', '가장 가까운 판매가: ' + near.map(d => `${simFmtP(d.price)} (${d.date}, ${fmt0(d.qty)}개)`).join(', '), 'sub'));
    }
    box.append(card);
  } else box.append(el('p', '판매가를 입력하면 예상 일 판매량을 계산해요.', 'msg warn'));
  const bc = el('div', null, 'card');
  bc.append(el('h2', '판매가별 평균 일 판매량'), el('p', '하루 판매가를 10원 단위로 반올림해 묶었어요.', 'need'));
  const h2 = el('div', null, 'tbl');
  table(h2, ['판매가', '판매일수', '평균 판매수량', '총 판매수량'], simBands(days).map(b => [simFmtP(b.price), b.days, fmt1(b.avg), fmt0(b.qty)]), i => i >= 1);
  bc.append(h2); box.append(bc);
}
$('sCh').onchange = () => simFillProducts();
$('sProd').onchange = () => simFill88();
['s88', 'sYear'].forEach(id => { $(id).onchange = () => renderSim(); });
['sPrice', 'sTol'].forEach(id => { $(id).oninput = () => renderSim(); });
