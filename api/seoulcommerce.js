/**
 * 영끌컷 · 서울 상권분석 오버레이 (V2) — 서버리스 엔드포인트
 * =====================================================
 * 서울 열린데이터광장 "우리마을가게 상권분석서비스(행정동)" OpenAPI로
 * 행정동 단위 추정매출·점포(개폐업)·유동인구를 조회해 V1 결과 아래 오버레이한다. 서울 전용.
 *
 * ⚠️ 핵심 제약(라이브 진단으로 확정):
 *   이 서비스들은 분기(STDR_YYQU_CD)로만 필터되고 행정동코드/명으로는 필터되지 않는다.
 *   → 요청마다 분기 전체(매출 1.6만행·점포 3.5만행)를 끌어오는 건 비현실적.
 *   → '분기 전체를 한 번 모아 행정동별로 집계한 정적 스냅샷(seoul_dong.json)'을 만들어
 *     런타임은 그 파일을 코드로 즉시 조회한다. 분기 갱신 시 ?build=1 로 재생성.
 *
 * 환경변수: SEOUL_API_KEY  (data.seoul.go.kr 인증키)
 * 서비스명: VwsmAdstrdSelngW(매출)·VwsmAdstrdStorW(점포)·VwsmAdstrdFlpopW(유동인구)
 * 행정동코드: ADSTRD_CD 8자리 = 카카오 coord2RegionCode H코드(10자리) 앞 8자리.
 *
 * 호출:
 *   /api/seoulcommerce?code=1150060400&gu=강서구&dong=가양2동   (런타임 조회: 정적 스냅샷)
 *   /api/seoulcommerce?build=1                                  (관리자: 최신분기 스냅샷 JSON 생성→커밋용)
 *   /api/seoulcommerce?build=1&q=20261                          (분기 지정 생성)
 */

const fs = require('fs');
const path = require('path');

const SEOUL_BASE = 'http://openapi.seoul.go.kr:8088';
const SVC = { SELNG: 'VwsmAdstrdSelngW', STOR: 'VwsmAdstrdStorW', FLPOP: 'VwsmAdstrdFlpopW' };
const SNAPSHOT = path.join(__dirname, 'seoul_dong.json');

const config = { maxDuration: 60 };
module.exports.config = config;

async function timedFetch(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function callSeoul(key, svc, args, ms = 9000) {
  const url = `${SEOUL_BASE}/${key}/json/${svc}/${args.join('/')}`;
  const res = await timedFetch(url, ms);
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { svc, code: 'PARSE_ERR', rows: [], total: null }; }
  const node = j[svc] || j;
  const result = node.RESULT || j.RESULT || {};
  return { svc, code: result.CODE || null, message: result.MESSAGE || null,
           total: node.list_total_count != null ? node.list_total_count : null,
           rows: Array.isArray(node.row) ? node.row : [] };
}

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx], idx); }
  }));
  return ret;
}

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };

const QUARTERS = ['20261', '20254', '20253', '20252', '20251', '20244', '20243'];
const TMZON = [['00_06', '심야(0-6시)'], ['06_11', '오전(6-11시)'], ['11_14', '점심(11-14시)'],
               ['14_17', '오후(14-17시)'], ['17_21', '저녁(17-21시)'], ['21_24', '밤(21-24시)']];
const AGES = [['10', '10대'], ['20', '20대'], ['30', '30대'], ['40', '40대'], ['50', '50대'], ['60_ABOVE', '60대+']];

function peakLabel(pairs) {
  let best = null;
  for (const [label, val] of pairs) if (best === null || val > best[1]) best = [label, val];
  return best ? best[0] : null;
}

// 한 서비스의 한 분기 전체 페이지를 끌어와 row를 모두 반환
async function fetchAllQuarter(key, svc, quarter) {
  const first = await callSeoul(key, svc, ['1', '1000', quarter]);
  if (first.code !== 'INFO-000') return { rows: [], total: first.total || 0, code: first.code };
  const total = first.total || first.rows.length;
  let rows = first.rows.slice();
  const pages = Math.ceil(total / 1000);
  if (pages > 1) {
    const ranges = [];
    for (let p = 2; p <= pages; p++) ranges.push([(p - 1) * 1000 + 1, p * 1000]);
    const more = await mapLimit(ranges, 6, ([s, e]) =>
      callSeoul(key, svc, [String(s), String(e), quarter]).then((r) => r.rows).catch(() => []));
    more.forEach((rs) => { rows = rows.concat(rs); });
  }
  return { rows, total };
}

// 분기 전체 → 행정동별 집계 스냅샷
async function buildSnapshot(key, quarter) {
  const [selng, stor, flpop] = await Promise.all([
    fetchAllQuarter(key, SVC.SELNG, quarter),
    fetchAllQuarter(key, SVC.STOR, quarter),
    fetchAllQuarter(key, SVC.FLPOP, quarter),
  ]);

  const dongs = {};
  const ensure = (cd, nm) => (dongs[cd] || (dongs[cd] = { nm, s: null, st: null, f: null }));

  // 매출 합산 (일부 서비스는 분기 필터가 안 먹어 전 분기가 섞여오므로, 대상 분기 행만)
  for (const r of selng.rows) {
    if (String(r.STDR_YYQU_CD) !== quarter) continue;
    const cd = String(r.ADSTRD_CD); if (cd.length < 8) continue;
    const d = ensure(cd, r.ADSTRD_CD_NM);
    const s = d.s || (d.s = { amt: 0, cnt: 0, mdwk: 0, wkend: 0, ml: 0, fml: 0,
      age: Object.fromEntries(AGES.map(([k]) => [k, 0])), tz: Object.fromEntries(TMZON.map(([k]) => [k, 0])), ind: 0 });
    s.amt += num(r.THSMON_SELNG_AMT); s.cnt += num(r.THSMON_SELNG_CO);
    s.mdwk += num(r.MDWK_SELNG_AMT); s.wkend += num(r.WKEND_SELNG_AMT);
    s.ml += num(r.ML_SELNG_AMT); s.fml += num(r.FML_SELNG_AMT); s.ind += 1;
    for (const [k] of AGES) s.age[k] += num(r[`AGRDE_${k}_SELNG_AMT`]);
    for (const [k] of TMZON) s.tz[k] += num(r[`TMZON_${k}_SELNG_AMT`]);
  }
  // 점포 합산
  for (const r of stor.rows) {
    if (String(r.STDR_YYQU_CD) !== quarter) continue;
    const cd = String(r.ADSTRD_CD); if (cd.length < 8) continue;
    const d = ensure(cd, r.ADSTRD_CD_NM);
    const st = d.st || (d.st = { total: 0, op: 0, cl: 0, frc: 0 });
    st.total += num(r.STOR_CO); st.op += num(r.OPBIZ_STOR_CO); st.cl += num(r.CLSBIZ_STOR_CO); st.frc += num(r.FRC_STOR_CO);
  }
  // 유동인구(행정동 1행) — FLPOP은 분기 필터가 안 먹어 전 분기가 섞여옴.
  //   대상 분기가 있으면 그것만, 없으면 FLPOP에 존재하는 최신 분기로 폴백.
  const flpopQuarters = new Set(flpop.rows.map((r) => String(r.STDR_YYQU_CD)));
  const flpopQ = flpopQuarters.has(quarter) ? quarter
    : [...flpopQuarters].sort().reverse()[0];
  for (const r of flpop.rows) {
    if (String(r.STDR_YYQU_CD) !== flpopQ) continue;
    const cd = String(r.ADSTRD_CD); if (cd.length < 8) continue;
    const d = ensure(cd, r.ADSTRD_CD_NM);
    d.f = { tot: num(r.TOT_FLPOP_CO), ml: num(r.ML_FLPOP_CO), fml: num(r.FML_FLPOP_CO),
      age: Object.fromEntries(AGES.map(([k]) => [k, num(r[`AGRDE_${k}_FLPOP_CO`])])),
      tz: Object.fromEntries(TMZON.map(([k]) => [k, num(r[`TMZON_${k}_FLPOP_CO`])])) };
  }

  const footDongs = Object.values(dongs).filter((d) => d.f).length;
  return { quarter, footQuarter: flpopQ, generatedAt: null,
    counts: { selng: selng.rows.length, stor: stor.rows.length, flpop: flpop.rows.length, dongs: Object.keys(dongs).length, footDongs }, dongs };
}

// 집계 dong 레코드 → 응답 형태로 변환
function shapeDong(d) {
  const out = {};
  if (d.s) {
    const s = d.s;
    out.sales = {
      monthlyAmt: s.amt, monthlyCnt: s.cnt, weekdayAmt: s.mdwk, weekendAmt: s.wkend, male: s.ml, female: s.fml,
      topAge: peakLabel(AGES.map(([k, l]) => [l, s.age[k]])),
      topTime: peakLabel(TMZON.map(([k, l]) => [l, s.tz[k]])),
      byAge: AGES.map(([k, l]) => ({ label: l, amt: s.age[k] })),
      byTime: TMZON.map(([k, l]) => ({ label: l, amt: s.tz[k] })),
      induties: s.ind,
    };
  }
  if (d.st) {
    const st = d.st;
    out.store = { total: st.total, opened: st.op, closed: st.cl, franchise: st.frc,
      openRate: st.total ? Math.round((st.op / st.total) * 1000) / 10 : null,
      closeRate: st.total ? Math.round((st.cl / st.total) * 1000) / 10 : null,
      franchiseRate: st.total ? Math.round((st.frc / st.total) * 1000) / 10 : null };
  }
  if (d.f) {
    const f = d.f;
    out.foot = { total: f.tot, male: f.ml, female: f.fml,
      topAge: peakLabel(AGES.map(([k, l]) => [l, f.age[k]])),
      topTime: peakLabel(TMZON.map(([k, l]) => [l, f.tz[k]])),
      byTime: TMZON.map(([k, l]) => ({ label: l, co: f.tz[k] })) };
  }
  return out;
}

module.exports = async function handler(req, res) {
  try {
    const qy = req.query || {};
    const key = process.env.SEOUL_API_KEY;

    // ---- 관리자: 스냅샷 생성 (커밋용 JSON 출력) ----
    if (qy.build) {
      if (!key) { res.status(500).json({ error: 'SEOUL_API_KEY 없음' }); return; }
      let quarter = qy.q;
      if (!quarter) {
        for (const q of QUARTERS) {
          const r = await callSeoul(key, SVC.FLPOP, ['1', '1', q], 6000).catch(() => null);
          if (r && r.code === 'INFO-000' && r.rows.length) { quarter = q; break; }
        }
      }
      if (!quarter) { res.status(502).json({ error: '최신 분기를 찾지 못함' }); return; }
      const snap = await buildSnapshot(key, quarter);
      res.status(200).json(snap);   // 이 출력을 api/seoul_dong.json 으로 저장·커밋
      return;
    }

    // ---- 런타임: 정적 스냅샷 조회 ----
    let snap;
    try { snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); }
    catch { res.status(503).json({ error: '서울 상권 스냅샷이 아직 생성되지 않았습니다. 관리자가 ?build=1 로 생성해야 합니다.' }); return; }

    const rawCode = String(qy.code || '').replace(/\D/g, '');
    if (rawCode.length < 8) { res.status(400).json({ error: 'code(카카오 행정동 코드)가 필요합니다.' }); return; }
    const code8 = rawCode.slice(0, 8);

    const d = snap.dongs[code8];
    if (!d) { res.status(404).json({ error: '이 행정동의 서울 상권 데이터가 없습니다(서울 외 지역이거나 미수록).', seoul: false }); return; }

    // CDN 캐싱: 정적 스냅샷(분기 갱신)을 조회만 하므로 강하게 캐싱. 1일 신선 + 1주 stale-while-revalidate.
    //   (관리자 build 경로는 위에서 먼저 return되어 캐시되지 않는다.)
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json({
      seoul: true,
      query: { code8, gu: qy.gu || null, dong: qy.dong || d.nm },
      dongName: d.nm,
      quarter: snap.quarter,
      quarterLabel: `${snap.quarter.slice(0, 4)}년 ${snap.quarter.slice(4)}분기`,
      ...shapeDong(d),
      disclaimer: '서울시 우리마을가게 상권분석서비스(행정동) 기준, 분기 갱신. 추정매출·점포는 행정동 내 전 업종 합산이며, 폐업률/개업률은 해당 분기 값입니다(3년 생존율과 다름).',
    });
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    res.status(aborted ? 504 : 502).json({ error: aborted ? '서울 상권 서버 응답 지연' : '서울 상권 처리 실패', detail: e.message });
  }
};
