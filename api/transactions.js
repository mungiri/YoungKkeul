/**
 * 영끌컷 · 매물(실거래가) 검색 서버리스 엔드포인트
 * =====================================================
 * 국토교통부_아파트 매매 실거래가 자료 OpenAPI를 호출해
 * "마지노선 가격(예산 상한) 이하로 살 수 있는 단지"를 묶어서 반환한다.
 *
 * 아키텍처 원칙:
 *   - 개인 재무 데이터(현금/소득/부채)는 절대 서버로 보내지 않는다.
 *     클라이언트에서 계산한 '마지노선 가격(maxPrice)'만 예산 상한으로 넘어온다.
 *   - API 키는 프론트에 노출 금지 → Vercel 환경변수 MOLIT_API_KEY 로만 접근.
 *
 * 환경변수:
 *   MOLIT_API_KEY = data.go.kr 에서 발급한 '일반 인증키(Decoding)'
 *     (https://www.data.go.kr → "아파트 매매 실거래가 자료" 활용신청 → 자동승인)
 *
 * 호출 예:
 *   /api/transactions?gu=성동구&maxPrice=600000000&months=3&minArea=50&maxArea=85
 *
 * 쿼리 파라미터:
 *   gu        (필수) 서울 자치구 이름. 예: "강동구"  (또는 lawdCd 5자리 직접 전달)
 *   lawdCd    (선택) 법정동코드 5자리. gu 대신 직접 지정 시.
 *   maxPrice  (선택) 예산 상한(원). 이 가격 이하 단지만 반환. 미지정 시 필터 없음.
 *   minArea   (선택) 전용면적 하한(㎡)
 *   maxArea   (선택) 전용면적 상한(㎡)
 *   months    (선택) 최근 N개월 실거래를 합산 조회. 기본 3, 최대 12.
 *   limit     (선택) 반환 단지 수 상한. 기본 30.
 */

// 서울 25개 자치구 → 법정동코드 앞 5자리(LAWD_CD)
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

// 최근 N개월의 YYYYMM 배열 (이번 달 제외 — 당월은 데이터가 거의 없으므로 직전 달부터)
function recentYearMonths(n) {
  const out = [];
  const base = new Date();
  base.setDate(1);
  for (let i = 1; i <= n; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push(ym);
  }
  return out;
}

// 플랫 XML <item>…</item> 블록에서 단일 태그 값 추출 (의존성 0)
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1].trim() : '';
}

// MOLIT 한 페이지 호출 → item 객체 배열
async function fetchMonth(serviceKey, lawdCd, dealYmd) {
  const qs = new URLSearchParams({
    serviceKey,
    LAWD_CD: lawdCd,
    DEAL_YMD: dealYmd,
    pageNo: '1',
    numOfRows: '1000',
  });
  const res = await fetch(`${MOLIT_URL}?${qs.toString()}`);
  const xml = await res.text();

  // API 레벨 에러(키 미승인/한도초과 등) 감지
  const resultCode = tag(xml, 'resultCode') || tag(xml, 'returnReasonCode');
  if (resultCode && resultCode !== '000' && resultCode !== '00') {
    const msg = tag(xml, 'resultMsg') || tag(xml, 'returnAuthMsg') || 'MOLIT API error';
    const err = new Error(msg);
    err.code = resultCode;
    throw err;
  }

  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const amountMan = Number(tag(b, 'dealAmount').replace(/[,\s]/g, ''));
    if (!amountMan) continue;
    items.push({
      apt: tag(b, 'aptNm'),
      dong: tag(b, 'umdNm'),
      jibun: tag(b, 'jibun'),
      area: Number(tag(b, 'excluUseAr')) || 0,        // 전용면적 ㎡
      floor: Number(tag(b, 'floor')) || 0,
      buildYear: Number(tag(b, 'buildYear')) || 0,
      priceWon: amountMan * 10000,                     // 만원 → 원
      dealDate: `${tag(b, 'dealYear')}-${String(tag(b, 'dealMonth')).padStart(2, '0')}-${String(tag(b, 'dealDay')).padStart(2, '0')}`,
    });
  }
  return items;
}

module.exports = async function handler(req, res) {
  try {
    const serviceKey = process.env.MOLIT_API_KEY;
    if (!serviceKey) {
      res.status(500).json({
        error: 'MOLIT_API_KEY 환경변수가 설정되지 않았습니다.',
        hint: 'data.go.kr에서 "아파트 매매 실거래가 자료" 활용신청 후 일반 인증키(Decoding)를 Vercel 환경변수 MOLIT_API_KEY로 등록하세요.',
      });
      return;
    }

    const q = req.query || {};
    const lawdCd = q.lawdCd || SEOUL_LAWD[q.gu];
    if (!lawdCd) {
      res.status(400).json({
        error: 'gu(서울 자치구 이름) 또는 lawdCd(법정동코드 5자리)가 필요합니다.',
        available: Object.keys(SEOUL_LAWD),
      });
      return;
    }

    const maxPrice = Number(q.maxPrice) || Infinity;
    const minArea = Number(q.minArea) || 0;
    const maxArea = Number(q.maxArea) || Infinity;
    const months = Math.min(Math.max(Number(q.months) || 3, 1), 12);
    const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 100);

    // 최근 N개월 병렬 조회
    const yms = recentYearMonths(months);
    const monthly = await Promise.all(yms.map((ym) => fetchMonth(serviceKey, lawdCd, ym)));
    let deals = monthly.flat();

    // 면적 필터
    deals = deals.filter((d) => d.area >= minArea && d.area <= maxArea);

    // 단지(아파트명+법정동) 단위로 집계
    const byComplex = new Map();
    for (const d of deals) {
      const key = `${d.dong}·${d.apt}`;
      if (!byComplex.has(key)) {
        byComplex.set(key, {
          apt: d.apt, dong: d.dong, buildYear: d.buildYear,
          deals: [], minPrice: Infinity, maxPrice: 0, sumPrice: 0,
          recentDate: '', recentPrice: 0,
        });
      }
      const c = byComplex.get(key);
      c.deals.push(d);
      c.minPrice = Math.min(c.minPrice, d.priceWon);
      c.maxPrice = Math.max(c.maxPrice, d.priceWon);
      c.sumPrice += d.priceWon;
      if (d.dealDate > c.recentDate) { c.recentDate = d.dealDate; c.recentPrice = d.priceWon; }
    }

    // 예산 상한: '최저 실거래가가 예산 이하'인 단지만 (진입 가능성 기준)
    let complexes = [...byComplex.values()]
      .map((c) => ({
        apt: c.apt,
        dong: c.dong,
        buildYear: c.buildYear,
        dealCount: c.deals.length,
        minPrice: c.minPrice,
        maxPrice: c.maxPrice,
        avgPrice: Math.round(c.sumPrice / c.deals.length),
        recentDate: c.recentDate,
        recentPrice: c.recentPrice,
        // 예산으로 들어갈 수 있는 면적대(예산 이하 거래의 전용면적 범위)
        affordableAreas: c.deals
          .filter((d) => d.priceWon <= maxPrice)
          .map((d) => d.area),
      }))
      .filter((c) => c.minPrice <= maxPrice)
      .sort((a, b) => a.minPrice - b.minPrice)
      .slice(0, limit);

    res.status(200).json({
      query: { gu: q.gu || null, lawdCd, maxPrice: Number.isFinite(maxPrice) ? maxPrice : null, months, minArea, maxArea: Number.isFinite(maxArea) ? maxArea : null },
      months: yms,
      totalDeals: deals.length,
      complexCount: complexes.length,
      complexes,
      disclaimer: '국토교통부 실거래가(과거 거래 기록)이며 현재 호가/매물이 아닙니다. 신고 지연으로 최근 거래가 누락될 수 있습니다.',
    });
  } catch (e) {
    res.status(502).json({ error: 'MOLIT API 조회 실패', detail: e.message, code: e.code || null });
  }
};
