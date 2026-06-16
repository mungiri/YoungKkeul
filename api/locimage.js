/**
 * 영끌컷 · 정비사업 "위치도" 리다이렉트 엔드포인트
 * =====================================================
 * 정보몽땅 카페의 [사업현황 > 위치도] 페이지로 바로 보내준다.
 *
 * 문제: 위치도 페이지는 내부 cafeId(예: 260900001418b49)+stepSeCode가 필요한데,
 *       우리가 가진 건 cafeUrl 슬러그(예: myeonmok6moa)뿐이다.
 * 해결: 카페 메인(mainIndx.do?cafeUrl=슬러그)을 한 번 읽어 위치도 링크를 추출,
 *       그 실제 URL로 302 리다이렉트한다. (위치도 없으면 카페 메인으로 폴백)
 *
 * 호출: /api/locimage?cafeUrl=myeonmok6moa
 */

const BASE = 'https://cleanup.seoul.go.kr';

const config = { maxDuration: 15 };
module.exports.config = config;

async function timedFetch(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } }); }
  finally { clearTimeout(t); }
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

module.exports = async function handler(req, res) {
  const slug = (req.query && req.query.cafeUrl) || '';
  const cafeMain = `${BASE}/cafe/mainIndx.do?cafeUrl=${encodeURIComponent(slug)}`;
  if (!slug) { res.status(400).json({ error: 'cafeUrl(슬러그)이 필요합니다.' }); return; }

  try {
    const html = await (await timedFetch(cafeMain, 10000)).text();
    // [사업현황 > 위치도] 메뉴의 href(div=locImage 포함)를 추출
    const m = html.match(/href="([^"]*div=locImage[^"]*)"/i);
    if (!m) { redirect(res, cafeMain); return; }   // 위치도 메뉴 없으면 카페 메인으로
    let path = m[1].replace(/&amp;/g, '&');
    redirect(res, path.startsWith('http') ? path : BASE + path);
  } catch (e) {
    redirect(res, cafeMain);   // 타임아웃/오류 시에도 최소한 카페 메인으로
  }
};
