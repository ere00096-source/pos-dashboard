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

// ---------- 엑셀 내보내기 (함수로 예상 판매량 계산) ----------
// 일별판매 시트: 채널+88코드+날짜별 1행. 예측 시트: 채널·88코드·판매가·범위를 넣으면 AVERAGEIFS로 계산.
function simExportRows(model, year, ch){
  const m = new Map();
  for (const x of model.facts){
    if ((ch && x.ch !== ch) || (year && x.date.slice(0, 4) !== year)) continue;
    const k = x.ch + '|' + x.c88 + '|' + x.date;
    const o = m.get(k) || {ch: x.ch, date: x.date, c88: x.c88, maps: x.maps, qty: 0, amount: 0, round: x.round};
    o.qty += x.qty; o.amount += x.amount; if (!o.round && x.round) o.round = x.round;
    m.set(k, o);
  }
  const roundLabel = new Map(model.roundList.map(r => [r.key, r.label]));
  return [...m.values()].filter(o => o.qty > 0 && o.amount > 0)
    .sort((a, b) => a.ch.localeCompare(b.ch, 'ko') || (a.c88 < b.c88 ? -1 : a.c88 > b.c88 ? 1 : 0) || (a.date < b.date ? -1 : 1))
    .map(o => {
      const codes = o.maps.map(x => x.productCode), p = model.prod.get(codes[0]);
      return [o.ch, o.date, o.c88, codes.join(','), (p && p.name) || o.maps[0].eanName || '', Math.round(o.amount / o.qty * 10) / 10, o.qty, Math.round(o.amount), roundLabel.get(o.round) || '차수 외'];
    });
}
const SIM_INPUT_ROWS = 300;
function simWorkbook(rows, example, nInput = SIM_INPUT_ROWS){
  const wb = XLSX.utils.book_new();
  const D = '일별판매';
  const head = ['채널', '88코드', '제품코드(참고)', '판매가(원)', '범위±(%)', '예상 일 판매량(평균)', '해당 일수', '최소', '최대', '비교 하한', '비교 상한'];
  const aoa = [head];
  for (let i = 0; i < nInput; i++) aoa.push(i === 0 && example ? [example.ch, example.c88, example.code, example.price || '', 1] : ['', '', '', '', 1]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const rng = col => `'${D}'!$${col}:$${col}`;
  for (let r = 2; r <= nInput + 1; r++){
    const cond = `${rng('A')},$A${r},${rng('C')},""&$B${r},${rng('F')},">="&$J${r},${rng('F')},"<="&$K${r}`;
    const blank = `OR($A${r}="",$B${r}="",$D${r}="")`;
    ws['J' + r] = {t: 'n', f: `IF(${blank},"",$D${r}*(1-$E${r}/100))`};
    ws['K' + r] = {t: 'n', f: `IF(${blank},"",$D${r}*(1+$E${r}/100))`};
    ws['F' + r] = {t: 'n', f: `IF(${blank},"",IFERROR(ROUND(AVERAGEIFS(${rng('G')},${cond}),1),"해당 판매가 없음"))`};
    ws['G' + r] = {t: 'n', f: `IF(${blank},"",COUNTIFS(${cond}))`};
    ws['H' + r] = {t: 'n', f: `IF(OR(${blank},$G${r}=0),"",_xlfn.MINIFS(${rng('G')},${cond}))`};
    ws['I' + r] = {t: 'n', f: `IF(OR(${blank},$G${r}=0),"",_xlfn.MAXIFS(${rng('G')},${cond}))`};
  }
  ws['!ref'] = `A1:K${nInput + 1}`;
  ws['!cols'] = [14, 16, 16, 11, 9, 18, 9, 8, 8, 10, 10].map(w => ({wch: w}));
  XLSX.utils.book_append_sheet(wb, ws, '예측');
  const wd = XLSX.utils.aoa_to_sheet([['채널', '날짜', '88코드', '제품코드', '제품명', '판매가(원)', '판매수량', '판매금액', '행사차수'], ...rows]);
  for (let r = 2; r <= rows.length + 1; r++){ const c = wd['C' + r]; if (c){ c.t = 's'; c.v = String(c.v); } }
  wd['!cols'] = [14, 11, 16, 16, 30, 10, 9, 12, 10].map(w => ({wch: w}));
  XLSX.utils.book_append_sheet(wb, wd, D);
  const help = [
    ['사용 방법'],
    ['1. 예측 시트에 채널 · 88코드 · 판매가를 적으면 예상 일 판매량이 계산돼요. 범위는 기본 ±1%예요.'],
    ['2. 예상 일 판매량 = 일별판매 시트에서 같은 채널 · 88코드이고, 하루 판매가가 판매가 ±범위 안인 날들의 판매수량 평균이에요.'],
    ['3. 하루 판매가 = 그날 판매금액 ÷ 판매수량. 납품가 채널은 매익률로 환산한 판매가예요. 판매수량은 판매단위(88코드) 기준이에요.'],
    ['4. 채널명은 일별판매 시트의 채널 값과 똑같이 적어 주세요. 제품코드 칸은 참고용이고 계산에는 쓰지 않아요.'],
    ['5. 최소 · 최대(MINIFS · MAXIFS)는 엑셀 2019 이상에서 계산돼요.'],
  ];
  const wh = XLSX.utils.aoa_to_sheet(help); wh['!cols'] = [{wch: 110}];
  XLSX.utils.book_append_sheet(wb, wh, '설명');
  return XLSX.write(wb, {type: 'array', bookType: 'xlsx'});
}
async function simExport(){
  const model = sim.model, btn = $('sExport');
  if (!model) return;
  const year = $('sYear').value, ch = $('sExpScope').value === 'ch' ? $('sCh').value : '';
  const rows = simExportRows(model, year, ch);
  if (!rows.length){ $('sExpMsg').textContent = '내보낼 판매 기록이 없어요.'; return; }
  if (rows.length > 1000000){ $('sExpMsg').textContent = `행이 ${rows.length.toLocaleString()}개라 엑셀 한도를 넘어요. 현재 채널만 내보내 주세요.`; return; }
  btn.disabled = true; $('sExpMsg').textContent = `${rows.length.toLocaleString()}행으로 파일을 만드는 중이에요...`;
  try {
    const p = (sim.products || []).find(x => x.code === $('sProd').value);
    const price = Number(String($('sPrice').value).replace(/[,\s원]/g, ''));
    const ex = $('sCh').value && $('s88').value ? {ch: $('sCh').value, c88: $('s88').value, code: p ? p.code : '', price: price > 0 ? price : ''} : null;
    const name = `판매량예측_${ch || '전체채널'}_${year || '전체기간'}.xlsx`;
    const r = await saveFile(name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx', async () => simWorkbook(rows, ex));
    $('sExpMsg').textContent = r === 'cancelled' ? '저장을 취소했어요.' : r === 'downloaded' ? `${rows.length.toLocaleString()}행 파일 다운로드를 시작했어요. 다운로드 폴더를 확인해 주세요.` : `${rows.length.toLocaleString()}행을 담아 저장했어요.`;
  } catch (e) {
    console.error(e); $('sExpMsg').textContent = `파일을 만들지 못했어요: ${e.message}`;
  } finally { btn.disabled = false; }
}
$('sExport').onclick = () => simExport();
