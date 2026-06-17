/**
 * 영끌컷 · 주변 상권 분석 서버리스 엔드포인트
 * =====================================================
 * 소상공인시장진흥공단 "상가(상권)정보 API"(data.go.kr 15012005, 서비스 B553077/sdsc2)의
 * 반경상권(storeListInRadius)을 호출해, 특정 좌표 주변 점포를 업종별로 집계하고
 * "동네 분위기(vibe)"를 자동 분석한다.
 *
 * 아키텍처 원칙(transactions.js / redevelopment.js와 동일):
 *   - 의존성 0. fetch + 표준 JSON 파싱.
 *   - 업스트림 지연 대비 timedFetch + 동시호출 제한 mapLimit.
 *   - API 키는 프론트 노출 금지 → Vercel 환경변수로만 접근.
 *
 * 환경변수:
 *   SBIZ_API_KEY = data.go.kr "소상공인시장진흥공단_상가(상권)정보 API" 활용신청 후
 *                  발급되는 '일반 인증키(Decoding)'.
 *   ※ data.go.kr 인증키는 계정당 1개라, 같은 계정으로 이 API를 활용신청했다면
 *     기존 MOLIT_API_KEY 값과 동일하다. 그래서 SBIZ_API_KEY가 없으면 MOLIT_API_KEY로 폴백한다.
 *     (단, 해당 계정으로 '상가정보 API' 활용신청 승인이 되어 있어야 호출된다.)
 *
 * 호출 예:
 *   /api/commerce?lng=127.0405&lat=37.5503&radius=500
 *
 * 쿼리 파라미터:
 *   lng / cx  (필수) 경도(소수). 카카오 지오코더 결과 x.
 *   lat / cy  (필수) 위도(소수). 카카오 지오코더 결과 y.
 *   radius    (선택) 반경(m). 기본 500, 최대 2000(소상공인 API 상한).
 *   pages     (선택) 집계용 최대 페이지 수(페이지당 1000건). 기본 3, 최대 5.
 */

const SDSC_RADIUS_URL =
  'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius';

const ROWS_PER_PAGE = 1000;   // 소상공인 API 페이지당 상한
const MARKER_CAP = 600;       // 프론트 지도 마커 상한(과도한 페이로드 방지)
const PAGE_CAP = 8;           // 한 요청에 받을 최대 페이지 수(=8000건). 반경 전구간 커버용 기본값

const config = { maxDuration: 30 };
module.exports.config = config;

// 타임아웃 있는 fetch (업스트림이 느려도 함수가 행에 안 걸리도록)
async function timedFetch(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// 일시 오류(타임아웃/네트워크) 1회 재시도. 즉시 throw할 항목이 없는 fetch 래퍼라 단순 재귀로 처리.
async function withRetry(fn, retries = 1) {
  try { return await fn(); }
  catch (e) { if (retries > 0) return withRetry(fn, retries - 1); throw e; }
}

// 동시 실행 개수 제한
async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return ret;
}

// 받을 페이지 번호 선택: 전체가 상한 이하면 1~끝 전부, 초과하면 1~끝을 균등 분산(양끝 포함).
//   소상공인 API가 경도순 정렬이라, 분산 수신하면 동·서를 고루 포함해 지도 쏠림을 막는다.
function pickPages(totalPages, cap) {
  if (totalPages <= cap) return Array.from({ length: totalPages }, (_, i) => i + 1);
  if (cap <= 1) return [1];
  const out = [];
  for (let k = 0; k < cap; k++) out.push(Math.round(1 + (k * (totalPages - 1)) / (cap - 1)));
  return [...new Set(out)];
}

// 소상공인 API 응답(JSON) 파서 → { items, totalCount, error }
//   구조: { header:{resultCode,resultMsg}, body:{items:[...], totalCount} } (간혹 response로 한 겹 더 감싸짐)
function parseSdsc(text) {
  const t = (text || '').trim();
  if (t[0] !== '{' && t[0] !== '[') {
    // 평문(403 Forbidden, 인증오류 XML 등)
    const m = t.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/) ||
              t.match(/<errMsg>([^<]*)<\/errMsg>/) ||
              t.match(/<resultMsg>([^<]*)<\/resultMsg>/);
    return { items: [], totalCount: 0, error: m ? m[1] : (t.slice(0, 160) || '빈 응답') };
  }
  let j;
  try { j = JSON.parse(t); } catch { return { items: [], totalCount: 0, error: 'JSON 파싱 실패' }; }
  const root = j.response || j;
  const header = root.header || (root.cmmMsgHeader) || {};
  const code = header.resultCode || header.returnReasonCode;
  if (code && code !== '00' && code !== '000') {
    return { items: [], totalCount: 0, error: header.resultMsg || header.returnAuthMsg || `API error ${code}`, code };
  }
  const body = root.body || {};
  let items = (body.items && (body.items.item || body.items)) || body.item || [];
  if (!items || typeof items === 'string') items = [];
  if (!Array.isArray(items)) items = [items];
  return { items, totalCount: Number(body.totalCount) || items.length };
}

// 반경상권 한 페이지 호출
async function fetchRadiusPage(serviceKey, lng, lat, radius, pageNo) {
  const qs = new URLSearchParams({
    serviceKey,
    radius: String(radius),
    cx: String(lng),     // 경도
    cy: String(lat),     // 위도
    pageNo: String(pageNo),
    numOfRows: String(ROWS_PER_PAGE),
    type: 'json',
  });
  const res = await timedFetch(`${SDSC_RADIUS_URL}?${qs.toString()}`, 10000);
  return parseSdsc(await res.text());
}

/* ===== 업종 키워드 분류 (코드 대신 명칭 키워드 매칭 — 코드 개정에 강건) ===== */
// 소상공인 중분류(indsMclsNm)/소분류(indsSclsNm) 명칭에 대한 키워드 룰.
const KW = {
  cafe:        /카페|커피|디저트|제과|베이커리|빙수|차(茶)?전문/,
  bar:         /주점|호프|유흥|단란|포차|칵테일|와인|이자카야|바\b|펍|클럽/,
  restaurant:  /한식|중식|일식|양식|분식|치킨|패스트푸드|음식|식당|뷔페|고기|국수|면류|해물|횟집|곱창|족발|보쌈/,
  convenience: /편의점|슈퍼|마트|식료품|반찬|정육|청과|세탁|미용|이용|네일|목욕|화장품|약국/,
  medical:     /병원|의원|치과|한의원|약국|보건|의료|동물병원/,
  education:   /학원|교습|보습|입시|외국어|예능학원|어린이집|유치원|교육/,
  beauty:      /미용|네일|피부|왁싱|에스테틱|성형|뷰티|헤어/,
  fashion:     /의류|패션|신발|가방|잡화|액세서리|안경/,
  living:      /부동산|중개|수리|세무|법무|인테리어|철물|가구|생활|서비스/,
  leisure:     /노래|당구|pc|피시|볼링|스크린|게임|오락|찜질|사우나|스포츠|헬스|요가|필라테스|골프|관광|여가/,
};
function tagOf(mcls, scls) {
  const s = `${mcls || ''} ${scls || ''}`;
  const tags = [];
  for (const [k, re] of Object.entries(KW)) if (re.test(s)) tags.push(k);
  return tags;
}

// 섀넌 엔트로피 기반 업종 다양성 지수(0~1). 1에 가까울수록 업종이 고르게 섞임.
function diversityIndex(countMap) {
  const counts = Object.values(countMap).filter((n) => n > 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0 || counts.length <= 1) return 0;
  let h = 0;
  for (const n of counts) { const p = n / total; h -= p * Math.log(p); }
  return Math.round((h / Math.log(counts.length)) * 100) / 100;
}

// 집계 결과 → 동네 분위기(vibe) 자동 라벨링 (룰베이스)
//  ※ 상가정보엔 B2B 사무실(과학·기술/시설관리·임대 등)이 다수 섞여 소비상권 분위기를 가린다.
//    그래서 (1) 소비업종 베이스 대비 비율로 보고, (2) 오피스 비중은 별도 신호로 잡는다.
function deriveVibe(stat) {
  const { density, derived, diversity, byLcls } = stat;
  const tags = [];

  // 1) 밀집도 티어 (전체 점포 밀도/㎢ 기준)
  if (density >= 3000) tags.push('초밀집 번화가');
  else if (density >= 1200) tags.push('활발한 상권');
  else if (density >= 400) tags.push('보통 생활상권');
  else tags.push('한산한 동네');

  // 2) 오피스(업무) 비중 — 대분류 기준. 강남·여의도형 신호.
  const lclsTotal = (byLcls || []).reduce((s, x) => s + x.count, 0) || 1;
  const officeCnt = (byLcls || []).filter((x) => /과학·기술|시설관리·임대/.test(x.name))
    .reduce((s, x) => s + x.count, 0);
  if (officeCnt / lclsTotal >= 0.22) tags.push('오피스 상권');

  // 3) 소비업종 베이스(오피스/B2B 제외) 대비 비율
  const cb = (derived.restaurant + derived.cafe + derived.bar + derived.convenience +
              derived.beauty + derived.medical + derived.education + derived.fashion + derived.leisure) || 1;
  const r = (k) => derived[k] / cb;
  const sig = [];
  if (r('restaurant') >= 0.32) sig.push(['먹자상권', r('restaurant')]);
  if (r('cafe') >= 0.10) sig.push(['카페 밀집', r('cafe')]);
  if (r('bar') >= 0.08) sig.push(['야간·유흥 활성', r('bar')]);
  if (r('beauty') >= 0.12) sig.push(['뷰티 상권', r('beauty')]);
  if (r('education') >= 0.16) sig.push(['학원가', r('education')]);
  if (r('medical') >= 0.12) sig.push(['의료 밀집', r('medical')]);
  if (r('leisure') >= 0.10) sig.push(['놀거리 많은', r('leisure')]);
  if (r('convenience') >= 0.16) sig.push(['생활편의 충분', r('convenience')]);
  sig.sort((a, b) => b[1] - a[1]).forEach(([t]) => tags.push(t));

  if (diversity >= 0.88) tags.push('업종 다양');

  // 한 줄 요약: 가장 특징적인 3개 태그
  const headline = tags.slice(0, 3).join(' · ');
  return { headline, tags };
}

/* ===== 브랜드 매핑 · 5대 생활밀착 지표 (상호명 bizesNm 기반) =====
   프랜차이즈(스타벅스·다이소 등)는 본사 직영/엄격한 출점심사라 '검증된 배후수요'의 대리지표다.
   ※ 한계: 영업시간(24시간·맥딜DT)·공원/하천 근접(숲세권)은 이 API에 없어 반영하지 못한다.
            상호명 글자 매칭이라 표본(받은 페이지) 밖 점포는 누락될 수 있다(brandsPartial로 표시). */
function distM(lat1, lng1, lat2, lng2) {   // 중심점↔점포 직선거리(m, 하버사인)
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

// 배지·근거로 쓸 프랜차이즈 (상호명 정규식)
const BRANDS = {
  starbucks:     { label: '스타벅스',     re: /스타벅스|starbucks/i },
  oliveyoung:    { label: '올리브영',     re: /올리브영|olive\s*young/i },
  daiso:         { label: '다이소',       re: /다이소|daiso/i },
  mcdonalds:     { label: '맥도날드',     re: /맥도날드|맥도널드|mcdonald/i },
  baskinrobbins: { label: '배스킨라빈스', re: /배스킨라빈스|베스킨라빈스|baskin/i },
  parisbaguette: { label: '파리바게뜨',   re: /파리바게[뜨트]|paris\s*baguette/i },
  yupdduk:       { label: '엽기떡볶이',   re: /엽기떡볶이|동대문엽기/ },
  malatang:      { label: '마라탕',       re: /마라탕|마라샹궈/ },
  photobooth:    { label: '셀프사진관',   re: /인생네컷|포토이즘|포토그레이|하루필름|셀픽스|무인사진|즉석사진/i },
};

// 업종/상호명 텍스트로 잡는 세부 카테고리 (밀도 지표용)
const FINE = {
  pediatric:  /소아과|소아청소년|아동병원/,
  animalHosp: /동물병원|동물메디컬|동물의료|반려동물|애견|애완/,
  fitness:    /필라테스|요가|헬스|피트니스|크로스핏/i,
  academy:    /학원|교습|보습|입시/,
  convStore:  /편의점/,
};

// 집계 → 5대 생활지표 점수(0~100)·근거·배지. 룰베이스 추정(deriveVibe와 동일 철학).
function buildLifestyle(brands, fine, derived) {
  const has = (k) => brands[k].present;
  const cap = (n, m) => Math.min(m, n);
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  const level = (s) => (s >= 65 ? '강함' : s >= 35 ? '보통' : '약함');
  const cb = (derived.restaurant + derived.cafe + derived.bar + derived.convenience +
             derived.beauty + derived.medical + derived.education + derived.fashion + derived.leisure) || 1;
  const barR = derived.bar / cb, cafeR = derived.cafe / cb, eduR = derived.education / cb;

  // ① 2030 싱글·활력 (엽떡·올영·마라탕·사진관 + 야간/카페 비중)
  let s1 = 0; const e1 = [];
  if (has('yupdduk'))    { s1 += 20; e1.push('엽기떡볶이'); }
  if (has('malatang'))   { s1 += 12; e1.push('마라탕'); }
  if (has('oliveyoung')) { s1 += 18; e1.push('올리브영'); }
  if (has('photobooth')) { s1 += 20; e1.push('셀프사진관'); }
  s1 += cap(barR * 300, 20); if (barR >= 0.08) e1.push('야간·유흥 활발');
  s1 += cap(cafeR * 120, 10);

  // ② 스세권·검증된 인프라 (스타벅스 직영 출점 = 배후수요 검증)
  let s2 = 0; const e2 = [];
  if (has('starbucks'))  { s2 += 35; if (brands.starbucks.count >= 2) s2 += 10; e2.push(`스타벅스${brands.starbucks.count > 1 ? ` ${brands.starbucks.count}곳` : ''}`); }
  if (has('daiso'))      { s2 += 20; e2.push('다이소'); }
  if (has('oliveyoung')) { s2 += 15; e2.push('올리브영'); }
  s2 += cap(fine.convStore * 3, 20);

  // ③ 초품아·항아리(가족 주거지). 유흥 비중은 감점.
  let s3 = 0; const e3 = [];
  if (has('baskinrobbins')) { s3 += 22; e3.push('배스킨라빈스'); }
  if (has('parisbaguette')) { s3 += 22; e3.push('파리바게뜨'); }
  if (fine.pediatric > 0)   { s3 += cap(fine.pediatric * 12, 24); e3.push(`소아과 ${fine.pediatric}곳`); }
  if (fine.academy > 0)     { s3 += cap(eduR * 120, 20); if (eduR >= 0.16) e3.push('학원가'); }
  s3 -= cap(barR * 200, 20);

  // ④ 맥세권·편세권 (편의 인프라)
  let s4 = 0; const e4 = [];
  if (has('mcdonalds'))   { s4 += 25; e4.push('맥도날드'); }
  if (has('daiso'))       { s4 += 15; e4.push('다이소'); }
  if (fine.convStore > 0) { s4 += cap(fine.convStore * 4, 40); e4.push(`편의점 ${fine.convStore}곳`); }

  // ⑤ 펫세권·여가
  let s5 = 0; const e5 = [];
  if (fine.animalHosp > 0) { s5 += cap(fine.animalHosp * 14, 42); e5.push(`동물병원·반려 ${fine.animalHosp}곳`); }
  if (fine.fitness > 0)    { s5 += cap(fine.fitness * 10, 30); e5.push(`필라테스·헬스 ${fine.fitness}곳`); }
  s5 += cap(cafeR * 120, 15);

  const idx = (label, s, ev) => { const c = clamp(s); return { label, score: c, level: level(c), evidence: ev }; };

  // 배지: 조건 충족한 것만 (한눈에 보이는 '도장')
  const badges = [];
  if (has('starbucks'))  badges.push('스세권');
  if (has('daiso'))      badges.push('다세권');
  if (has('mcdonalds'))  badges.push('맥세권');
  if (has('oliveyoung')) badges.push('올세권');
  if (fine.animalHosp >= 2) badges.push('펫세권');
  if (has('photobooth')) badges.push('인생네컷존');
  if (fine.fitness >= 2) badges.push('헬스·필라');
  if (((has('baskinrobbins') ? 1 : 0) + (has('parisbaguette') ? 1 : 0) + (fine.pediatric > 0 ? 1 : 0)) >= 2) badges.push('항아리상권');

  return {
    badges,
    lifestyle: {
      single2030:  idx('2030 싱글·활력', s1, e1),
      infra:       idx('스세권·검증 인프라', s2, e2),
      family:      idx('초품아·항아리', s3, e3),
      convenience: idx('맥세권·편세권', s4, e4),
      pet:         idx('펫세권·여가', s5, e5),
    },
  };
}

module.exports = async function handler(req, res) {
  try {
    const serviceKey = process.env.SBIZ_API_KEY || process.env.MOLIT_API_KEY;
    if (!serviceKey) {
      res.status(500).json({
        error: '상가정보 API 키(SBIZ_API_KEY)가 설정되지 않았습니다.',
        hint: 'data.go.kr에서 "소상공인시장진흥공단_상가(상권)정보 API"를 활용신청한 뒤, 일반 인증키(Decoding)를 Vercel 환경변수 SBIZ_API_KEY로 등록하세요. (기존 MOLIT 키와 같은 계정으로 신청했다면 자동 폴백됩니다.)',
      });
      return;
    }

    const q = req.query || {};
    const lng = Number(q.lng ?? q.cx);
    const lat = Number(q.lat ?? q.cy);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      res.status(400).json({ error: 'lng(경도)·lat(위도)가 필요합니다. 카카오 지오코더로 주소를 좌표로 변환해 넘겨주세요.' });
      return;
    }
    const radius = Math.min(Math.max(Number(q.radius) || 500, 50), 2000);
    // 페이지 상한: 소상공인 API는 결과를 경도순으로 정렬해 주므로, 앞 N페이지만 받으면
    //   서쪽 점포만 잡혀 지도가 한쪽에 쏠린다. 반경 전체를 덮도록 넉넉히 받는다(상한 PAGE_CAP).
    const pageCap = Math.min(Math.max(Number(q.pages) || PAGE_CAP, 1), 12);

    // 1페이지 호출 → totalCount로 추가 페이지 수 결정 (타임아웃 시 1회 재시도)
    const first = await withRetry(() => fetchRadiusPage(serviceKey, lng, lat, radius, 1));
    if (first.error) {
      const forbidden = /forbidden|미등록|승인|권한|service key/i.test(first.error);
      res.status(502).json({
        error: `상가정보 조회 실패: ${first.error}`,
        hint: forbidden
          ? '이 키로 "상가(상권)정보 API" 활용신청 승인이 안 됐을 수 있습니다. data.go.kr 마이페이지에서 승인 상태를 확인하세요(승인 후 수분~1시간 소요).'
          : undefined,
        code: first.code || null,
      });
      return;
    }

    let items = first.items.slice();
    const totalCount = first.totalCount;
    const totalPages = Math.max(1, Math.ceil(totalCount / ROWS_PER_PAGE) || 1);
    // 받을 페이지 선택: 전체가 상한 이하면 전부(매끄러운 전구간), 초과하면 1~끝을 균등 분산
    //   (정렬이 경도순이라 분산해서 받으면 동·서를 고루 포함)
    const pageNos = pickPages(totalPages, pageCap);
    const restPages = pageNos.filter((p) => p !== 1);
    if (restPages.length) {
      const rest = await mapLimit(
        restPages, 6,
        (p) => withRetry(() => fetchRadiusPage(serviceKey, lng, lat, radius, p)).catch(() => ({ items: [] })),
      );
      rest.forEach((r) => { if (r && r.items) items = items.concat(r.items); });
    }

    // ===== 집계 =====
    const byLcls = {};   // 대분류명 → 건수
    const byMcls = {};   // 중분류명 → 건수
    const derived = { cafe: 0, bar: 0, restaurant: 0, convenience: 0, medical: 0, education: 0, beauty: 0, fashion: 0, living: 0, leisure: 0 };
    const allMarkers = [];
    const brandHits = {};   // 브랜드키 → {count, nearestM}
    const fine = { pediatric: 0, animalHosp: 0, fitness: 0, academy: 0, convStore: 0 };

    for (const it of items) {
      const lcls = (it.indsLclsNm || '기타').trim();
      const mcls = (it.indsMclsNm || '').trim();
      const scls = (it.indsSclsNm || '').trim();
      const name = (it.bizesNm || '').trim();
      byLcls[lcls] = (byLcls[lcls] || 0) + 1;
      if (mcls) byMcls[mcls] = (byMcls[mcls] || 0) + 1;
      for (const tag of tagOf(mcls, scls)) derived[tag] += 1;

      // 세부 카테고리(업종+상호명)·브랜드(상호명) 탐지
      const hay = `${mcls} ${scls} ${name}`;
      for (const k in FINE) if (FINE[k].test(hay)) fine[k] += 1;

      const mlng = Number(it.lon), mlat = Number(it.lat);
      for (const k in BRANDS) {
        if (BRANDS[k].re.test(name)) {
          const h = brandHits[k] || (brandHits[k] = { count: 0, nearestM: Infinity });
          h.count += 1;
          if (Number.isFinite(mlng) && Number.isFinite(mlat)) {
            const dm = distM(lat, lng, mlat, mlng);
            if (dm < h.nearestM) h.nearestM = dm;
          }
        }
      }

      if (Number.isFinite(mlng) && Number.isFinite(mlat)) {
        allMarkers.push({ name, lcls, mcls, lng: mlng, lat: mlat });
      }
    }

    // 마커는 전체 표본에서 '균등 샘플링'으로 600개 추림 — 앞 600개만 쓰면 정렬 탓에 한쪽에 쏠린다.
    let markers = allMarkers;
    if (allMarkers.length > MARKER_CAP) {
      const stride = allMarkers.length / MARKER_CAP;
      markers = Array.from({ length: MARKER_CAP }, (_, i) => allMarkers[Math.floor(i * stride)]);
    }

    const collected = items.length;
    const areaKm2 = Math.PI * Math.pow(radius / 1000, 2);
    const density = areaKm2 > 0 ? Math.round(totalCount / areaKm2) : 0;   // ㎢당 점포수(전체기준)
    const diversity = diversityIndex(byLcls);

    const sortDesc = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    const lclsArr = sortDesc(byLcls);

    const stat = { total: totalCount, collected, density, diversity, derived, byLcls: lclsArr };
    const vibe = deriveVibe(stat);

    // 브랜드 요약 + 5대 생활지표·배지
    const brands = {};
    for (const k in BRANDS) {
      const h = brandHits[k];
      brands[k] = { label: BRANDS[k].label, present: !!h, count: h ? h.count : 0,
        nearestM: h && Number.isFinite(h.nearestM) ? h.nearestM : null };
    }
    const { badges, lifestyle } = buildLifestyle(brands, fine, derived);

    // CDN 캐싱: 상가정보는 분기 단위 갱신이라 변동이 느리다. 6시간 신선 + 1일 stale-while-revalidate.
    //   캐시 키=좌표+반경이라 같은 장소 재조회는 즉시 응답되고 소상공인 API 부하도 0.
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({
      query: { lng, lat, radius },
      total: totalCount,           // 반경 내 전체 점포(원천 totalCount)
      analyzed: collected,         // 실제 집계에 사용한 표본(최대 pages*1000)
      partial: collected < totalCount,
      density,                     // 점포/㎢
      diversity,                   // 업종 다양성 0~1
      vibe,                        // { headline, tags }
      badges,                      // 충족된 생활배지 ['스세권','펫세권', ...]
      lifestyle,                   // 5대 생활지표 {single2030, infra, family, convenience, pet} 각 {score,level,evidence}
      brands,                      // 브랜드별 {present,count,nearestM(직선 m)}
      fine,                        // 세부 카테고리 카운트 {pediatric,animalHosp,fitness,academy,convStore}
      brandsPartial: collected < totalCount,  // true면 표본 밖 점포 누락 가능(브랜드 '없음'이 불완전할 수 있음)
      byLcls: lclsArr,             // 대분류 구성 [{name,count}]
      byMcls: sortDesc(byMcls).slice(0, 12),  // 중분류 상위 12
      derived,                     // 카페/술집/음식점/편의/의료/학원 등 파생 카운트
      markers,                     // 지도용 좌표(최대 600)
      disclaimer: '소상공인시장진흥공단 상가(상권)정보 기준이며 분기 단위로 갱신됩니다. 신규/폐업 반영에 시차가 있고, 업종·상호명 키워드로 분류·매칭해 일부 오분류·누락이 있을 수 있습니다. 생활지표/배지는 프랜차이즈 입점을 배후수요의 대리지표로 본 룰베이스 추정이며, 영업시간(24시간·DT)·공원 근접은 데이터에 없어 반영되지 않습니다. 밀도·분위기는 표본 기반 추정입니다.',
    });
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    res.status(aborted ? 504 : 502).json({
      error: aborted ? '상가정보 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해주세요.' : '상가정보 조회 실패',
      detail: e.message,
    });
  }
};
