/**
 * 영끌컷 · 서울 상권분석 오버레이 (V2) — 서버리스 엔드포인트
 * =====================================================
 * 서울 열린데이터광장 "우리마을가게 상권분석서비스(행정동 단위)" OpenAPI로
 * 특정 행정동의 추정매출·점포(개폐업)·유동인구를 조회해 V1 결과 아래 오버레이한다.
 * 서울 전용(행정동 데이터가 서울만 존재).
 *
 * 환경변수: SEOUL_API_KEY  (data.seoul.go.kr 인증키)
 *
 * 서비스명(라이브 probe로 확정):
 *   추정매출-행정동  VwsmAdstrdSelngW   (행정동 × 업종, 다행 → 합산)
 *   점포-행정동      VwsmAdstrdStorW    (행정동 × 업종, 다행 → 합산)
 *   길단위인구-행정동 VwsmAdstrdFlpopW   (행정동 1행)
 * 행정동코드: ADSTRD_CD = 8자리 = 카카오 coord2RegionCode H코드(10자리) 앞 8자리.
 *
 * 호출:
 *   /api/seoulcommerce?code=1150060400&gu=강서구&dong=가양2동
 *   /api/seoulcommerce?probe=1   (스키마 재진단용)
 */

const SEOUL_BASE = 'http://openapi.seoul.go.kr:8088';
const SVC = { SELNG: 'VwsmAdstrdSelngW', STOR: 'VwsmAdstrdStorW', FLPOP: 'VwsmAdstrdFlpopW' };

const config = { maxDuration: 30 };
module.exports.config = config;

async function timedFetch(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// 서울 OpenAPI 호출. path args = [start, end, ...filters]
async function callSeoul(key, svc, args, ms = 9000) {
  const url = `${SEOUL_BASE}/${key}/json/${svc}/${args.join('/')}`;
  const res = await timedFetch(url, ms);
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { svc, code: 'PARSE_ERR', rows: [], total: null, raw: text.slice(0, 160) }; }
  const node = j[svc] || j;
  const result = node.RESULT || j.RESULT || {};
  return { svc, code: result.CODE || null, message: result.MESSAGE || null,
           total: node.list_total_count != null ? node.list_total_count : null,
           rows: Array.isArray(node.row) ? node.row : [] };
}

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };

// 후보 분기(YYYYQ, 최신순). 발행 시차 고려.
const QUARTERS = ['20261', '20254', '20253', '20252', '20251', '20244', '20243'];

// FLPOP 기준으로 해당 행정동 데이터가 있는 최신 분기 찾기
async function latestQuarter(key, code8) {
  for (const q of QUARTERS) {
    const r = await callSeoul(key, SVC.FLPOP, ['1', '1', q, code8], 6000).catch(() => null);
    if (r && r.code === 'INFO-000' && r.rows.length) return q;
  }
  return null;
}

// 시간대 6구간 라벨
const TMZON = [
  ['00_06', '심야(0-6시)'], ['06_11', '오전(6-11시)'], ['11_14', '점심(11-14시)'],
  ['14_17', '오후(14-17시)'], ['17_21', '저녁(17-21시)'], ['21_24', '밤(21-24시)'],
];
const AGES = [['10', '10대'], ['20', '20대'], ['30', '30대'], ['40', '40대'], ['50', '50대'], ['60_ABOVE', '60대+']];

// 합계 객체에서 최대 항목 라벨 뽑기
function peakLabel(pairs) {
  let best = null;
  for (const [label, val] of pairs) if (best === null || val > best[1]) best = [label, val];
  return best ? best[0] : null;
}

module.exports = async function handler(req, res) {
  try {
    const key = process.env.SEOUL_API_KEY;
    if (!key) {
      res.status(500).json({ error: 'SEOUL_API_KEY 환경변수가 설정되지 않았습니다.',
        hint: 'data.seoul.go.kr 인증키를 Vercel 환경변수 SEOUL_API_KEY로 등록하세요.' });
      return;
    }
    const qy = req.query || {};

    // ---- probe 모드(진단) ----
    if (qy.probe) {
      const out = {};
      for (const [m, svc] of Object.entries(SVC)) {
        const r = await callSeoul(key, svc, ['1', '2']).catch((e) => ({ error: e.message }));
        out[m] = { svc, code: r.code, total: r.total, keys: Object.keys(r.rows && r.rows[0] || {}) };
      }
      res.status(200).json(out);
      return;
    }

    // ---- 필터순서 진단: ?probe=filter&code=11500604&q=20261&name=가양2동 ----
    if (qy.fprobe) {
      const code8 = String(qy.code || '11500604').replace(/\D/g, '').slice(0, 8);
      const q = qy.q || '20261';
      const name = qy.name || '가양2동';
      const variants = {
        'A_quarterOnly': [q],
        'B_quarter+code': [q, code8],
        'C_codeOnly': [code8],
        'D_quarter+name': [q, name],
        'E_nameOnly': [name],
      };
      const out = {};
      for (const [label, filt] of Object.entries(variants)) {
        try {
          const r = await callSeoul(key, SVC.SELNG, ['1', '5', ...filt]);
          out[label] = { args: filt, code: r.code, total: r.total, firstDong: r.rows[0] && r.rows[0].ADSTRD_CD_NM };
        } catch (e) { out[label] = { args: filt, error: e.message }; }
      }
      res.status(200).json({ tested: 'VwsmAdstrdSelngW', code8, q, name, results: out });
      return;
    }

    // ---- 정식 모드 ----
    const rawCode = String(qy.code || '').replace(/\D/g, '');
    if (rawCode.length < 8) {
      res.status(400).json({ error: 'code(카카오 행정동 코드)가 필요합니다.' });
      return;
    }
    const code8 = rawCode.slice(0, 8);
    const dong = qy.dong || null, gu = qy.gu || null;

    const quarter = qy.quarter || await latestQuarter(key, code8);
    if (!quarter) {
      res.status(404).json({ error: '이 행정동의 서울 상권 데이터를 찾지 못했습니다. (서울 외 지역이거나 데이터 미수록)', seoul: false });
      return;
    }

    // 3개 데이터셋 병렬 조회 (행정동 필터)
    const [selng, stor, flpop] = await Promise.all([
      callSeoul(key, SVC.SELNG, ['1', '1000', quarter, code8]),
      callSeoul(key, SVC.STOR, ['1', '1000', quarter, code8]),
      callSeoul(key, SVC.FLPOP, ['1', '5', quarter, code8]),
    ]);

    // ===== 추정매출(업종 합산) =====
    let sales = null;
    if (selng.rows.length) {
      const S = (k) => selng.rows.reduce((s, r) => s + num(r[k]), 0);
      const monthAmt = S('THSMON_SELNG_AMT');
      sales = {
        monthlyAmt: monthAmt,                        // 행정동 월 추정매출 합(원)
        monthlyCnt: S('THSMON_SELNG_CO'),
        weekdayAmt: S('MDWK_SELNG_AMT'),
        weekendAmt: S('WKEND_SELNG_AMT'),
        male: S('ML_SELNG_AMT'), female: S('FML_SELNG_AMT'),
        topAge: peakLabel(AGES.map(([k, l]) => [l, S(`AGRDE_${k}_SELNG_AMT`)])),
        topTime: peakLabel(TMZON.map(([k, l]) => [l, S(`TMZON_${k}_SELNG_AMT`)])),
        byAge: AGES.map(([k, l]) => ({ label: l, amt: S(`AGRDE_${k}_SELNG_AMT`) })),
        byTime: TMZON.map(([k, l]) => ({ label: l, amt: S(`TMZON_${k}_SELNG_AMT`) })),
        induties: selng.rows.length,
      };
    }

    // ===== 점포/개폐업(업종 합산) =====
    let store = null;
    if (stor.rows.length) {
      const totStor = stor.rows.reduce((s, r) => s + num(r.STOR_CO), 0);
      const opStor = stor.rows.reduce((s, r) => s + num(r.OPBIZ_STOR_CO), 0);
      const clStor = stor.rows.reduce((s, r) => s + num(r.CLSBIZ_STOR_CO), 0);
      const frcStor = stor.rows.reduce((s, r) => s + num(r.FRC_STOR_CO), 0);
      store = {
        total: totStor, opened: opStor, closed: clStor, franchise: frcStor,
        openRate: totStor ? Math.round((opStor / totStor) * 1000) / 10 : null,    // 개업률 %
        closeRate: totStor ? Math.round((clStor / totStor) * 1000) / 10 : null,   // 폐업률 %
        franchiseRate: totStor ? Math.round((frcStor / totStor) * 1000) / 10 : null,
      };
    }

    // ===== 유동인구(행정동 1행) =====
    let foot = null;
    const f = flpop.rows[0];
    if (f) {
      foot = {
        total: num(f.TOT_FLPOP_CO),
        male: num(f.ML_FLPOP_CO), female: num(f.FML_FLPOP_CO),
        topAge: peakLabel(AGES.map(([k, l]) => [l, num(f[`AGRDE_${k}_FLPOP_CO`])])),
        topTime: peakLabel(TMZON.map(([k, l]) => [l, num(f[`TMZON_${k}_FLPOP_CO`])])),
        byTime: TMZON.map(([k, l]) => ({ label: l, co: num(f[`TMZON_${k}_FLPOP_CO`]) })),
      };
    }

    if (!sales && !store && !foot) {
      res.status(404).json({ error: '이 행정동의 상권 데이터가 비어 있습니다.', seoul: true, quarter });
      return;
    }

    res.status(200).json({
      seoul: true,
      query: { code8, gu, dong, quarter },
      quarterLabel: `${quarter.slice(0, 4)}년 ${quarter.slice(4)}분기`,
      sales, store, foot,
      disclaimer: '서울시 우리마을가게 상권분석서비스(행정동) 기준, 분기 갱신. 추정매출·점포는 행정동 내 전 업종 합산이며, 폐업률/개업률은 해당 분기 값입니다(3년 생존율과 다름).',
    });
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    res.status(aborted ? 504 : 502).json({
      error: aborted ? '서울 상권 서버가 일시적으로 응답하지 않습니다.' : '서울 상권 API 조회 실패',
      detail: e.message });
  }
};
