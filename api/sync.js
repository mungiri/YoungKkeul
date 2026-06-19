/**
 * 영끌컷 · 임장 체크리스트 기기 간 동기화 엔드포인트
 * =====================================================
 * 로그인 없이 "공유 코드" 하나로 폰·컴퓨터가 같은 데이터를 보게 한다.
 *   - 코드를 아는 사람만 해당 데이터에 접근 → 코드 자체가 열쇠(공유 비밀).
 *   - 비밀번호·이메일 등 개인정보를 일절 수집하지 않는다.
 *
 * 저장소: Upstash Redis(무료 티어)의 REST API 사용 (의존성 0, fetch만 사용).
 *   - commerce.js / ai-comment.js와 동일한 아키텍처 원칙.
 *
 * 환경변수 (Vercel → Settings → Environment Variables):
 *   UPSTASH_REDIS_REST_URL   = Upstash 콘솔의 REST URL
 *   UPSTASH_REDIS_REST_TOKEN = Upstash 콘솔의 REST Token (읽기/쓰기)
 *   (https://console.upstash.com → Redis DB 생성 → REST API 탭에서 복사)
 *
 * 호출:
 *   GET  /api/sync?code=ABCD2345        → { data, updatedAt } 또는 { empty:true }
 *   POST /api/sync  body:{ code, data } → { ok:true, updatedAt }
 */

const KEY_PREFIX = 'ykk:sync:';
const TTL_SEC = 60 * 60 * 24 * 365;          // 1년 (방치된 코드 자동 정리)
const MAX_BYTES = 1024 * 1024;               // 1MB 상한

function validCode(c) {
  return typeof c === 'string' && /^[A-Za-z0-9]{4,32}$/.test(c);
}

// Upstash Redis REST: 본문에 ["CMD", ...args] 배열을 그대로 전달
async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { const e = new Error('NO_STORE'); e.code = 'NO_STORE'; throw e; }
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) { const e = new Error('REDIS_' + r.status); e.code = 'REDIS'; throw e; }
  return r.json();   // { result: ... }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const code = String((req.query && req.query.code) || '').trim();
      if (!validCode(code)) { res.status(400).json({ error: 'invalid_code' }); return; }
      const out = await redis(['GET', KEY_PREFIX + code]);
      const val = out && out.result;
      if (!val) { res.status(200).json({ empty: true }); return; }
      let parsed = null;
      try { parsed = JSON.parse(val); } catch (e) { parsed = null; }
      res.status(200).json({ data: parsed && parsed.data, updatedAt: parsed && parsed.updatedAt });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      if (!body || typeof body !== 'object') { res.status(400).json({ error: 'bad_body' }); return; }
      const code = String(body.code || '').trim();
      if (!validCode(code)) { res.status(400).json({ error: 'invalid_code' }); return; }
      const updatedAt = Date.now();
      const payload = JSON.stringify({ data: body.data, updatedAt });
      if (payload.length > MAX_BYTES) { res.status(413).json({ error: 'too_large' }); return; }
      await redis(['SET', KEY_PREFIX + code, payload, 'EX', TTL_SEC]);
      res.status(200).json({ ok: true, updatedAt });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    if (e.code === 'NO_STORE') {
      res.status(503).json({ error: 'store_not_configured',
        hint: 'Vercel 환경변수 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN을 등록하세요.' });
      return;
    }
    res.status(500).json({ error: 'sync_failed', detail: e.message });
  }
};
