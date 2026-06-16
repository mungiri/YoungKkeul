/**
 * 영끌컷 · 재개발/재건축(정비사업) 구역 조회 서버리스 엔드포인트
 * =====================================================
 * 서울 열린데이터광장 "서울시 재개발·재건축 정비사업 현황"(OA-2253) OpenAPI를 호출해
 * 지도에 찍을 수 있는 정비사업 구역 목록 + 사업단계 분류를 반환한다.
 *
 * 아키텍처 원칙(기존 transactions.js와 동일):
 *   - API 키는 프론트 노출 금지 → Vercel 환경변수 SEOUL_API_KEY 로만 접근.
 *     (서울 열린데이터광장 키는 data.go.kr MOLIT 키와 별개로 발급)
 *   - 의존성 0. fetch + 수동 파싱.
 *   - 업스트림이 느려도 함수가 행에 걸리지 않도록 timedFetch.
 *
 * 환경변수:
 *   SEOUL_API_KEY = data.seoul.go.kr 에서 발급한 인증키
 *     (https://data.seoul.go.kr/together/guide/useGuide.do → 인증키 신청, 즉시 발급)
 *
 * 서울 열린데이터광장 OpenAPI 호출 규격:
 *   http://openapi.seoul.go.kr:8088/{KEY}/json/{SERVICE}/{START}/{END}/[조건...]
 *   성공코드: RESULT.CODE === 'INFO-000'
 *
 * ⚠️ OA-2253의 정확한 "서비스명"과 출력 필드명은 라이브 호출로 확정해야 한다.
 *    → service 쿼리파라미터로 서비스명을 바꿔가며 시도 가능(재배포 불필요).
 *    → probe=1 이면 원본 응답/첫 row의 키 목록을 그대로 반환(진단용).
 *
 * 호출 예:
 *   /api/redevelopment?probe=1                 (필드 진단: 첫 row 원본 키 확인)
 *   /api/redevelopment?gu=성동구               (자치구 필터)
 *   /api/redevelopment?service=OtherServiceNm  (서비스명 교체 시도)
 *
 * 쿼리 파라미터:
 *   gu       (선택) 서울 자치구 이름. 예: "성동구". 미지정 시 전체.
 *   stage    (선택) 단계 카테고리 필터: planned|ongoing|late|done
 *   service  (선택) Open API 서비스명 override. 기본 DEFAULT_SERVICE.
 *   start    (선택) 조회 시작 인덱스. 기본 1.
 *   end      (선택) 조회 종료 인덱스. 기본 1000(서울 API 단일호출 상한).
 *   probe    (선택) 1이면 진단 모드(원본 응답 키 노출).
 */

// OA-2253 서비스명 추정값. 라이브 확정 전까지 기본값으로 사용하며,
// 틀리면 service= 쿼리파라미터로 교체하거나 probe로 확인 후 여기를 고친다.
const DEFAULT_SERVICE = 'DefRedevelopmentArea'; // ← 라이브 확정 필요(임시 추정)

const SEOUL_BASE = 'http://openapi.seoul.go.kr:8088';

// 서울 25개 자치구(필터 검증용)
const SEOUL_GU = [
  '종로구','중구','용산구','성동구','광진구','동대문구','중랑구','성북구','강북구','도봉구',
  '노원구','은평구','서대문구','마포구','양천구','강서구','구로구','금천구','영등포구','동작구',
  '관악구','서초구','강남구','송파구','강동구',
];

const config = { maxDuration: 30 };
module.exports.config = config;

// 타임아웃 있는 fetch
async function timedFetch(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// 후보 키 목록 중 row에 실제 존재하는 첫 값을 꺼낸다(필드명 불확실성 흡수).
function pick(row, candidates) {
  for (const c of candidates) {
    if (row[c] != null && String(row[c]).trim() !== '') return String(row[c]).trim();
  }
  // 대소문자/공백 무시 매칭 fallback
  const norm = (s) => String(s).replace(/[\s_]/g, '').toLowerCase();
  const wanted = candidates.map(norm);
  for (const k of Object.keys(row)) {
    if (wanted.includes(norm(k)) && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return null;
}

// 사업단계 문자열 → 카테고리(예정/진행중/후기/완료). 키워드 기반.
function classifyStage(stageText) {
  const s = (stageText || '').replace(/\s/g, '');
  if (!s) return 'unknown';
  if (/(준공|해산|청산|완료)/.test(s)) return 'done';
  if (/(착공|관리처분|이주|철거)/.test(s)) return 'late';
  if (/(사업시행인가|조합설립|시공자선정|건축심의|사업시행)/.test(s)) return 'ongoing';
  if (/(예정구역|정비구역지정|기본계획|추진위|구역지정|후보지)/.test(s)) return 'planned';
  return 'ongoing'; // 분류 못 하면 진행중 취급
}

const STAGE_LABEL = {
  planned: '진행 예정', ongoing: '진행 중', late: '후기 단계', done: '완료', unknown: '미상',
};

// 서울 OpenAPI 응답 파싱 → { rows, totalCount, error, code, raw }
function parseSeoul(json, service) {
  const svc = json[service] || json[Object.keys(json).find((k) => json[k] && json[k].row)] || null;
  if (!svc) {
    // RESULT envelope만 온 경우(키 오류 등)
    const r = json.RESULT || {};
    return { error: r.MESSAGE || '예상치 못한 응답 구조', code: r.CODE || null, rows: [] };
  }
  const result = svc.RESULT || {};
  if (result.CODE && result.CODE !== 'INFO-000') {
    return { error: result.MESSAGE || 'Seoul API error', code: result.CODE, rows: [] };
  }
  const rows = Array.isArray(svc.row) ? svc.row : (svc.row ? [svc.row] : []);
  return { rows, totalCount: svc.list_total_count || rows.length };
}

module.exports = async function handler(req, res) {
  try {
    const serviceKey = process.env.SEOUL_API_KEY;
    if (!serviceKey) {
      res.status(500).json({
        error: 'SEOUL_API_KEY 환경변수가 설정되지 않았습니다.',
        hint: 'data.seoul.go.kr → 인증키 신청(즉시 발급) 후 Vercel 환경변수 SEOUL_API_KEY로 등록하세요. MOLIT(data.go.kr) 키와는 별개입니다.',
      });
      return;
    }

    const q = req.query || {};
    const service = q.service || DEFAULT_SERVICE;
    const start = Math.max(Number(q.start) || 1, 1);
    const end = Math.min(Number(q.end) || 1000, 1000);
    const probe = q.probe === '1' || q.probe === 'true';

    const url = `${SEOUL_BASE}/${serviceKey}/json/${service}/${start}/${end}/`;

    let json;
    try {
      const r = await timedFetch(url, 12000);
      const text = await r.text();
      try { json = JSON.parse(text); }
      catch {
        res.status(502).json({
          error: 'Seoul API JSON 파싱 실패(서비스명이 틀렸거나 점검 중일 수 있음)',
          serviceTried: service,
          preview: text.slice(0, 300),
        });
        return;
      }
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      res.status(504).json({
        error: aborted ? '서울 열린데이터광장 서버가 응답하지 않습니다. 잠시 후 재시도하세요.' : `호출 실패: ${e.message}`,
      });
      return;
    }

    const parsed = parseSeoul(json, service);

    // 진단 모드: 원본 첫 row의 키와 RESULT를 그대로 노출 → 실제 필드명 확정용
    if (probe) {
      const sampleRow = (parsed.rows && parsed.rows[0]) || null;
      res.status(200).json({
        probe: true,
        serviceTried: service,
        error: parsed.error || null,
        code: parsed.code || null,
        totalCount: parsed.totalCount || 0,
        rowKeys: sampleRow ? Object.keys(sampleRow) : [],
        sampleRow,
        topLevelKeys: Object.keys(json),
        hint: 'rowKeys를 보고 redevelopment.js의 pick() 후보 필드명과 DEFAULT_SERVICE를 확정하세요.',
      });
      return;
    }

    if (parsed.error) {
      res.status(502).json({ error: `서울 정비사업 조회 실패: ${parsed.error}`, code: parsed.code, serviceTried: service });
      return;
    }

    // row → 표준 구역 객체로 매핑(필드명 후보 다중 시도)
    const gu = q.gu && SEOUL_GU.includes(q.gu) ? q.gu : null;
    const stageFilter = ['planned', 'ongoing', 'late', 'done'].includes(q.stage) ? q.stage : null;

    let zones = parsed.rows.map((row) => {
      const stageText = pick(row, ['CGG_CODE_SE', '운영구분', '진행단계', '사업단계', 'STEP', 'STAGE', 'PROGRESS', '추진단계', '단계']);
      const stage = classifyStage(stageText);
      const latRaw = pick(row, ['LAT', 'LATITUDE', '위도', 'YCODE', 'Y']);
      const lngRaw = pick(row, ['LNG', 'LON', 'LONGITUDE', '경도', 'XCODE', 'X']);
      return {
        name: pick(row, ['사업장명', '구역명', 'AREA_NM', 'SECTOR_NM', 'BSNS_NM', 'PROJECT_NM', '정비구역명칭']),
        gu: pick(row, ['자치구', 'CGG_NM', 'GU_NM', 'SGG_NM', '자치구명']),
        dong: pick(row, ['법정동', '행정동', 'DONG', 'BJDONG_NM']),
        type: pick(row, ['사업구분', '정비사업구분', 'BSNS_SE', 'TYPE', '사업유형']),
        stageText: stageText,
        stage,
        stageLabel: STAGE_LABEL[stage],
        address: pick(row, ['주소', '위치', 'ADDR', 'LOCATION', '대표지번']),
        households: Number(pick(row, ['세대수', 'HSHLD_CNT', 'HOUSEHOLDS'])) || null,
        area: Number(pick(row, ['구역면적', 'AREA', 'TOTAR'])) || null,
        builder: pick(row, ['시공자', 'CONSTRUCTOR', '시공사']),
        lat: latRaw ? Number(latRaw) : null,
        lng: lngRaw ? Number(lngRaw) : null,
      };
    });

    if (gu) zones = zones.filter((z) => z.gu === gu);
    if (stageFilter) zones = zones.filter((z) => z.stage === stageFilter);

    // 단계별 집계
    const stageCounts = zones.reduce((acc, z) => { acc[z.stage] = (acc[z.stage] || 0) + 1; return acc; }, {});
    const hasCoords = zones.some((z) => z.lat && z.lng);

    res.status(200).json({
      query: { gu, stage: stageFilter, service },
      totalCount: parsed.totalCount,
      zoneCount: zones.length,
      stageCounts,
      hasCoords,            // false면 프론트에서 카카오 지오코딩(주소→좌표) 필요
      zones,
      disclaimer: '서울 열린데이터광장 정비사업 현황(원본: 정비사업 정보몽땅) 기준. 사업단계는 원본 텍스트를 키워드로 분류한 것으로 실제와 다를 수 있습니다.',
    });
  } catch (e) {
    res.status(502).json({ error: '재개발 구역 조회 실패', detail: e.message });
  }
};
