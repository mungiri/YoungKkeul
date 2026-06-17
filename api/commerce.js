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

    for (const it of items) {
      const lcls = (it.indsLclsNm || '기타').trim();
      const mcls = (it.indsMclsNm || '').trim();
      const scls = (it.indsSclsNm || '').trim();
      const name = (it.bizesNm || '').trim();
      byLcls[lcls] = (byLcls[lcls] || 0) + 1;
      if (mcls) byMcls[mcls] = (byMcls[mcls] || 0) + 1;
      for (const tag of tagOf(mcls, scls)) derived[tag] += 1;

      const mlng = Number(it.lon), mlat = Number(it.lat);
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
      byLcls: lclsArr,             // 대분류 구성 [{name,count}]
      byMcls: sortDesc(byMcls).slice(0, 12),  // 중분류 상위 12
      derived,                     // 카페/술집/음식점/편의/의료/학원 등 파생 카운트
      markers,                     // 지도용 좌표(최대 600)
      disclaimer: '소상공인시장진흥공단 상가(상권)정보 기준이며 분기 단위로 갱신됩니다. 신규/폐업 반영에 시차가 있고, 업종 명칭 키워드로 분류해 일부 오분류가 있을 수 있습니다. 밀도·분위기는 표본 기반 추정입니다.',
    });
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    res.status(aborted ? 504 : 502).json({
      error: aborted ? '상가정보 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해주세요.' : '상가정보 조회 실패',
      detail: e.message,
    });
  }
};
