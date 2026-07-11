const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const PROXY_TOKEN = defineSecret('PROXY_TOKEN');

// GitHub Actions（米国リージョン）から fapi.binance.com への直接アクセスが
// 451(地理ブロック)になるための中継専用プロキシ（asia-northeast1発信）。
// EXP-OBS000032 フォワード較正 F2ゲート用。Binance funding rate history のみを中継する。
exports.binanceFundingProxy = onRequest(
  {
    region: 'asia-northeast1',
    secrets: [PROXY_TOKEN],
    memory: '128MiB',
    timeoutSeconds: 20,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.get('x-proxy-token') !== PROXY_TOKEN.value()) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const { symbol, startTime, endTime, limit } = req.query;
    if (!symbol || typeof symbol !== 'string') {
      res.status(400).json({ error: 'symbol query param is required' });
      return;
    }

    const params = new URLSearchParams({ symbol, limit: String(limit ?? 1000) });
    if (startTime) params.set('startTime', String(startTime));
    if (endTime) params.set('endTime', String(endTime));

    const upstreamUrl = `https://fapi.binance.com/fapi/v1/fundingRate?${params.toString()}`;

    try {
      const upstream = await fetch(upstreamUrl);
      const body = await upstream.text();
      res.status(upstream.status).set('Content-Type', 'application/json').send(body);
    } catch (err) {
      res.status(502).json({ error: 'upstream_fetch_failed', message: err instanceof Error ? err.message : String(err) });
    }
  }
);
