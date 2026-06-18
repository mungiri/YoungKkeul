/**
 * 영끌컷 · 상권분석 AI 코멘트 엔드포인트
 * =====================================================
 * 프론트(/api/commerce 결과)가 보낸 상권 분석 요약을 받아,
 * Google AI Studio(Gemini) 무료 API로 "일반인이 이해하기 쉬운" 분석 코멘트를 생성한다.
 *
 * 왜 서버에서 호출하나:
 *   - API 키는 프론트에 노출 금지 → 서버리스 함수에서만 process.env로 접근.
 *   - commerce.js / seoulcommerce.js와 동일한 아키텍처 원칙(의존성 0, fetch + JSON).
 *
 * 환경변수:
 *   GEMINI_API_KEY = Google AI Studio(https://aistudio.google.com/apikey)에서 발급한 키.
 *   (선택) GEMINI_MODEL = 사용할 모델. 기본 'gemini-2.0-flash'(무료·한국어 양호·빠름).
 *
 * 호출:
 *   POST /api/ai-comment   body: { label, radius, total, density, diversity,
 *                                  vibe:{headline,tags}, derived:[{label,count,band,pct}],
 *                                  topCategories:[{name,count}], brands:[{label,present,dist}],
 *                                  seoul:{...}|null }
 *   응답: { comment: "...자연어 코멘트..." }
 */

const config = { maxDuration: 30 };
module.exports.config = config;

const DEFAULT_MODEL = 'gemini-2.0-flash';

// 타임아웃 있는 fetch (업스트림이 느려도 함수가 행에 안 걸리도록)
async function timedFetch(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// 분석 요약 → Gemini 프롬프트(한국어). 일반인 눈높이의 해석을 요구한다.
function buildPrompt(d) {
  const lines = [];
  const radiusTxt = d.radius >= 1000 ? `${(d.radius / 1000).toFixed(d.radius % 1000 ? 1 : 0)}km` : `${d.radius}m`;
  lines.push(`분석 위치: ${d.label || '미상'} (반경 ${radiusTxt})`);
  if (d.total != null) lines.push(`반경 내 점포 수: ${d.total.toLocaleString()}개, 점포 밀도: ${Number(d.density || 0).toLocaleString()}개/㎢, 업종 다양성: ${Math.round((d.diversity || 0) * 100)}%`);
  if (d.vibe && d.vibe.headline) lines.push(`자동 분위기 요약: ${d.vibe.headline}${(d.vibe.tags && d.vibe.tags.length) ? ` (${d.vibe.tags.join(', ')})` : ''}`);
  if (Array.isArray(d.derived) && d.derived.length) {
    lines.push('업종 비중(소비업종 대비): ' + d.derived.map(x => `${x.label} ${x.count}곳(${x.pct}%, ${x.band})`).join(' / '));
  }
  if (Array.isArray(d.topCategories) && d.topCategories.length) {
    lines.push('주요 업종 구성: ' + d.topCategories.map(x => `${x.name} ${x.count}개`).join(', '));
  }
  if (Array.isArray(d.brands) && d.brands.length) {
    const has = d.brands.filter(b => b.present).map(b => b.label);
    const no = d.brands.filter(b => !b.present).map(b => b.label);
    lines.push(`주변 생활 브랜드 — 있음: ${has.length ? has.join(', ') : '없음'} / 없음: ${no.length ? no.join(', ') : '없음'}`);
  }
  if (d.seoul) {
    const s = d.seoul;
    const parts = [];
    if (s.monthlyAmt) parts.push(`월 추정매출 약 ${s.monthlyAmt}`);
    if (s.foot) parts.push(`분기 유동인구 ${s.foot}`);
    if (s.topAge) parts.push(`주 소비층 ${s.topAge}`);
    if (s.topTime) parts.push(`매출 피크 ${s.topTime}`);
    if (s.closeRate != null) parts.push(`폐업률 ${s.closeRate}%`);
    if (parts.length) lines.push(`서울 행정동 심화: ${parts.join(', ')}`);
  }

  return [
    '너는 친절한 상권 분석가야. 아래 한 동네의 상권 데이터를 보고, 부동산·창업을 잘 모르는 일반인이 한눈에 이해할 수 있도록 해석해줘.',
    '',
    '[상권 데이터]',
    lines.join('\n'),
    '',
    '[작성 규칙]',
    '- 한국어로, 따뜻하고 쉬운 말투. 전문용어는 풀어서 설명.',
    '- 3~4문장. 첫 문장은 이 동네가 한마디로 어떤 곳인지 요약.',
    '- 이어서 데이터에서 드러나는 특징(어떤 업종이 많고 적은지, 유동인구·소비층 등)이 실제로 무엇을 의미하는지 설명.',
    '- 마지막에 창업/입지나 거주 관점에서 참고할 점이나 주의할 점을 한 가지 짚어줘.',
    '- 숫자를 그대로 나열하지 말고 "카페가 유난히 많은 편" 처럼 의미로 풀어줘.',
    '- 마크다운 기호(#, *, - 등) 없이 평문 문단으로만. 군더더기 인사말 없이 바로 본론.',
  ].join('\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST만 허용됩니다.' });
    return;
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    res.status(503).json({ error: 'AI 코멘트가 설정되지 않았습니다.', hint: 'Vercel 환경변수 GEMINI_API_KEY를 등록하세요 (Google AI Studio에서 발급).' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') { res.status(400).json({ error: '분석 요약(JSON)이 필요합니다.' }); return; }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const payload = {
    contents: [{ parts: [{ text: buildPrompt(body) }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 700, topP: 0.95 },
  };

  try {
    const r = await timedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 25000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.status(502).json({ error: 'AI 코멘트 생성 실패', detail: (j.error && j.error.message) || r.statusText });
      return;
    }
    const cand = j.candidates && j.candidates[0];
    const text = cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.map(p => p.text || '').join('').trim()
      : '';
    if (!text) {
      res.status(502).json({ error: 'AI가 코멘트를 생성하지 못했습니다.', detail: (cand && cand.finishReason) || 'empty' });
      return;
    }
    // 같은 좌표/요약은 결과가 비슷하므로 CDN에 잠깐 캐싱
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ comment: text, model });
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    res.status(aborted ? 504 : 502).json({
      error: aborted ? 'AI 서버 응답이 지연됩니다. 잠시 후 다시 시도해주세요.' : 'AI 코멘트 생성 중 오류',
      detail: e.message,
    });
  }
};
