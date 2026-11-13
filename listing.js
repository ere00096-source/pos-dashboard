'use strict';
// ---------- 입점 제안 ----------
// 채널 손익(총매출 = 판매수량 × 공장도가)으로 채널 간 비교. 채널 규모는 채널 내 총매출 구성비로 보정한다.
// 운영 안 함 = 그 채널에 행이 없거나 판매수량이 0.
// 후보 = 어떤 채널에서 구성비 상위 N%인데 다른 채널에서는 운영하지 않는 제품.
// 제품명에 PB가 들어간 제품은 그 채널 전용 상품이라 제안하지 않는다(매출 집계에는 포함).
const isPB = name => /PB/i.test(name || '');
// 분배구분이 PB이거나 제외인 품목도 제안하지 않는다(매출 집계에는 포함).
const isExcludedGroup = g => /^\s*(PB|제외)\s*$/i.test(g || '');
// 행사분류표 값 정리: N/A는 공백
const normPromo = v => /^\s*n\s*\/?\s*a\s*$/i.test(v || '') ? '' : (v || '').trim();

function listingAnalyze(rows, f, prod = new Map()){
  const promoOf = code => normPromo((prod.get(code) || {}).promoClass);
  const use = f.month === 'all' ? rows : rows.filter(r => r.month === f.month);
  const info = new Map(), chans = new Map();
  for (const r of use){
    const i = info.get(r.productCode);
    if (!i || r.month >= i.month) info.set(r.productCode, {code: r.productCode, name: r.productName, group: r.group, minor: r.minor, month: r.month});
    let c = chans.get(r.lv3);
    if (!c) chans.set(r.lv3, c = {name: r.lv3, total: 0, products: new Map()});
    let p = c.products.get(r.productCode);
    if (!p) c.products.set(r.productCode, p = {qty: 0, gross: 0, contribution: 0});
    p.qty += r.qty; p.gross += r.gross; p.contribution += r.contribution;
  }
  const channels = [...chans.values()];
  for (const c of channels){
    c.carried = new Map();
    for (const [code, p] of c.products) if (p.qty > 0) c.carried.set(code, p);
    c.total = [...c.carried.values()].reduce((s, p) => s + p.gross, 0);
    const ranked = [...c.carried.entries()].sort((a, b) => b[1].gross - a[1].gross || (a[0] < b[0] ? -1 : 1));
    const topN = Math.ceil(ranked.length * f.top);
    c.rank = new Map(ranked.map(([code], i) => [code, i + 1]));
    c.top = new Set(ranked.slice(0, topN).map(([code]) => code));
    c.count = ranked.length;
    c.minors = new Map();
    c.minorGross = new Map();
    c.promos = new Map();
    for (const code of c.carried.keys()){ const pr = promoOf(code); if (pr) c.promos.set(pr, (c.promos.get(pr) || 0) + 1); }
    for (const [code, p] of c.carried){
      const m = (info.get(code) || {}).minor || '';
      c.minors.set(m, (c.minors.get(m) || 0) + 1);
      c.minorGross.set(m, (c.minorGross.get(m) || 0) + p.gross);
    }
  }
  channels.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const q = (f.q || '').trim().toLowerCase();
  const passes = code => {
    const i = info.get(code) || {code, name: '', group: '', minor: ''};
    if (f.group && i.group !== f.group) return false;
    if (f.minor && i.minor !== f.minor) return false;
    if (q && !code.toLowerCase().includes(q) && !(i.name || '').toLowerCase().includes(q)) return false;
    return true;
  };

  const candidates = [];
  const pbSkipped = new Set(), groupSkipped = new Set();
  for (const t of channels){
    if (f.target && t.name !== f.target) continue;
    for (const code of info.keys()){
      if (t.carried.has(code) || !passes(code)) continue;
      if (isPB((info.get(code) || {}).name)){ pbSkipped.add(code); continue; }
      if (isExcludedGroup((info.get(code) || {}).group)){ groupSkipped.add(code); continue; }
      const sources = channels.filter(s => s !== t && s.top.has(code) && s.total > 0);
      if (!sources.length) continue;
      let best = sources[0];
      for (const s of sources){
        const sh = s.carried.get(code).gross / s.total, bh = best.carried.get(code).gross / best.total;
        if (sh > bh) best = s;
      }
      const bp = best.carried.get(code), share = bp.gross / best.total, i = info.get(code);
      // 예상 매출(소분류 기준) = 잘 팔리는 채널에서 이 제품이 소분류 매출에서 차지하는 비중 × 대상 채널의 그 소분류 매출
      // 대상 채널에 그 소분류 매출이 없으면 채널 전체 기준(구성비 × 대상 채널 총매출)으로 계산한다.
      const mi = i.minor || '';
      const srcMinor = best.minorGross.get(mi) || 0, tgtMinor = t.minorGross.get(mi) || 0;
      const inMinor = mi && srcMinor > 0 ? bp.gross / srcMinor : null;
      const byMinor = inMinor != null && tgtMinor > 0;
      const est = byMinor ? inMinor * tgtMinor : share * t.total;
      const basis = byMinor ? '소분류' : mi ? '신규 소분류 (채널 전체 기준)' : '소분류 없음 (채널 전체 기준)';
      candidates.push({target: t.name, code, name: i.name, group: i.group, minor: i.minor, source: best.name, share, inMinor,
        rank: best.rank.get(code), of: best.count, est, basis, targetMinorGross: tgtMinor, contribRate: bp.gross ? bp.contribution / bp.gross : null,
        otherSources: sources.length - 1, sameMinor: t.minors.get(mi) || 0, promo: promoOf(code), samePromo: promoOf(code) ? (t.promos.get(promoOf(code)) || 0) : null});
    }
  }
  const order = new Map(channels.map((c, i) => [c.name, i]));
  candidates.sort((a, b) => order.get(a.target) - order.get(b.target) || b.est - a.est || (a.code < b.code ? -1 : 1));

  const matrix = [...info.values()].filter(i => passes(i.code)).map(i => ({
    ...i,
    shares: channels.map(c => { const p = c.carried.get(i.code); return p && c.total ? p.gross / c.total : null; }),
    total: channels.reduce((s, c) => s + ((c.carried.get(i.code) || {}).gross || 0), 0),
  })).filter(r => r.total > 0).sort((a, b) => b.total - a.total);

  return {channels, candidates, matrix, pbSkipped, groupSkipped};
}

// ---------- 화면 ----------
const listing = {rows: null, result: null, prod: new Map()};
// 제품분류표의 대분류·소분류·행사분류표 (행사분류표가 N/A면 공백)
function classOf(code){
  const p = listing.prod.get(code) || {};
  return [p.major || '', p.minor || '', normPromo(p.promoClass)];
}
const LISTING_LIMIT = 500;

function listingFilters(){
  return {month: $('lMonth').value || 'all', target: $('lTarget').value, top: +$('lTop').value, q: $('lQuery').value, group: $('lGroup').value, minor: $('lMinor').value};
}
function fillOpts(sel, opts){
  const prev = sel.value;
  sel.replaceChildren(...opts.map(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; }));
  if (opts.some(o => o[0] === prev)) sel.value = prev;
  return prev;
}
function fillListingMinor(){
  const g = $('lGroup').value;
  const minors = [...new Set(listing.rows.filter(r => !g || r.group === g).map(r => r.minor).filter(Boolean))].sort();
  fillOpts($('lMinor'), [['', '전체'], ...minors.map(m => [m, m])]);
}

async function loadListing(){
  $('lTable').replaceChildren(el('p', '데이터를 불러오는 중이에요...', 'sub'));
  try {
    const [rows, products] = await Promise.all([getAll('pnl'), getAll('product')]);
    listing.rows = rows;
    listing.prod = new Map(products.map(p => [p.productCode, p]));
    if (!listing.rows.length){
      $('lKpi').replaceChildren();
      $('lMatrix').replaceChildren();
      $('lNotice').textContent = '';
      $('lTable').replaceChildren(el('p', '채널 손익 자료가 없어요. 데이터 업로드 → "6. 채널 손익"에 올려 주세요.', 'msg err'));
      return;
    }
    const months = [...new Set(listing.rows.map(r => r.month))].sort();
    const prevMonth = $('lMonth').value;
    fillOpts($('lMonth'), [...months.slice().reverse().map(m => [m, m]), ['all', `전체 합계 (${months.length}개월)`]]);
    if (!prevMonth || ![...months, 'all'].includes(prevMonth)) $('lMonth').value = months[months.length - 1];
    const chans = [...new Set(listing.rows.map(r => r.lv3))].sort();
    fillOpts($('lTarget'), [['', '전체 채널'], ...chans.map(c => [c, c])]);
    const groups = [...new Set(listing.rows.map(r => r.group).filter(Boolean))].sort();
    fillOpts($('lGroup'), [['', '전체'], ...groups.map(g => [g, g])]);
    fillListingMinor();
    renderListing();
  } catch (e) {
    console.error(e);
    $('lTable').replaceChildren(el('p', `입점 제안을 만들지 못했어요: ${e.message}`, 'msg err'));
  }
}

function renderListing(){
  if (!listing.rows || !listing.rows.length) return;
  const f = listingFilters();
  const res = listing.result = listingAnalyze(listing.rows, f, listing.prod);
  const period = f.month === 'all' ? '전체 기간 합계' : f.month;
  $('lNotice').textContent = `채널 ${res.channels.length}곳 · ${period} 기준 · 채널 총매출: ` + res.channels.map(c => `${c.name} ${fmt(Math.round(c.total))} (${fmt(c.count)}개 제품)`).join(' / ') + (res.pbSkipped.size ? ` · 제품명에 PB가 들어간 제품 ${fmt(res.pbSkipped.size)}개는 채널 전용이라 제안에서 제외` : '') + (res.groupSkipped.size ? ` · 분배구분이 PB·제외인 제품 ${fmt(res.groupSkipped.size)}개는 제안에서 제외` : '');

  const box = (l, v, s) => { const d = el('div', null, 'stat'); d.append(el('span', l), el('b', v)); if (s) d.append(el('span', s)); return d; };
  const targets = res.channels.filter(c => !f.target || c.name === f.target);
  $('lKpi').style.gridTemplateColumns = `repeat(${Math.min(Math.max(targets.length, 1), 4)}, minmax(0, 1fr))`;
  $('lKpi').replaceChildren(...targets.map(c => {
    const list = res.candidates.filter(x => x.target === c.name);
    return box(`${c.name} 입점 후보`, `${fmt(list.length)}개`, `예상 매출 합계 ${fmt(Math.round(list.reduce((s, x) => s + x.est, 0)))}`);
  }));

  const heads = ['입점 대상 채널', '대분류', '소분류', '행사분류표', '제품코드', '제품명', '잘 팔리는 채널', '그 채널 구성비', '그 채널 순위', '그 채널 소분류 내 비중', '대상 채널 소분류 매출', '예상 매출', '계산 기준', '공헌이익률', '다른 강한 채널 수', '대상 채널 같은 소분류', '대상 채널 같은 행사분류표'];
  const rows = res.candidates.slice(0, LISTING_LIMIT).map(x => [x.target, ...classOf(x.code), x.code, x.name, x.source, pct(x.share), `${x.rank} / ${x.of}`, x.inMinor == null ? '' : pct(x.inMinor), fmt(Math.round(x.targetMinorGross)), fmt(Math.round(x.est)), x.basis, x.contribRate == null ? '' : pct(x.contribRate), x.otherSources || '', x.sameMinor ? `있음 (${x.sameMinor}개)` : '없음', x.samePromo == null ? '' : x.samePromo ? `있음 (${x.samePromo}개)` : '없음']);
  if (!rows.length) $('lTable').replaceChildren(el('p', '조건에 맞는 입점 후보가 없어요.', 'sub'));
  else {
    table($('lTable'), heads, rows, i => (i >= 7 && i <= 11) || i === 13 || i === 14);
    if (res.candidates.length > LISTING_LIMIT) $('lTable').append(el('p', `상위 ${LISTING_LIMIT}개만 보여요. "이 표 복사"로는 전체를 받을 수 있어요.`, 'sub'));
  }
  $('lMsg').textContent = '';

  const mh = ['제품코드', '제품명', '분배구분', '소분류', ...res.channels.map(c => c.name), '총매출 합계'];
  const mr = res.matrix.slice(0, LISTING_LIMIT).map(r => [r.code, r.name, r.group, r.minor, ...r.shares.map(s => s == null ? '–' : pct(s)), fmt(Math.round(r.total))]);
  if (!mr.length) $('lMatrix').replaceChildren(el('p', '조건에 맞는 제품이 없어요.', 'sub'));
  else {
    table($('lMatrix'), mh, mr, i => i >= 4);
    if (res.matrix.length > LISTING_LIMIT) $('lMatrix').append(el('p', `상위 ${LISTING_LIMIT}개만 보여요. 분류나 검색으로 좁혀 보세요.`, 'sub'));
  }
}

$('lCopy').onclick = async () => {
  const res = listing.result;
  if (!res || !res.candidates.length) return;
  const heads = ['입점 대상 채널', '대분류', '소분류', '행사분류표', '제품코드', '제품명', '잘 팔리는 채널', '그 채널 구성비(%)', '그 채널 순위', '그 채널 제품 수', '그 채널 소분류 내 비중(%)', '대상 채널 소분류 매출', '예상 매출', '계산 기준', '공헌이익률(%)', '다른 강한 채널 수', '대상 채널 같은 소분류 제품 수', '대상 채널 같은 행사분류표 제품 수'];
  const rows = res.candidates.map(x => [x.target, ...classOf(x.code), x.code, x.name, x.source, +(x.share * 100).toFixed(2), x.rank, x.of, x.inMinor == null ? '' : +(x.inMinor * 100).toFixed(2), Math.round(x.targetMinorGross), Math.round(x.est), x.basis, x.contribRate == null ? '' : +(x.contribRate * 100).toFixed(2), x.otherSources, x.sameMinor, x.samePromo == null ? '' : x.samePromo]);
  try {
    await navigator.clipboard.writeText(listToTsv({heads, rows}));
    $('lMsg').textContent = `${fmt(rows.length)}행을 복사했어요. 엑셀에 붙여넣으세요.`;
  } catch (e) {
    $('lMsg').textContent = `복사하지 못했어요: ${e.message}`;
  }
};
for (const id of ['lMonth', 'lTarget', 'lTop', 'lMinor']) $(id).addEventListener('change', renderListing);
$('lGroup').addEventListener('change', () => { fillListingMinor(); renderListing(); });
let listingQueryTimer;
$('lQuery').addEventListener('input', () => { clearTimeout(listingQueryTimer); listingQueryTimer = setTimeout(renderListing, 250); });
