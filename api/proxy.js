// Vercel Serverless Function — generic CORS-passthrough proxy.
//
// Why: third-party CORS proxies (corsproxy.io, allorigins.win) are
// rate-limited and geo-blocked by many exchanges. Hosting our own keeps the
// dashboard working without depending on flaky public infra.
//
// GET /api/proxy?url=<encoded-url>
//   Whitelisted to a small set of crypto data hosts so this can't be abused
//   as an open proxy. The response body and content-type are passed through.

const ALLOWED_HOSTS = new Set([
  // Coin universe / history
  'api.coingecko.com',
  // Major exchanges
  'api.binance.com',
  'api.bybit.com',
  'www.okx.com',
  'api.kucoin.com',
  'api.gateio.ws',
  'api.mexc.com',
  'api.huobi.pro',
  'api-aws.huobi.pro',
  'api.kraken.com',
  'api.exchange.coinbase.com',
  'api.coinbase.com',
  'www.bitstamp.net',
  'api-pub.bitfinex.com',
  'api.crypto.com',
  'api.bitget.com',
  'open-api.bingx.com',
  'api-cloud.bitmart.com',
  'api.lbkex.com',
  'sapi.xt.com',
  'whitebit.com',
  'api.phemex.com',
  'poloniex.com',
  'api.poloniex.com',
]);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const target = req.query && req.query.url;
  if (!target || typeof target !== 'string') {
    res.status(400).json({ error: 'missing ?url= parameter' });
    return;
  }

  let parsed;
  try { parsed = new URL(target); }
  catch { res.status(400).json({ error: 'invalid url' }); return; }

  if (parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'only https targets allowed' });
    return;
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    res.status(403).json({ error: `host not allowed: ${parsed.hostname}` });
    return;
  }

  // 8s upstream timeout — slightly less than Vercel's 10s default so we can
  // return a clean error rather than a 504.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        // Some providers reject "node-fetch" UA — pretend to be a browser.
        'User-Agent': 'Mozilla/5.0 (compatible; CryptoLensDashboard/1.0)',
        'Accept': 'application/json,text/plain,*/*',
      },
    });
    clearTimeout(timer);

    const body = await upstream.text();
    const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    // Cache successful responses briefly to soften upstream rate limits and
    // speed up repeated dashboard refreshes.
    if (upstream.ok) {
      res.setHeader('Cache-Control', 'public, max-age=5, s-maxage=5, stale-while-revalidate=20');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    res.setHeader('Content-Type', ct);
    res.status(upstream.status).send(body);
  } catch (err) {
    clearTimeout(timer);
    const msg = err && err.name === 'AbortError' ? 'upstream timeout' : (err && err.message || 'fetch failed');
    res.status(502).json({ error: msg });
  }
};
