'use strict';
// ---------- 대시보드 ----------
// 기준: 판매가 채널 + 매익률로 판매가를 환산한 납품가 채널. 제품코드로 볼 때는 그 채널에서 제품코드에 연결된 88코드마다 판매수량 × 전환수량을 더한다.
// 88코드로 볼 때는 RAW 판매수량 그대로. 판매금액은 RAW 합계(납품가 채널은 판매가로 환산한 값).
// 차수별 = 차수 기간(POS가 있는 기간과 겹치는 날) 일평균, 일자별 = 그날 값.

const isPriceChannel = c => (c.basis || '') !== 'X' && (c.basis || '').includes('판매가') && !(c.basis || '').includes('납품');
const fmt1 = n => (n === '' || n == null || !isFinite(n)) ? '' : Number(n).toLocaleString('ko-KR', {maximumFractionDigits: 1});
const fmt0 = n => (n === '' || n == null || !isFinite(n)) ? '' : Math.round(n).toLocaleString('ko-KR');
const pct = n => (n == null || !isFinite(n)) ? '' : (n * 100).toLocaleString('ko-KR', {maximumFractionDigits: 1}) + '%';
const spanDays = (a, b) => a > b ? 0 : Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
// 행사분류표 값 정리: N/A는 공백
const promoNorm = v => /^\s*n\s*\/?\s*a\s*$/i.test(v || '') ? '' : (v || '').trim();
const dayAdd = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

function buildDashModel({pos, mapping, product, promo, channels, margin = []}){
  const corr = buildMarginCorrector({margin, mapping, product, channels});
  const chans = channels.filter(c => isPriceChannel(c) || (corr.hasData && isSupplyChannel(c))).sort((a, b) => (a.channel + a.channel2).localeCompare(b.channel + b.channel2));
  const chanSet = new Set(chans.map(c => c.channel2));
  const prod = new Map();
  for (const p of product) if (!prod.has(p.productCode)) prod.set(p.productCode, {code: p.productCode, name: p.productName || '', major: p.major || '', minor: p.minor || '', promo: promoNorm(p.promoClass)});

  // 채널+88코드 → 연결된 제품코드와 전환수량
  const mapBy = new Map(), excluded = new Set(), sameConflict = new Set();
  for (const m of mapping){
    if (!chanSet.has(m.channel2)) continue;
    const k = m.channel2 + '|' + m.code88;
    if (m.excluded){ excluded.add(k); continue; }
    let list = mapBy.get(k);
    if (!list) mapBy.set(k, list = []);
    const conv = m.conv ?? null;
    const same = list.find(x => x.productCode === m.productCode);
    if (same){ if (same.conv !== conv) sameConflict.add(k); continue; }
    list.push({productCode: m.productCode, conv, eanName: m.eanName || ''});
    if (!prod.has(m.productCode)) prod.set(m.productCode, {code: m.productCode, name: m.productName || '', major: '', minor: '', promo: '', unclassified: true});
    else if (!prod.get(m.productCode).name) prod.get(m.productCode).name = m.productName || '';
  }
  const convConflict = new Set(), convMissing = new Set(), product88 = new Map();
  for (const [k, list] of mapBy){
    list.sort((a, b) => a.productCode.localeCompare(b.productCode));
    if (new Set(list.map(x => x.conv)).size > 1) convConflict.add(k);
    if (list.some(x => x.conv == null)) convMissing.add(k);
    const c88 = k.slice(k.indexOf('|') + 1);
    for (const x of list){
      if (!product88.has(x.productCode)) product88.set(x.productCode, new Set());
      product88.get(x.productCode).add(c88);
    }
  }

  // 차수
  const roundInfo = new Map(), spans = new Map();
  for (const r of promo){
    if (!chanSet.has(r.channel)) continue;
    const key = `${r.year}-${String(r.month).padStart(2, '0')}-${r.round}`;
    if (!roundInfo.has(key)) roundInfo.set(key, {key, year: r.year, label: r.roundLabel || `${r.month}월${r.round}`});
    if (!spans.has(r.channel)) spans.set(r.channel, []);
    spans.get(r.channel).push({key, start: r.start, end: r.end});
  }
  const years = new Set([...roundInfo.values()].map(r => r.year));
  const roundList = [...roundInfo.values()].sort((a, b) => a.key < b.key ? -1 : 1)
    .map(r => ({...r, label: years.size > 1 ? `${String(r.year).slice(2)}년 ${r.label}` : r.label}));

  // POS
  const facts = [], coverage = new Map();
  let unmatchedRows = 0, minDate = '', maxDate = '';
  const marginFallback = new Set(), marginNone = new Set();
  for (const p of pos){
    if (!chanSet.has(p.channel)) continue;
    const cv = coverage.get(p.channel);
    if (!cv) coverage.set(p.channel, {min: p.date, max: p.date});
    else { if (p.date < cv.min) cv.min = p.date; if (p.date > cv.max) cv.max = p.date; }
    if (!minDate || p.date < minDate) minDate = p.date;
    if (!maxDate || p.date > maxDate) maxDate = p.date;
    const k = p.channel + '|' + p.code88;
    if (excluded.has(k)) continue;
    const maps = mapBy.get(k);
    if (!maps){ if (p.qty) unmatchedRows++; continue; }
    let round = '';
    for (const s of spans.get(p.channel) || []) if (s.start <= p.date && p.date <= s.end){ round = s.key; break; }
    let amount = p.amount;
    if (corr.supply.has(p.channel)){
      const r = corr.lookup(p.channel, p.code88);
      if (r.factor == null) marginNone.add(k);
      else { amount = p.amount * r.factor; if (!r.exact) marginFallback.add(k); }
    }
    facts.push({ch: p.channel, date: p.date, c88: p.code88, key: k, qty: p.qty, amount, round, maps});
  }
  const roundsWithData = new Set(facts.map(x => x.round).filter(Boolean));
  const supplyChans = chans.filter(c => corr.supply.has(c.channel2)).map(c => c.channel2);
  const supplyAll = channels.filter(isSupplyChannel).map(c => c.channel2);
  return {chans, prod, mapBy, product88, roundList, roundsWithData, spans, facts, coverage, unmatchedRows, minDate, maxDate, convConflict, convMissing, sameConflict, supplyChans, supplyAll, marginFallback, marginNone};
}

// 기간 안에서 그 채널의 일수 (POS가 있는 기간과 겹치는 날만 센다)
function periodDays(model, ch, f){
  const cv = model.coverage.get(ch);
  if (!cv) return 0;
  if (f.unit === 'day') return f.date >= cv.min && f.date <= cv.max ? 1 : 0;
  let days = 0;
  for (const s of model.spans.get(ch) || []){
    if (s.key !== f.round) continue;
    days += spanDays(s.start > cv.min ? s.start : cv.min, s.end < cv.max ? s.end : cv.max);
  }
  return days;
}
function inPeriod(f){ return f.unit === 'round' ? (x => x.round === f.round) : (x => x.date === f.date); }

function productFilter(model, f){
  const q = (f.q || '').trim().toLowerCase();
  return code => {
    const p = model.prod.get(code) || {code, name: '', major: '', minor: ''};
    if (f.major && p.major !== f.major) return false;
    if (f.minor && p.minor !== f.minor) return false;
    if (f.promo && p.promo !== f.promo) return false;
    if (f.products && f.products.size && !f.products.has(code)) return false;
    if (q && !code.toLowerCase().includes(q) && !(p.name || '').toLowerCase().includes(q)) return false;
    return true;
  };
}
// 88코드 보기에서 검색어는 88코드·EAN제품명으로도 찾는다
function codePasses(model, f, x, pass){
  if (!x.maps.some(m => {
    const p = model.prod.get(m.productCode) || {major: '', minor: '', promo: ''};
    return (!f.major || p.major === f.major) && (!f.minor || p.minor === f.minor) && (!f.promo || p.promo === f.promo)
      && (!f.products || !f.products.size || f.products.has(m.productCode));
  })) return false;
  const q = (f.q || '').trim().toLowerCase();
  if (!q) return true;
  return x.c88.includes(q) || x.maps.some(m => (m.eanName || '').toLowerCase().includes(q) || pass(m.productCode));
}

// 표 1: 채널 비교
function dashCompare(model, f){
  const pass = productFilter(model, f), take = inPeriod(f);
  const chs = model.chans.map(c => c.channel2).filter(ch => f.channels.has(ch));
  const days = new Map(chs.map(ch => [ch, periodDays(model, ch, f)]));
  const rows = new Map();
  const cell = (key, info, ch) => {
    let r = rows.get(key);
    if (!r) rows.set(key, r = {key, ...info, cells: new Map()});
    let c = r.cells.get(ch);
    if (!c) r.cells.set(ch, c = {qty: 0, amount: 0});
    return c;
  };
  for (const x of model.facts){
    if (!f.channels.has(x.ch) || !take(x)) continue;
    if (f.view === 'product'){
      for (const m of x.maps){
        if (!pass(m.productCode)) continue;
        const p = model.prod.get(m.productCode);
        const c = cell(m.productCode, {code: m.productCode, name: p ? p.name : '', major: p ? p.major : '', minor: p ? p.minor : ''}, x.ch);
        c.qty += x.qty * (m.conv ?? 1);
        c.amount += x.amount;
      }
    } else {
      if (!codePasses(model, f, x, pass)) continue;
      const c = cell(x.c88, {code: x.c88, name: x.maps[0].eanName}, x.ch);
      c.qty += x.qty;
      c.amount += x.amount;
    }
  }
  const out = [...rows.values()].map(r => {
    let tq = 0, ta = 0, sq = 0, sa = 0;
    const vals = chs.map(ch => {
      const c = r.cells.get(ch), d = days.get(ch);
      if (!c || !d) return null;
      tq += c.qty / d; ta += c.amount / d; sq += c.qty; sa += c.amount;
      return {qty: c.qty / d, amount: c.amount / d, price: c.qty ? c.amount / c.qty : null, sumQty: c.qty, sumAmount: c.amount};
    });
    return {...r, vals, totalQty: tq, totalAmount: ta, totalPrice: sq ? sa / sq : null};
  }).sort((a, b) => b.totalQty - a.totalQty || (a.code < b.code ? -1 : 1));
  return {chs, days, rows: out};
}

// 요약: 같은 POS 판매는 한 번만 센다 (여러 제품코드에 연결돼도)
function dashKpi(model, f){
  const pass = productFilter(model, f), take = inPeriod(f);
  let qty = 0, amount = 0;
  const perCh = new Map(), products = new Set(), conflicts = new Set();
  for (const x of model.facts){
    if (!f.channels.has(x.ch) || !take(x)) continue;
    let conv = 1;
    if (f.view === 'product'){
      const hits = x.maps.filter(m => pass(m.productCode));
      if (!hits.length) continue;
      conv = hits[0].conv ?? 1;
      for (const m of hits) products.add(m.productCode);
      if (new Set(hits.map(m => m.conv)).size > 1) conflicts.add(x.key);
    } else {
      if (!codePasses(model, f, x, pass)) continue;
      products.add(x.c88);
    }
    qty += x.qty * conv;
    amount += x.amount;
    perCh.set(x.ch, (perCh.get(x.ch) || 0) + x.qty * conv);
  }
  let daily = 0;
  for (const [ch, q] of perCh){ const d = periodDays(model, ch, f); if (d) daily += q / d; }
  return {qty, amount, daily, price: qty ? amount / qty : null, products: products.size, conflicts: conflicts.size};
}

// 표 2: 추이 (차수별 일평균 / 일자별)
function dashTrend(model, f, key){
  const chs = model.chans.map(c => c.channel2).filter(ch => f.channels.has(ch));
  const periods = f.unit === 'round'
    ? model.roundList.filter(r => model.roundsWithData.has(r.key)).map(r => ({id: r.key, label: r.label}))
    : (() => { const out = []; for (let d = f.from; d <= f.to && out.length < 400; d = dayAdd(d, 1)) out.push({id: d, label: d}); return out; })();
  const sums = new Map();
  for (const x of model.facts){
    if (!f.channels.has(x.ch)) continue;
    const id = f.unit === 'round' ? x.round : x.date;
    if (!id) continue;
    let q = 0;
    if (f.view === 'product'){
      const m = x.maps.find(m => m.productCode === key);
      if (!m) continue;
      q = x.qty * (m.conv ?? 1);
    } else {
      if (x.c88 !== key) continue;
      q = x.qty;
    }
    const k = id + '|' + x.ch;
    const s = sums.get(k) || {qty: 0, amount: 0};
    s.qty += q; s.amount += x.amount;
    sums.set(k, s);
  }
  const rows = periods.map(p => ({label: p.label, vals: chs.map(ch => {
    const s = sums.get(p.id + '|' + ch);
    if (!s) return null;
    const d = periodDays(model, ch, f.unit === 'round' ? {unit: 'round', round: p.id} : {unit: 'day', date: p.id});
    return d ? {qty: s.qty / d, price: s.qty ? s.amount / s.qty : null} : null;
  })})).filter(r => r.vals.some(v => v));
  return {chs, rows};
}

// 표 3: 88코드별 상세 (제품코드 보기)
function dashBreakdown(model, f, productCode){
  const take = inPeriod(f), groups = new Map();
  for (const x of model.facts){
    if (!f.channels.has(x.ch) || !take(x)) continue;
    const m = x.maps.find(m => m.productCode === productCode);
    if (!m) continue;
    const g = groups.get(x.key) || {ch: x.ch, c88: x.c88, ean: m.eanName, conv: m.conv, qty: 0, amount: 0};
    g.qty += x.qty; g.amount += x.amount;
    groups.set(x.key, g);
  }
  return [...groups.values()].sort((a, b) => a.ch.localeCompare(b.ch) || a.c88.localeCompare(b.c88)).map(g => {
    const base = g.qty * (g.conv ?? 1);
    return [g.ch, g.c88, g.ean, g.conv ?? '(없음 → 1)', g.qty, base, g.amount, g.qty ? g.amount / g.qty : '', base ? g.amount / base : ''];
  });
}

// 표 4: 확대 후보 — 판매금액 구성비 기준
// 한 채널에서 구성비가 높은 제품이, 다른 채널에서는 그 30% 미만이거나 판매가 없는 경우
function dashExpansion(model, f, compare){
  const take = inPeriod(f);
  const chs = compare.chs;
  const chTotal = new Map(), sold88 = new Set();
  for (const x of model.facts){
    if (!f.channels.has(x.ch) || !take(x)) continue;
    chTotal.set(x.ch, (chTotal.get(x.ch) || 0) + x.amount);
    if (x.qty) sold88.add(x.ch + '|' + x.c88);
  }
  const out = [];
  for (const r of compare.rows){
    const shares = chs.map((ch, i) => { const v = r.vals[i], t = chTotal.get(ch); return v && t ? v.sumAmount / t : 0; });
    let top = -1;
    shares.forEach((s, i) => { if (top < 0 || s > shares[top]) top = i; });
    if (top < 0 || shares[top] <= 0) continue;
    chs.forEach((ch, i) => {
      if (i === top || !chTotal.get(ch) || compare.days.get(ch) === 0) return;
      if (shares[i] >= shares[top] * 0.3) return;
      let note = '';
      if (shares[i] === 0){
        note = '판매 없음';
        const codes = model.product88.get(r.code);
        if (f.view === 'product' && codes && [...codes].some(c => sold88.has(ch + '|' + c))) note = '판매 없음 (같은 88코드가 다른 제품코드로 판매 중)';
      }
      out.push([r.code, r.name, chs[top], shares[top], ch, shares[i], note, r.vals[top].qty]);
    });
  }
  out.sort((a, b) => b[3] - a[3] || (a[0] < b[0] ? -1 : 1));
  return out;
}

// ---------- 화면 ----------
const dash = {model: null, f: null, selected: null, products: new Set(), chartKind: 'flow', chart: null};
const DASH_LIMIT = 300;

function dashFilters(){
  const f = dash.f;
  f.unit = $('dUnit').value;
  f.round = $('dRound').value;
  f.date = $('dDate').value;
  f.view = $('dView').value;
  f.major = $('dMajor').value;
  f.minor = $('dMinor').value;
  f.q = $('dQuery').value;
  f.promo = $('dPromo').value;
  f.products = dash.products;
  f.chartKind = dash.chartKind;
  f.chartMetric = $('dChartMetric').value;
  f.metric = $('dMetric').value;
  f.from = $('dFrom').value || f.from;
  f.to = $('dTo').value || f.to;
  f.channels = new Set([...document.querySelectorAll('#dChannels input:checked')].map(i => i.value));
  return f;
}
function fillSelect(sel, options, keep){
  const prev = keep ? sel.value : '';
  sel.replaceChildren(...options.map(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; }));
  if (keep && options.some(o => o[0] === prev)) sel.value = prev;
}
function fillMinor(){
  const model = dash.model, major = $('dMajor').value;
  const minors = [...new Set([...model.prod.values()].filter(p => !major || p.major === major).map(p => p.minor).filter(Boolean))].sort();
  fillSelect($('dMinor'), [['', '전체'], ...minors.map(m => [m, m])], true);
}
function initDashControls(){
  const model = dash.model;
  const rounds = model.roundList.filter(r => model.roundsWithData.has(r.key));
  const prevRound = $('dRound').value;
  fillSelect($('dRound'), rounds.map(r => [r.key, r.label]), true);
  if (rounds.length && !rounds.some(r => r.key === prevRound)) $('dRound').value = rounds[rounds.length - 1].key;
  if (!$('dDate').value) $('dDate').value = model.maxDate;
  const majors = [...new Set([...model.prod.values()].map(p => p.major).filter(Boolean))].sort();
  fillSelect($('dMajor'), [['', '전체'], ...majors.map(m => [m, m])], true);
  fillMinor();
  const promos = [...new Set([...model.prod.values()].map(p => p.promo).filter(Boolean))].sort();
  fillSelect($('dPromo'), [['', '전체'], ...promos.map(m => [m, m])], true);
  for (const code of [...dash.products]) if (!model.prod.has(code)) dash.products.delete(code);
  renderPicker();
  const checked = new Set([...document.querySelectorAll('#dChannels input:checked')].map(i => i.value));
  const first = !document.querySelector('#dChannels input');
  $('dChannels').replaceChildren(...model.chans.map(c => {
    const l = el('label', null, 'chip'), i = document.createElement('input');
    i.type = 'checkbox'; i.value = c.channel2; i.checked = first || checked.has(c.channel2);
    i.onchange = renderDash;
    l.append(i, c.channel2);
    return l;
  }));
  if (!$('dFrom').value) $('dFrom').value = model.maxDate ? dayAdd(model.maxDate, -13) : '';
  if (!$('dTo').value) $('dTo').value = model.maxDate;
}

async function loadDash(){
  $('dT1').replaceChildren(el('p', '데이터를 불러오는 중이에요...', 'sub'));
  try {
    const [pos, mapping, product, promo, channels, margin] = await Promise.all(['pos', 'mapping', 'product', 'promo', 'channels', 'margin'].map(getAll));
    dash.model = buildDashModel({pos, mapping, product, promo, channels, margin});
    dash.soldProducts = null;
    if (!dash.f) dash.f = {};
    initDashControls();
    renderDash();
  } catch (e) {
    console.error(e);
    $('dT1').replaceChildren(el('p', `대시보드를 만들지 못했어요: ${e.message}`, 'msg err'));
  }
}

function metricCell(v, metric){
  if (!v) return '';
  if (metric === 'amount') return fmt0(v.amount);
  if (metric === 'price') return fmt0(v.price);
  return fmt1(v.qty);
}

function renderDash(){
  const model = dash.model;
  if (!model) return;
  const f = dashFilters();
  $('dRoundWrap').classList.toggle('hide', f.unit !== 'round');
  $('dDateWrap').classList.toggle('hide', f.unit !== 'day');
  $('dTrendRange').classList.toggle('hide', f.unit !== 'day' || dash.chartKind !== 'flow');
  if (!model.chans.length){
    $('dT1').replaceChildren(el('p', '보여 줄 채널이 없어요. "1. 채널 기준"을 먼저 올려 주세요.', 'msg err'));
    return;
  }
  if (!model.facts.length){
    $('dT1').replaceChildren(el('p', '매칭된 POS가 없어요. POS RAW와 매칭표를 올려 주세요.', 'msg err'));
    return;
  }

  const notes = [];
  notes.push(`채널 ${model.chans.length}곳 기준 · POS ${model.minDate} ~ ${model.maxDate}`);
  if (model.supplyChans.length) notes.push(`납품가 채널 ${model.supplyChans.join(', ')}은 판매금액을 매익률로 판매가 환산 (납품가액 × 과세계수 ÷ (1 − 매익률))`);
  else if (model.supplyAll.length) notes.push(`납품가 채널(${model.supplyAll.join(', ')})은 매익률표(데이터 업로드 → 8. 매익률)를 올리면 판매가로 환산해 함께 보여요`);
  if (model.marginFallback.size) notes.push(`매익률표에 없는 납품가 채널 품목 ${fmt(model.marginFallback.size)}개는 소분류 평균 등으로 보정 (검토 리스트 → 매익률 누락)`);
  if (model.marginNone.size) notes.push(`매익률을 정할 수 없는 품목 ${fmt(model.marginNone.size)}개는 납품가액 그대로`);
  if (model.unmatchedRows) notes.push(`매칭되지 않은 POS ${fmt(model.unmatchedRows)}행은 제외 (검토 리스트 → 매칭 누락)`);
  if (model.convMissing.size) notes.push(`전환수량이 비어 있는 채널·88코드 ${fmt(model.convMissing.size)}개는 1로 계산`);
  if (model.sameConflict.size) notes.push(`88코드·제품코드가 같은데 전환수량이 다른 채널·88코드 ${fmt(model.sameConflict.size)}개는 첫 값으로 계산`);
  $('dNotice').textContent = notes.join(' · ');

  const unitLabel = f.unit === 'round' ? `${($('dRound').selectedOptions[0] || {}).textContent || ''} (차수 일평균)` : `${f.date} (일자)`;
  const kpi = dashKpi(model, f);
  const qtyLabel = f.view === 'product' ? '낱개 환산' : 'RAW';
  const box = (l, v, s) => { const d = el('div', null, 'stat'); d.append(el('span', l), el('b', v)); if (s) d.append(el('span', s)); return d; };
  $('dKpi').replaceChildren(
    box(`판매수량 (${qtyLabel}, 기간 합계)`, fmt0(kpi.qty)),
    box(f.unit === 'round' ? '일평균 판매수량' : '판매수량 (그날)', fmt1(kpi.daily)),
    box('판매금액', fmt0(kpi.amount)),
    box(f.view === 'product' ? '낱개당 단가' : '개당 단가', fmt0(kpi.price)),
    box(f.view === 'product' ? '제품 수' : '88코드 수', fmt(kpi.products), kpi.conflicts ? `합계에 전환수량이 제품코드마다 다른 88코드 ${kpi.conflicts}개 포함 (첫 제품코드 기준)` : ''),
  );

  const cmp = dashCompare(model, f);
  const metricName = {qty: f.unit === 'round' ? '일평균 판매수량' : '판매수량', amount: f.unit === 'round' ? '일평균 판매금액' : '판매금액', price: f.view === 'product' ? '낱개당 단가' : '개당 단가'}[f.metric];
  $('dT1Title').textContent = `채널 비교 · ${unitLabel}`;
  $('dT1Note').textContent = `값: ${metricName}${f.view === 'product' ? ' (낱개 환산)' : ' (RAW)'} · 판매가 많은 순 · 이름을 누르면 아래에 추이와 88코드별 상세가 나와요. 비어 있는 칸은 그 기간에 판매가 없거나 해당 채널 차수가 없는 경우예요.`;
  if (!cmp.rows.length) $('dT1').replaceChildren(el('p', '조건에 맞는 판매가 없어요.', 'sub'));
  else {
    const heads = [f.view === 'product' ? '제품코드' : '88코드', f.view === 'product' ? '제품명' : 'EAN제품명', ...cmp.chs, f.metric === 'price' ? '전체' : '합계'];
    const rows = cmp.rows.slice(0, DASH_LIMIT).map(r => {
      const b = el('button', r.name || r.code, 'rowlink');
      b.onclick = () => { dash.selected = {key: r.code, name: r.name}; renderDetail(); $('dDetail').scrollIntoView({behavior: 'smooth', block: 'start'}); };
      const total = f.metric === 'price' ? fmt0(r.totalPrice) : f.metric === 'amount' ? fmt0(r.totalAmount) : fmt1(r.totalQty);
      return [r.code, b, ...r.vals.map(v => metricCell(v, f.metric)), total];
    });
    table($('dT1'), heads, rows, i => i >= 2);
    if (cmp.rows.length > DASH_LIMIT) $('dT1').append(el('p', `상위 ${DASH_LIMIT}개만 보여요. 분류나 검색으로 좁혀 보세요.`, 'sub'));
  }

  const exp = f.view === 'product' ? dashExpansion(model, f, cmp) : [];
  if (f.view !== 'product') $('dT4').replaceChildren(el('p', '확대 후보는 제품코드 기준에서 보여 줘요.', 'sub'));
  else if (!exp.length) $('dT4').replaceChildren(el('p', '조건에 맞는 확대 후보가 없어요.', 'sub'));
  else table($('dT4'), ['제품코드', '제품명', '강한 채널', '강한 채널 구성비', '약한 채널', '약한 채널 구성비', '비고', '강한 채널 일평균'],
    exp.slice(0, 200).map(r => [r[0], r[1], r[2], pct(r[3]), r[4], r[5] ? pct(r[5]) : '', r[6], fmt1(r[7])]), i => i === 3 || i === 5 || i === 7);

  renderChart(model, f);
  if (dash.selected) renderDetail();
}

function renderDetail(){
  const model = dash.model, f = dash.f, s = dash.selected;
  if (!model || !s) return;
  $('dDetail').classList.remove('hide');
  $('dT2Title').textContent = `${s.name || s.code} (${s.key}) 추이 · ${f.unit === 'round' ? '차수별 일평균' : '일자별'}`;
  const tr = dashTrend(model, f, s.key);
  if (!tr.rows.length) $('dT2').replaceChildren(el('p', '선택한 기간·채널에 판매가 없어요.', 'sub'));
  else table($('dT2'), [f.unit === 'round' ? '차수' : '일자', ...tr.chs],
    tr.rows.map(r => [r.label, ...r.vals.map(v => v ? `${fmt1(v.qty)} · @${fmt0(v.price)}` : '')]), i => i >= 1);
  $('dT2Note').textContent = `칸 값: ${f.unit === 'round' ? '일평균 ' : ''}판매수량${f.view === 'product' ? '(낱개 환산)' : '(RAW)'} · @${f.view === 'product' ? '낱개당' : '개당'} 단가`;
  if (f.view === 'product'){
    const bd = dashBreakdown(model, f, s.key);
    $('dT3Title').classList.remove('hide');
    if (!bd.length) $('dT3').replaceChildren(el('p', '선택한 기간에 이 제품의 판매가 없어요.', 'sub'));
    else table($('dT3'), ['채널', '88코드', 'EAN제품명', '전환수량', 'RAW 판매수량', '낱개 환산 수량', '판매금액', '개당 단가', '낱개당 단가'],
      bd.map(r => [r[0], r[1], r[2], r[3], fmt(r[4]), fmt(r[5]), fmt(r[6]), fmt0(r[7]), fmt0(r[8])]), i => i >= 4);
  } else {
    $('dT3Title').classList.add('hide');
    $('dT3').replaceChildren();
  }
}

for (const id of ['dUnit', 'dRound', 'dDate', 'dView', 'dMinor', 'dMetric', 'dFrom', 'dTo', 'dPromo', 'dChartMetric']) $(id).addEventListener('change', () => { if (id === 'dView') dash.selected = null; if (id === 'dView') $('dDetail').classList.add('hide'); renderDash(); });
$('dMajor').addEventListener('change', () => { fillMinor(); renderPicker(); renderDash(); });
let dashQueryTimer;
$('dQuery').addEventListener('input', () => { clearTimeout(dashQueryTimer); dashQueryTimer = setTimeout(renderDash, 250); });

// ---------- 제품 선택 ----------
// 판매가 있는 제품만, 위의 대·소분류·행사분류 조건에 맞는 것만 목록에 보여 준다
function pickerProducts(){
  const model = dash.model;
  if (!model) return [];
  const major = $('dMajor').value, minor = $('dMinor').value, promo = $('dPromo').value;
  if (!dash.soldProducts){
    const sold = new Map();
    for (const x of model.facts) for (const m of x.maps) sold.set(m.productCode, (sold.get(m.productCode) || 0) + x.amount);
    dash.soldProducts = sold;
  }
  return [...dash.soldProducts.entries()].map(([code, amount]) => ({...(model.prod.get(code) || {code, name: ''}), code, amount}))
    .filter(p => (!major || p.major === major) && (!minor || p.minor === minor) && (!promo || p.promo === promo))
    .sort((a, b) => b.amount - a.amount);
}
const PICKER_LIMIT = 300;
function renderPicker(){
  const q = $('dPickerQ').value.trim().toLowerCase();
  const all = pickerProducts();
  const list = all.filter(p => !q || p.code.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));
  // 선택한 제품은 맨 위에
  list.sort((a, b) => (dash.products.has(b.code) - dash.products.has(a.code)));
  $('dPickerList').replaceChildren(...list.slice(0, PICKER_LIMIT).map(p => {
    const l = el('label'), i = document.createElement('input');
    i.type = 'checkbox'; i.value = p.code; i.checked = dash.products.has(p.code);
    i.onchange = () => { if (i.checked) dash.products.add(p.code); else dash.products.delete(p.code); updatePickerSummary(); renderDash(); };
    l.append(i, el('span', `${p.name || p.code} (${p.code})`));
    return l;
  }));
  $('dPickerInfo').textContent = list.length > PICKER_LIMIT ? `판매 많은 순 ${PICKER_LIMIT}개까지 보여요. 이름으로 찾아 주세요.` : `${fmt(list.length)}개`;
  updatePickerSummary();
}
function updatePickerSummary(){
  const n = dash.products.size;
  if (!n){ $('dPickerSum').textContent = '전체 제품'; return; }
  const first = dash.model && dash.model.prod.get([...dash.products][0]);
  const name = first ? (first.name || first.code) : [...dash.products][0];
  $('dPickerSum').textContent = n === 1 ? name : `${name} 외 ${n - 1}개`;
}
$('dPickerQ').addEventListener('input', renderPicker);
$('dPickerClear').onclick = () => { dash.products.clear(); renderPicker(); renderDash(); };
document.addEventListener('click', e => { const p = $('dPicker'); if (p.open && !p.contains(e.target)) p.open = false; });
$('dPromo').addEventListener('change', renderPicker);
$('dMinor').addEventListener('change', renderPicker);

// ---------- 차트 ----------
// 판매 흐름: 가로 행사차수(일자별 보기면 날짜), 세로 수량/금액. 제품을 여러 개 고르면 제품별 묶은 세로 막대.
// 채널별 판매: 가로 채널, 세로 수량/금액 (선택한 차수 또는 일자 기준).
// 값은 표와 같은 기준: 차수별 = 차수 일평균(채널별 일평균의 합), 일자별 = 그날 값.
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const CHART_MAX_SERIES = 8;

function dashChartData(model, f, kind, forceTotal){
  const chs = model.chans.map(c => c.channel2).filter(ch => f.channels.has(ch));
  const pass = productFilter(model, f);
  const picked = !forceTotal && f.products && f.products.size ? [...f.products].filter(c => model.prod.has(c)).slice(0, CHART_MAX_SERIES) : null;
  let periods;
  if (kind === 'flow'){
    periods = f.unit === 'round'
      ? model.roundList.filter(r => model.roundsWithData.has(r.key)).map(r => ({id: r.key, label: r.label}))
      : (() => { const out = []; for (let d = f.from; d && d <= f.to && out.length < 400; d = dayAdd(d, 1)) out.push({id: d, label: d.slice(5)}); return out; })();
  } else periods = chs.map(ch => ({id: ch, label: ch}));
  const pidSet = new Set(periods.map(p => p.id));
  const take = inPeriod(f);
  const sums = new Map();
  const add = (sk, pid, ch, q, a) => { const k = sk + '|' + pid + '|' + ch; const s = sums.get(k) || {qty: 0, amount: 0}; s.qty += q; s.amount += a; sums.set(k, s); };
  for (const x of model.facts){
    if (!f.channels.has(x.ch)) continue;
    let pid;
    if (kind === 'flow'){ pid = f.unit === 'round' ? x.round : x.date; if (!pid || !pidSet.has(pid)) continue; }
    else { if (!take(x)) continue; pid = x.ch; }
    if (picked){
      for (const code of picked){
        const m = x.maps.find(m => m.productCode === code);
        if (!m) continue;
        add(code, pid, x.ch, f.view === 'product' ? x.qty * (m.conv ?? 1) : x.qty, x.amount);
      }
    } else if (f.view === 'product'){
      const hits = x.maps.filter(m => pass(m.productCode));
      if (!hits.length) continue;
      add('*', pid, x.ch, x.qty * (hits[0].conv ?? 1), x.amount);
    } else {
      if (!codePasses(model, f, x, pass)) continue;
      add('*', pid, x.ch, x.qty, x.amount);
    }
  }
  const seriesKeys = picked || ['*'];
  const daysFor = (ch, pid) => kind === 'flow'
    ? periodDays(model, ch, f.unit === 'round' ? {unit: 'round', round: pid} : {unit: 'day', date: pid})
    : periodDays(model, ch, f);
  const series = seriesKeys.map(sk => {
    const qty = [], amount = [];
    for (const p of periods){
      let q = 0, a = 0, any = false;
      for (const ch of (kind === 'flow' ? chs : [p.id])){
        const s = sums.get(sk + '|' + p.id + '|' + ch), d = daysFor(ch, p.id);
        if (!s || !d) continue;
        q += s.qty / d; a += s.amount / d; any = true;
      }
      qty.push(any ? q : null); amount.push(any ? a : null);
    }
    const prod = sk === '*' ? null : model.prod.get(sk);
    return {key: sk, label: prod ? `${prod.name || sk}` : '선택 조건 합계', qty, amount};
  });
  return {labels: periods.map(p => p.label), series, truncated: !forceTotal && f.products && f.products.size > CHART_MAX_SERIES};
}

const compactKo = n => n == null ? '' : Number(n).toLocaleString('ko-KR', {notation: 'compact', maximumFractionDigits: 1});
function renderChart(model, f){
  if (typeof Chart === 'undefined') return;
  const kind = dash.chartKind;
  const metric = kind === 'channel' && f.chartMetric === 'both' ? 'qty' : f.chartMetric;
  const bothOpt = $('dChartMetric').querySelector('option[value=both]');
  bothOpt.disabled = kind === 'channel';
  if (kind === 'channel' && $('dChartMetric').value === 'both') $('dChartMetric').value = 'qty';
  document.querySelectorAll('#dChartKind button').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
  const both = metric === 'both';
  const data = dashChartData(model, f, kind, both);
  const qtyName = f.view === 'product' ? '판매수량(낱개 환산)' : '판매수량(RAW)';
  const per = f.unit === 'round' ? '차수 일평균 ' : '';
  const unitName = metric === 'amount' ? `${per}판매금액` : metric === 'qty' ? `${per}${qtyName}` : `${per}판매금액(막대) · ${qtyName}(선)`;
  const period = kind === 'channel' ? (f.unit === 'round' ? (($('dRound').selectedOptions[0] || {}).textContent || '') : f.date) : '';
  $('dChartTitle').textContent = kind === 'flow' ? `판매 흐름 · ${unitName}` : `채널별 판매 · ${period} · ${unitName}`;
  const notes = [];
  if (both) notes.push('수량은 오른쪽 보조축이에요. 두 축의 눈금이 달라 선과 막대의 높이를 서로 비교하면 안 돼요.' + (f.products.size > 1 ? ' 여러 제품을 고르면 고른 제품들의 합계로 보여 줘요.' : ''));
  else if (data.series.length > 1) notes.push('제품별 묶은 막대예요.');
  if (data.truncated) notes.push(`차트는 고른 제품 중 ${CHART_MAX_SERIES}개까지만 보여요.`);
  if (!f.products.size) notes.push('제품을 고르지 않으면 위 조건(분류·검색 등)에 맞는 전체 합계예요.');
  if (kind === 'flow' && f.unit === 'day') notes.push('기간은 아래 시작일·종료일로 정해요.');
  $('dChartNote').textContent = notes.join(' ');

  const datasets = [];
  const bar = (label, values, color, axis) => ({type: 'bar', label, data: values, backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24, categoryPercentage: 0.8, barPercentage: 0.9, yAxisID: axis, order: 2});
  if (both){
    const s = data.series[0];
    datasets.push(bar('판매금액', s.amount, SERIES_COLORS[0], 'y'));
    datasets.push({type: 'line', label: qtyName, data: s.qty, borderColor: SERIES_COLORS[1], backgroundColor: SERIES_COLORS[1], borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: '#fcfcfb', pointBorderWidth: 2, tension: 0, spanGaps: true, yAxisID: 'y2', order: 1});
  } else {
    data.series.forEach((s, i) => datasets.push(bar(s.label, metric === 'amount' ? s.amount : s.qty, SERIES_COLORS[i % SERIES_COLORS.length], 'y')));
  }
  const ink = '#52514e', muted = '#898781', grid = '#e1e0d9', axisLine = '#c3c2b7';
  const yFmt = metric === 'amount' || both ? v => compactKo(v) : v => Number(v).toLocaleString('ko-KR', {maximumFractionDigits: 1});
  const scales = {
    x: {grid: {display: false}, border: {color: axisLine}, ticks: {color: muted, maxRotation: 0, autoSkip: true}},
    y: {beginAtZero: true, grid: {color: grid}, border: {display: false}, ticks: {color: muted, callback: yFmt}, title: {display: true, text: both ? '판매금액' : (metric === 'amount' ? '판매금액' : qtyName), color: ink}},
  };
  if (both) scales.y2 = {position: 'right', beginAtZero: true, grid: {display: false}, border: {display: false}, ticks: {color: muted, callback: v => Number(v).toLocaleString('ko-KR', {maximumFractionDigits: 1})}, title: {display: true, text: `${qtyName} (보조축)`, color: ink}};
  const showLegend = datasets.length > 1;
  const cfg = {
    data: {labels: data.labels, datasets},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: {mode: 'index', intersect: false},
      plugins: {
        legend: {display: showLegend, position: 'top', align: 'start', labels: {color: ink, boxWidth: 12, boxHeight: 12, usePointStyle: true}},
        tooltip: {callbacks: {label: c => {
          const v = c.parsed.y;
          if (v == null) return `${c.dataset.label}: 판매 없음`;
          const isAmt = c.dataset.yAxisID === 'y' && (both || metric === 'amount');
          return `${c.dataset.label}: ${isAmt ? Math.round(v).toLocaleString('ko-KR') + '원' : Number(v).toLocaleString('ko-KR', {maximumFractionDigits: 1})}`;
        }}},
      },
      scales,
    },
  };
  $('dChart').setAttribute('aria-label', $('dChartTitle').textContent);
  if (dash.chart) dash.chart.destroy();
  dash.chart = new Chart($('dChart'), cfg);
  dash.chartData = data;
}
document.querySelectorAll('#dChartKind button').forEach(b => b.addEventListener('click', () => { dash.chartKind = b.dataset.kind; renderDash(); }));
