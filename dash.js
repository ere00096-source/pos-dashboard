'use strict';
// ---------- 대시보드 ----------
// 기준: 판매가 채널만. 제품코드로 볼 때는 그 채널에서 제품코드에 연결된 88코드마다 판매수량 × 전환수량을 더한다.
// 88코드로 볼 때는 RAW 판매수량 그대로. 판매금액은 항상 RAW 합계.
// 차수별 = 차수 기간(POS가 있는 기간과 겹치는 날) 일평균, 일자별 = 그날 값.

const isPriceChannel = c => c.basis !== 'X' && c.basis.includes('판매가') && !c.basis.includes('납품');
const fmt1 = n => (n === '' || n == null || !isFinite(n)) ? '' : Number(n).toLocaleString('ko-KR', {maximumFractionDigits: 1});
const fmt0 = n => (n === '' || n == null || !isFinite(n)) ? '' : Math.round(n).toLocaleString('ko-KR');
const pct = n => (n == null || !isFinite(n)) ? '' : (n * 100).toLocaleString('ko-KR', {maximumFractionDigits: 1}) + '%';
const spanDays = (a, b) => a > b ? 0 : Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const dayAdd = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

function buildDashModel({pos, mapping, product, promo, channels}){
  const chans = channels.filter(isPriceChannel).sort((a, b) => (a.channel + a.channel2).localeCompare(b.channel + b.channel2));
  const chanSet = new Set(chans.map(c => c.channel2));
  const prod = new Map();
  for (const p of product) if (!prod.has(p.productCode)) prod.set(p.productCode, {code: p.productCode, name: p.productName || '', major: p.major || '', minor: p.minor || ''});

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
    if (!prod.has(m.productCode)) prod.set(m.productCode, {code: m.productCode, name: m.productName || '', major: '', minor: '', unclassified: true});
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
    facts.push({ch: p.channel, date: p.date, c88: p.code88, key: k, qty: p.qty, amount: p.amount, round, maps});
  }
  const roundsWithData = new Set(facts.map(x => x.round).filter(Boolean));
  return {chans, prod, mapBy, product88, roundList, roundsWithData, spans, facts, coverage, unmatchedRows, minDate, maxDate, convConflict, convMissing, sameConflict};
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
    if (q && !code.toLowerCase().includes(q) && !(p.name || '').toLowerCase().includes(q)) return false;
    return true;
  };
}
// 88코드 보기에서 검색어는 88코드·EAN제품명으로도 찾는다
function codePasses(model, f, x, pass){
  if (!x.maps.some(m => {
    const p = model.prod.get(m.productCode) || {major: '', minor: ''};
    return (!f.major || p.major === f.major) && (!f.minor || p.minor === f.minor);
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
const dash = {model: null, f: null, selected: null};
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
    const [pos, mapping, product, promo, channels] = await Promise.all(['pos', 'mapping', 'product', 'promo', 'channels'].map(getAll));
    dash.model = buildDashModel({pos, mapping, product, promo, channels});
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
  $('dTrendRange').classList.toggle('hide', f.unit !== 'day');
  if (!model.chans.length){
    $('dT1').replaceChildren(el('p', '판매가 채널이 없어요. "1. 채널 기준"을 먼저 올려 주세요.', 'msg err'));
    return;
  }
  if (!model.facts.length){
    $('dT1').replaceChildren(el('p', '판매가 채널의 매칭된 POS가 없어요. POS RAW와 매칭표를 올려 주세요.', 'msg err'));
    return;
  }

  const notes = [];
  notes.push(`판매가 채널 ${model.chans.length}곳 기준 · POS ${model.minDate} ~ ${model.maxDate}`);
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

for (const id of ['dUnit', 'dRound', 'dDate', 'dView', 'dMinor', 'dMetric', 'dFrom', 'dTo']) $(id).addEventListener('change', () => { if (id === 'dView') dash.selected = null; if (id === 'dView') $('dDetail').classList.add('hide'); renderDash(); });
$('dMajor').addEventListener('change', () => { fillMinor(); renderDash(); });
let dashQueryTimer;
$('dQuery').addEventListener('input', () => { clearTimeout(dashQueryTimer); dashQueryTimer = setTimeout(renderDash, 250); });
