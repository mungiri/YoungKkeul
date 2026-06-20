/**
 * 영끌컷 · 부동산 시장 지표(상승/하락) 서버리스 엔드포인트
 * =====================================================
 * 국토교통부 아파트 매매 실거래가로 '자치구별 월별 평균 ㎡가·거래량'을 산출해
 * 최근 추세(상승/하락/보합)를 판정한다.
 *   ※ 한국부동산원·KB의 '공식 지수'가 아니라 실거래가에서 파생한 추정 지표.
 *     (다음 단계: R-ONE 공식 지수 연동 시 같은 응답 스키마에 official 필드 추가)
 *
 * 환경변수: MOLIT_API_KEY (transactions.js와 동일 키 사용)
 *
 * 호출: /api/market?gu=송파구&months=12
 *   gu     (필수) 서울 자치구명 (또는 lawdCd 5자리)
 *   months (선택) 분석 개월수. 기본 12, 6~24.
 */

const SEOUL_LAWD = {
  '종로구': '11110', '중구': '11140', '용산구': '11170', '성동구': '11200',
  '광진구': '11215', '동대문구': '11230', '중랑구': '11260', '성북구': '11290',
  '강북구': '11305', '도봉구': '11320', '노원구': '11350', '은평구': '11380',
  '서대문구': '11410', '마포구': '11440', '양천구': '11470', '강서구': '11500',
  '구로구': '11530', '금천구': '11545', '영등포구': '11560', '동작구': '11590',
  '관악구': '11620', '서초구': '11650', '강남구': '11680', '송파구': '11710',
  '강동구': '11740',
};

const MOLIT_URL =
  'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade';

const config = { maxDuration: 30 };
module.exports.config = config;

async function timedFetch(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}
async function withRetry(fn, retries = 1) {
  try { return await fn(); }
  catch (e) { if (retries > 0 && !e.code) return withRetry(fn, retries - 1); throw e; }
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1].trim() : '';
}

// 최근 N개월 YYYYMM (이번 달 제외, 직전 달부터 과거로)
function recentYearMonths(n) {
  const out = [];
  const base = new Date(); base.setDate(1);
  for (let i = 1; i <= n; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// MOLIT 한 달 호출 → {area(전용㎡), priceWon} 배열 (시장지표엔 면적·가격만 필요)
async function fetchMonth(serviceKey, lawdCd, dealYmd) {
  const qs = new URLSearchParams({
    serviceKey, LAWD_CD: lawdCd, DEAL_YMD: dealYmd, pageNo: '1', numOfRows: '1000',
  });
  const res = await timedFetch(`${MOLIT_URL}?${qs.toString()}`, 10000);
  const xml = await res.text();
  const resultCode = tag(xml, 'resultCode') || tag(xml, 'returnReasonCode');
  if (resultCode && resultCode !== '000' && resultCode !== '00') {
    const err = new Error(tag(xml, 'resultMsg') || tag(xml, 'returnAuthMsg') || 'MOLIT API error');
    err.code = resultCode; throw err;
  }
  const items = [];
  for (const b of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    const amountMan = Number(tag(b, 'dealAmount').replace(/[,\s]/g, ''));
    const area = Number(tag(b, 'excluUseAr')) || 0;
    if (!amountMan || !area) continue;
    items.push({ area, priceWon: amountMan * 10000 });
  }
  return items;
}

// 배열 평균
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

// 동시 실행 개수 제한(장기간 조회 시 MOLIT 폭주 방지). 순서 보존 + settled 형태 반환.
async function mapLimitSettled(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { ret[idx] = { status: 'fulfilled', value: await fn(items[idx]) }; }
      catch (e) { ret[idx] = { status: 'rejected', reason: e }; }
    }
  });
  await Promise.all(workers);
  return ret;
}

module.exports = async function handler(req, res) {
  try {
    const serviceKey = process.env.MOLIT_API_KEY;
    if (!serviceKey) {
      res.status(500).json({ error: 'MOLIT_API_KEY 환경변수가 설정되지 않았습니다.' });
      return;
    }
    const q = req.query || {};
    const lawdCd = q.lawdCd || SEOUL_LAWD[q.gu];
    if (!lawdCd) {
      res.status(400).json({ error: 'gu(서울 자치구명) 또는 lawdCd 5자리가 필요합니다.', available: Object.keys(SEOUL_LAWD) });
      return;
    }
    const months = Math.min(Math.max(Number(q.months) || 12, 6), 60);   // 최대 5년(집값 차트용)

    const yms = recentYearMonths(months);   // [최근...과거]
    const settled = await mapLimitSettled(yms, 12, (ym) => withRetry(() => fetchMonth(serviceKey, lawdCd, ym)));
    if (!settled.some((s) => s.status === 'fulfilled')) {
      const reason = settled.find((s) => s.status === 'rejected');
      res.status(502).json({ error: `국토부 실거래가 조회 실패: ${(reason && reason.reason && reason.reason.message) || '알 수 없는 오류'}` });
      return;
    }

    // 월별 집계: 평균 ㎡가(원/㎡), 거래량, 평균 거래가
    const monthly = yms.map((ym, i) => {
      const s = settled[i];
      const deals = s.status === 'fulfilled' ? s.value : [];
      const ppms = deals.map((d) => d.priceWon / d.area);
      const prices = deals.map((d) => d.priceWon);
      return {
        ym,
        count: deals.length,
        avgPpm: Math.round(avg(ppms)),                 // 원/㎡
        pyeongPrice: Math.round(avg(ppms) * 3.305785), // 평당가(원)
        avgPrice: Math.round(avg(prices)),
      };
    }).reverse();   // 과거→최근(차트용 오름차순)

    // 추세 지표: 최근 vs 직전 (데이터 있는 달 기준)
    const valid = monthly.filter((m) => m.count > 0);
    const ppmOf = (arr) => avg(arr.map((m) => m.avgPpm));
    const cntOf = (arr) => avg(arr.map((m) => m.count));
    const pct = (now, before) => (before > 0 ? Math.round((now - before) / before * 1000) / 10 : null);

    const n = valid.length;
    const last3 = valid.slice(Math.max(0, n - 3));
    const prev3 = valid.slice(Math.max(0, n - 6), Math.max(0, n - 3));
    const last6 = valid.slice(Math.max(0, n - 6));
    const prev6 = valid.slice(Math.max(0, n - 12), Math.max(0, n - 6));

    const chg3 = (prev3.length && last3.length) ? pct(ppmOf(last3), ppmOf(prev3)) : null;
    const chg6 = (prev6.length && last6.length) ? pct(ppmOf(last6), ppmOf(prev6)) : null;
    const volChg = (prev3.length && last3.length) ? pct(cntOf(last3), cntOf(prev3)) : null;

    // 판정: 최근 3개월 ㎡가 변화율 기준 (±0.5%p 보합 밴드)
    let verdict = 'flat', verdictLabel = '보합';
    if (chg3 != null) {
      if (chg3 >= 0.5) { verdict = 'up'; verdictLabel = '상승세'; }
      else if (chg3 <= -0.5) { verdict = 'down'; verdictLabel = '하락세'; }
    }

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=21600');
    res.status(200).json({
      gu: q.gu || null, lawdCd, months,
      monthly,
      summary: {
        verdict, verdictLabel,
        chg3, chg6, volChg,
        recentPyeongPrice: last3.length ? Math.round(ppmOf(last3) * 3.305785) : null,
        recentAvgCount: last3.length ? Math.round(cntOf(last3)) : null,
        totalDeals: valid.reduce((s, m) => s + m.count, 0),
      },
      source: '국토교통부 아파트 매매 실거래가(파생 추정)',
      disclaimer: '국토부 실거래가에서 산출한 추정 지표이며 한국부동산원·KB 공식 지수와 다를 수 있습니다. 신고 지연으로 최근 1~2개월은 거래가 적게 잡혀 변동성이 큽니다.',
    });
  } catch (e) {
    res.status(502).json({ error: 'MOLIT API 조회 실패', detail: e.message, code: e.code || null });
  }
};
