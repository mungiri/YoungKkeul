/**
 * 영끌컷 · 서울 상권분석 오버레이 (V2) — 서버리스 엔드포인트
 * =====================================================
 * 서울 열린데이터광장 "우리마을가게 상권분석서비스(행정동 단위)" OpenAPI로
 * 특정 행정동의 추정매출·점포(개폐업)·유동인구를 조회해 V1 결과 아래 오버레이한다.
 *
 * 환경변수: SEOUL_API_KEY  (data.seoul.go.kr 인증키)
 *
 * 호출:
 *   /api/seoulcommerce?gu=마포구&dong=서교동&code=1144065000   (정식)
 *   /api/seoulcommerce?probe=1                                  (스키마 탐침: 서비스명/필드/분기/코드형식 진단)
 *
 * ⚠️ 서울 행정동 데이터셋의 정확한 서비스명·필드코드·행정동코드 형식이 문서로 확정 안 돼
 *    probe 모드로 라이브 스키마를 먼저 알아낸 뒤 정식 로직을 확정한다.
 */

const SEOUL_BASE = 'http://openapi.seoul.go.kr:8088';

const config = { maxDuration: 30 };
module.exports.config = config;

async function timedFetch(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// 서울 OpenAPI 호출 → JSON (서비스명 키 아래 list_total_count/RESULT/row)
//   path args는 순서대로 start/end/[필터...]
async function callSeoul(key, svc, args, ms = 8000) {
  const url = `${SEOUL_BASE}/${key}/json/${svc}/${args.join('/')}`;
  const res = await timedFetch(url, ms);
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { svc, error: 'JSON 파싱 실패', raw: text.slice(0, 200) }; }
  const node = j[svc] || j;
  const result = node.RESULT || j.RESULT || {};
  return {
    svc,
    code: result.CODE || null,
    message: result.MESSAGE || null,
    total: node.list_total_count != null ? node.list_total_count : null,
    rows: Array.isArray(node.row) ? node.row : [],
  };
}

// 후보 분기 코드(YYYYQ, 최신순) — 데이터 발행 시차 고려해 넉넉히
function candidateQuarters() {
  // 2026-06 기준 추정: 최신은 2025Q4~2026Q1 근방. 넓게 최신순으로 시도.
  return ['20261', '20254', '20253', '20252', '20251', '20244', '20243'];
}

/* ===================== PROBE: 라이브 스키마 탐침 ===================== */
async function probe(key) {
  const out = { step1_services: [], step2_quarter: null, step3_sampleByMetric: {}, notes: [] };

  // 후보 서비스명: 메트릭 × 접미사
  const metrics = {
    SELNG: ['VwsmAdstrdSelngW', 'VwsmAdstrdSelngQq', 'VwsmAdstrdSelng', 'VwsmTrdarSelngQq'],
    STOR:  ['VwsmAdstrdStorW', 'VwsmAdstrdStorQq', 'VwsmAdstrdStor', 'VwsmTrdarStorQq'],
    FLPOP: ['VwsmAdstrdFlpopW', 'VwsmAdstrdFlpopQq', 'VwsmAdstrdFlpop', 'VwsmTrdarFlpopQq'],
  };

  const working = {};   // metric → 첫 성공 서비스명
  for (const [metric, names] of Object.entries(metrics)) {
    for (const svc of names) {
      let r;
      try { r = await callSeoul(key, svc, ['1', '1']); }
      catch (e) { r = { svc, code: 'FETCH_ERR', message: e.message }; }
      out.step1_services.push({ metric, svc, code: r.code, message: r.message, total: r.total });
      // INFO-000 = 정상, INFO-200 = 데이터없음(서비스명은 맞음). 둘 다 "서비스 존재"로 본다.
      if (r.code === 'INFO-000' || r.code === 'INFO-200') { working[metric] = svc; break; }
    }
  }
  out.working = working;

  // 최신 분기 찾기 (SELNG 기준)
  if (working.SELNG) {
    for (const q of candidateQuarters()) {
      let r; try { r = await callSeoul(key, working.SELNG, ['1', '1', q]); } catch { continue; }
      if (r.code === 'INFO-000' && r.total > 0) { out.step2_quarter = { quarter: q, total: r.total }; break; }
    }
  }

  // 각 메트릭의 첫 행 키/샘플 (분기 필터로)
  const q = out.step2_quarter && out.step2_quarter.quarter;
  for (const [metric, svc] of Object.entries(working)) {
    try {
      const r = await callSeoul(key, svc, q ? ['1', '3', q] : ['1', '3']);
      const row0 = r.rows[0] || {};
      out.step3_sampleByMetric[metric] = {
        svc, total: r.total, keys: Object.keys(row0),
        sample: row0,
      };
    } catch (e) { out.step3_sampleByMetric[metric] = { svc, error: e.message }; }
  }

  return out;
}

module.exports = async function handler(req, res) {
  try {
    const key = process.env.SEOUL_API_KEY;
    if (!key) {
      res.status(500).json({
        error: 'SEOUL_API_KEY 환경변수가 설정되지 않았습니다.',
        hint: 'data.seoul.go.kr 인증키를 Vercel 환경변수 SEOUL_API_KEY로 등록하세요.',
      });
      return;
    }
    const qy = req.query || {};

    if (qy.probe) {
      const result = await probe(key);
      res.status(200).json(result);
      return;
    }

    // 정식 모드는 probe로 스키마 확정 후 구현 예정
    res.status(501).json({ error: '정식 모드 미구현 — 먼저 ?probe=1로 스키마를 확정하세요.' });
  } catch (e) {
    res.status(502).json({ error: '서울 상권 API 조회 실패', detail: e.message });
  }
};
