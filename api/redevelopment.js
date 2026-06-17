/**
 * 영끌컷 · 재개발/재건축(정비사업) 구역 조회 서버리스 엔드포인트
 * =====================================================
 * 데이터 원천: 서울시 "정비사업 정보몽땅"(cleanup.seoul.go.kr) 사업장검색.
 *   - 당초 서울 열린데이터광장 OA-2253 OpenAPI를 쓰려 했으나 2025.12 폐기됨.
 *   - 정보몽땅의 사업장목록 AJAX 엔드포인트(lsubBsnsSttus.do)는 공개(무인증)이고
 *     자치구 코드별로 전체 구역 목록을 HTML 테이블로 돌려준다 → 파싱해서 사용.
 *
 * 아키텍처 원칙(기존 transactions.js와 동일):
 *   - 의존성 0. fetch + 정규식 파싱.
 *   - 업스트림 지연 대비 timedFetch + 동시호출 제한 mapLimit.
 *   - 인증키 불필요(정보몽땅 공개 데이터).
 *
 * ⚠️ 좌표(위/경도)는 원천에 없음 → 프론트에서 카카오 지오코딩(대표지번 주소→좌표)으로 보완.
 *
 * 엔드포인트(역설계):
 *   POST/GET https://cleanup.seoul.go.kr/cleanup/bsnssttus/lsubBsnsSttus.do
 *     scupBsnsSttus.signguCode = 자치구 법정동코드 5자리(예: 11200 성동구)
 *     pageSize = 500            (한 번에 전체 행 수신; 기본 10이라 반드시 지정)
 *   응답: HTML 조각. 행당 10셀 = 번호·자치구·사업구분·사업장명·대표지번·진행단계·공개자료수·공개적시성·자료충실도·이동
 *         '이동' 셀의 cafeOpenPopup('slug') → 상세 카페 URL 슬러그.
 *
 * 호출 예:
 *   /api/redevelopment?gu=성동구            (한 자치구)
 *   /api/redevelopment?gu=all               (서울 25개구 전체 — 느릴 수 있음)
 *   /api/redevelopment?gu=성동구&stage=late  (단계 필터)
 *   /api/redevelopment?gu=성동구&probe=1     (원본 HTML 진단)
 *
 * 쿼리 파라미터:
 *   gu     (필수) 서울 자치구 이름 또는 'all'. (또는 signguCode 5자리 직접 전달)
 *   stage  (선택) 단계 카테고리 필터: planned|ongoing|late|done
 *   probe  (선택) 1이면 원본 HTML 앞부분/행 수 진단.
 */

// 서울 25개 자치구 → 법정동코드 앞 5자리(transactions.js와 동일)
const SEOUL_LAWD = {
  '종로구': '11110', '중구': '11140', '용산구': '11170', '성동구': '11200',
  '광진구': '11215', '동대문구': '11230', '중랑구': '11260', '성북구': '11290',
  '강북구': '11305', '도봉구': '11320', '노원구': '11350', '은평구': '11380',
  '서대문구': '11410', '마포구': '11440', '양천구': '11470', '강서구': '11500',
  '구로구': '11530', '금천구': '11545', '영등포구': '11560', '동작구': '11590',
  '관악구': '11620', '서초구': '11650', '강남구': '11680', '송파구': '11710',
  '강동구': '11740',
};

const LIST_URL = 'https://cleanup.seoul.go.kr/cleanup/bsnssttus/lsubBsnsSttus.do';
const CAFE_URL = 'https://cleanup.seoul.go.kr/cafe/mainIndx.do?cafeUrl='; // + slug

const config = { maxDuration: 30 };
module.exports.config = config;

async function timedFetch(url, ms, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...(opts || {}), signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// 일시 오류(타임아웃/차단) 1회 재시도. 정보몽땅이 가끔 흔들려 한 구가 통째 누락되는 걸 줄인다.
async function withRetry(fn, retries = 1) {
  try { return await fn(); }
  catch (e) { if (retries > 0) return withRetry(fn, retries - 1); throw e; }
}

// 동시 실행 개수 제한 (전체 25개구 조회 시 폭주 방지)
async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return ret;
}

// 진행단계 텍스트 → 카테고리. 순서 중요(done/late를 ongoing보다 먼저 판정).
function classifyStage(s) {
  const t = (s || '').replace(/\s/g, '');
  if (!t) return 'unknown';
  if (/(준공|조합해산|조합청산|해산|청산|완료|이전고시)/.test(t)) return 'done';
  if (/(관리처분|이주|철거|착공)/.test(t)) return 'late';
  if (/(조합설립|사업시행|시공자|건축심의)/.test(t)) return 'ongoing';
  if (/(정비계획|정비구역지정|구역지정|기본계획|추진위|추진주체|후보지|예정구역)/.test(t)) return 'planned';
  return 'ongoing';
}

const STAGE_LABEL = {
  planned: '진행 예정', ongoing: '진행 중', late: '후기 단계(관리처분~착공)', done: '완료/청산', unknown: '미상',
};

// HTML 셀에서 텍스트만 추출(태그 제거·공백 정리)
function cellText(td) {
  return td.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// 정보몽땅 사업장목록 HTML 조각 → 구역 객체 배열
function parseZones(html) {
  const m = html.match(/<tbody[\s\S]*?<\/tbody>/);
  if (!m) return [];
  const rows = m[0].match(/<tr[\s\S]*?<\/tr>/g) || [];
  const zones = [];
  for (const r of rows) {
    const cells = r.match(/<td[\s\S]*?<\/td>/g) || [];
    if (cells.length < 6) continue; // "데이터 없음" 행 등 스킵
    const name = cellText(cells[3]);
    if (!name) continue;
    const stageText = cellText(cells[5]);
    const slugM = r.match(/cafeOpenPopup\('([^']+)'\)/);
    const stage = classifyStage(stageText);
    zones.push({
      gu: cellText(cells[1]),
      type: cellText(cells[2]),     // 사업구분(재개발/재건축/도시정비형 등)
      name,                          // 사업장명(구역명)
      address: cellText(cells[4]),   // 대표지번 → 카카오 지오코딩용
      stageText,                     // 원본 진행단계
      stage,                         // 분류 카테고리
      stageLabel: STAGE_LABEL[stage],
      cafeUrl: slugM ? slugM[1] : null,         // 카페 슬러그(위치도 리다이렉트용)
      detailUrl: slugM ? CAFE_URL + slugM[1] : null,
      lat: null, lng: null,          // 원천에 좌표 없음 → 프론트 지오코딩
    });
  }
  return zones;
}

// 한 자치구 조회
async function fetchGu(signguCode) {
  const res = await timedFetch(LIST_URL, 12000, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0',
    },
    body: `scupBsnsSttus.signguCode=${signguCode}&pageSize=500`,
  });
  return await res.text();
}

module.exports = async function handler(req, res) {
  try {
    const q = req.query || {};
    const stageFilter = ['planned', 'ongoing', 'late', 'done'].includes(q.stage) ? q.stage : null;
    const all = q.gu === 'all';

    // 대상 자치구 목록 결정
    let targets; // [{gu, code}]
    if (all) {
      targets = Object.entries(SEOUL_LAWD).map(([gu, code]) => ({ gu, code }));
    } else {
      const code = q.signguCode || SEOUL_LAWD[q.gu];
      if (!code) {
        res.status(400).json({
          error: "gu(서울 자치구 이름) 또는 'all', 또는 signguCode 5자리가 필요합니다.",
          available: Object.keys(SEOUL_LAWD),
        });
        return;
      }
      targets = [{ gu: q.gu || null, code }];
    }

    // 진단 모드: 첫 자치구 원본 HTML 앞부분 + 파싱 행 수
    if (q.probe === '1' || q.probe === 'true') {
      const html = await fetchGu(targets[0].code);
      const zones = parseZones(html);
      res.status(200).json({
        probe: true,
        guTried: targets[0],
        htmlBytes: html.length,
        parsedCount: zones.length,
        sample: zones.slice(0, 3),
        preview: html.slice(0, 400),
      });
      return;
    }

    // 조회(전체구는 동시 6개 제한)
    const htmls = await mapLimit(targets, all ? 6 : 1, async (t) => {
      try { return { gu: t.gu, code: t.code, html: await withRetry(() => fetchGu(t.code)) }; }
      catch (e) { return { gu: t.gu, code: t.code, error: e.name === 'AbortError' ? 'timeout' : e.message }; }
    });

    let zones = [];
    const failed = [];
    for (const h of htmls) {
      if (h.error) { failed.push({ gu: h.gu, code: h.code, error: h.error }); continue; }
      zones.push(...parseZones(h.html));
    }

    if (!zones.length && failed.length) {
      res.status(504).json({ error: '정비사업 정보몽땅 조회 실패(서버 무응답 또는 차단)', failed });
      return;
    }

    if (stageFilter) zones = zones.filter((z) => z.stage === stageFilter);

    // 단계별 집계
    const stageCounts = zones.reduce((acc, z) => { acc[z.stage] = (acc[z.stage] || 0) + 1; return acc; }, {});

    // CDN 캐싱: 정비사업 단계는 행정 절차라 갱신이 느리다. 6시간 신선 + 1일 stale-while-revalidate.
    //   캐시 키=gu+stage라 적중률이 높고, 정보몽땅이 막혀도 옛 데이터로 즉시 응답.
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({
      query: { gu: all ? 'all' : (q.gu || null), stage: stageFilter },
      zoneCount: zones.length,
      stageCounts,
      hasCoords: false,   // 항상 false: 프론트에서 address를 카카오 지오코딩해야 함
      failed: failed.length ? failed : undefined,
      zones,
      disclaimer: '서울시 정비사업 정보몽땅(cleanup.seoul.go.kr) 사업장검색 기준. 진행단계는 원본 텍스트를 키워드로 분류한 것으로 실제와 다를 수 있습니다. 좌표는 대표지번 주소를 지오코딩한 근사 위치입니다.',
    });
  } catch (e) {
    res.status(502).json({ error: '재개발 구역 조회 실패', detail: e.message });
  }
};
