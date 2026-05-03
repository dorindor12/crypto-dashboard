// api.js — Real exchange data fetcher with CORS proxy
//
// Proxy strategy:
//   1. Same-origin /api/proxy serverless function (Vercel) — primary.
//      Hosted alongside the site, no rate limits, allowlisted to known
//      crypto API hosts. This is the only proxy we control.
//   2. corsproxy.io — public fallback (occasionally rate-limited).
//   3. api.allorigins.win — last-resort public fallback (slow, sometimes
//      geo-blocked, returns the body inside { contents }).
//
// The same-origin proxy is skipped automatically when the site is opened
// from `file://` or any non-http(s) origin (e.g. local development off a
// static file), so the dashboard still works in dev without needing the
// serverless runtime.

const API = (() => {

  const sameOriginProxyAvailable = (() => {
    try { return typeof location !== 'undefined' && /^https?:$/.test(location.protocol); }
    catch { return false; }
  })();

  const PROXIES = [
    ...(sameOriginProxyAvailable
      ? [url => `/api/proxy?url=${encodeURIComponent(url)}`]
      : []),
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  ];

  async function fetchWithProxy(url) {
    for (const makeProxy of PROXIES) {
      try {
        const proxyUrl = makeProxy(url);
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const json = await res.json();
        if (json && typeof json === 'object' && 'contents' in json && typeof json.contents === 'string') {
          // allorigins wraps the upstream body in { contents: "..." }.
          return JSON.parse(json.contents);
        }
        return json;
      } catch (e) {
        console.warn('Proxy failed, trying next...', e.message);
      }
    }
    throw new Error('All proxies failed for: ' + url);
  }

  // ─── EXCHANGES ──────────────────────────────────────────────────────────────

  async function getBinance(symbol) {
    const data = await fetchWithProxy(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`);
    return { exchange: 'Binance', price: parseFloat(data.lastPrice), change24h: parseFloat(data.priceChangePercent), volume24h: parseFloat(data.quoteVolume) };
  }

  async function getBybit(symbol) {
    const data = await fetchWithProxy(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}USDT`);
    const item = data.result.list[0];
    return { exchange: 'Bybit', price: parseFloat(item.lastPrice), change24h: parseFloat(item.price24hPcnt) * 100, volume24h: parseFloat(item.turnover24h) };
  }

  async function getOKX(symbol) {
    const data = await fetchWithProxy(`https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT`);
    const item = data.data[0];
    const price = parseFloat(item.last), open = parseFloat(item.open24h);
    return { exchange: 'OKX', price, change24h: ((price - open) / open) * 100, volume24h: parseFloat(item.volCcy24h) };
  }

  async function getKuCoin(symbol) {
    const data = await fetchWithProxy(`https://api.kucoin.com/api/v1/market/stats?symbol=${symbol}-USDT`);
    const d = data.data;
    return { exchange: 'KuCoin', price: parseFloat(d.last), change24h: parseFloat(d.changeRate) * 100, volume24h: parseFloat(d.volValue) };
  }

  async function getGateIO(symbol) {
    const data = await fetchWithProxy(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${symbol}_USDT`);
    const item = Array.isArray(data) ? data[0] : data;
    return { exchange: 'Gate.io', price: parseFloat(item.last), change24h: parseFloat(item.change_percentage), volume24h: parseFloat(item.quote_volume) };
  }

  async function getMEXC(symbol) {
    const data = await fetchWithProxy(`https://api.mexc.com/api/v3/ticker/24hr?symbol=${symbol}USDT`);
    return { exchange: 'MEXC', price: parseFloat(data.lastPrice), change24h: parseFloat(data.priceChangePercent), volume24h: parseFloat(data.quoteVolume) };
  }

  async function getHuobi(symbol) {
    const data = await fetchWithProxy(`https://api.huobi.pro/market/detail/merged?symbol=${symbol.toLowerCase()}usdt`);
    const t = data.tick, price = t.close, open = t.open;
    return { exchange: 'HTX (Huobi)', price, change24h: ((price - open) / open) * 100, volume24h: t.amount * price };
  }

  async function getKraken(symbol) {
    const krakenSymbol = symbol === 'BTC' ? 'XBT' : symbol;
    const data = await fetchWithProxy(`https://api.kraken.com/0/public/Ticker?pair=${krakenSymbol}USDT`);
    const keys = Object.keys(data.result || {});
    if (!keys.length) throw new Error('Kraken: no data');
    const item = data.result[keys[0]];
    const price = parseFloat(item.c[0]), open = parseFloat(item.o);
    return { exchange: 'Kraken', price, change24h: ((price - open) / open) * 100, volume24h: parseFloat(item.v[1]) * price };
  }

  async function getCoinbase(symbol) {
    // Coinbase Exchange (formerly Coinbase Pro) — try USDT first, fall back to USD.
    async function tryQuote(quote) {
      const product = `${symbol}-${quote}`;
      const [ticker, stats] = await Promise.all([
        fetchWithProxy(`https://api.exchange.coinbase.com/products/${product}/ticker`),
        fetchWithProxy(`https://api.exchange.coinbase.com/products/${product}/stats`),
      ]);
      const price = parseFloat(ticker.price);
      const open = parseFloat(stats.open);
      const vol = parseFloat(stats.volume) * price;
      return { price, open, vol, quote };
    }
    let data;
    try { data = await tryQuote('USDT'); }
    catch (e) { data = await tryQuote('USD'); }
    return {
      exchange: 'Coinbase' + (data.quote === 'USD' ? ' (USD)' : ''),
      price: data.price,
      change24h: ((data.price - data.open) / data.open) * 100,
      volume24h: data.vol,
    };
  }

  async function getBitstamp(symbol) {
    const data = await fetchWithProxy(`https://www.bitstamp.net/api/v2/ticker/${symbol.toLowerCase()}usdt/`);
    const price = parseFloat(data.last);
    const open = parseFloat(data.open);
    return { exchange: 'Bitstamp', price, change24h: ((price - open) / open) * 100, volume24h: parseFloat(data.volume) * price };
  }

  async function getBitfinex(symbol) {
    // Bitfinex returns array: [BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_RELATIVE, LAST_PRICE, VOLUME, HIGH, LOW]
    // Try UST (Bitfinex's USDT ticker) first, fall back to USD.
    async function tryQuote(quote) {
      const data = await fetchWithProxy(`https://api-pub.bitfinex.com/v2/ticker/t${symbol}${quote}`);
      if (!Array.isArray(data) || data.length < 10) throw new Error('Bitfinex: bad shape');
      const price = parseFloat(data[6]);
      return {
        price,
        change24h: parseFloat(data[5]) * 100,
        volume24h: parseFloat(data[7]) * price,
        quote,
      };
    }
    let r;
    try { r = await tryQuote('UST'); }
    catch (e) { r = await tryQuote('USD'); }
    return {
      exchange: 'Bitfinex' + (r.quote === 'USD' ? ' (USD)' : ''),
      price: r.price,
      change24h: r.change24h,
      volume24h: r.volume24h,
    };
  }

  async function getCryptoCom(symbol) {
    const data = await fetchWithProxy(`https://api.crypto.com/v2/public/get-ticker?instrument_name=${symbol}_USDT`);
    const d = data.result?.data;
    const item = Array.isArray(d) ? d[0] : d;
    if (!item) throw new Error('Crypto.com: no data');
    const price = parseFloat(item.a);
    const open = parseFloat(item.o);
    const change24h = open ? ((price - open) / open) * 100 : 0;
    return { exchange: 'Crypto.com', price, change24h, volume24h: parseFloat(item.vv ?? item.v) };
  }

  async function getBitGet(symbol) {
    const data = await fetchWithProxy(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${symbol}USDT`);
    const item = data.data?.[0];
    if (!item) throw new Error('Bitget: no data');
    const price = parseFloat(item.lastPr);
    const change24h = parseFloat(item.change24h) * 100;
    return { exchange: 'Bitget', price, change24h, volume24h: parseFloat(item.usdtVolume) };
  }

  async function getPoloniex(symbol) {
    const data = await fetchWithProxy(`https://api.poloniex.com/markets/${symbol}_USDT/ticker24h`);
    const price = parseFloat(data.close);
    const open = parseFloat(data.open);
    return {
      exchange: 'Poloniex',
      price,
      change24h: open ? ((price - open) / open) * 100 : 0,
      volume24h: parseFloat(data.quantity) * price,
    };
  }

  async function getBingX(symbol) {
    const data = await fetchWithProxy(`https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?symbol=${symbol}-USDT`);
    const item = Array.isArray(data.data) ? data.data[0] : data.data;
    if (!item) throw new Error('BingX: no data');
    const price = parseFloat(item.lastPrice);
    const open = parseFloat(item.openPrice);
    return {
      exchange: 'BingX',
      price,
      change24h: open ? ((price - open) / open) * 100 : 0,
      volume24h: parseFloat(item.quoteVolume),
    };
  }

  async function getBitmart(symbol) {
    const data = await fetchWithProxy(`https://api-cloud.bitmart.com/spot/quotation/v3/ticker?symbol=${symbol}_USDT`);
    const item = data.data;
    if (!item) throw new Error('Bitmart: no data');
    const price = parseFloat(item.last);
    return {
      exchange: 'Bitmart',
      price,
      change24h: parseFloat(item.fluctuation) * 100,
      volume24h: parseFloat(item.qv_24h),
    };
  }

  async function getLBank(symbol) {
    const data = await fetchWithProxy(`https://api.lbkex.com/v2/ticker/24hr.do?symbol=${symbol.toLowerCase()}_usdt`);
    const arr = data.data;
    const item = Array.isArray(arr) ? arr[0]?.ticker : arr?.ticker;
    if (!item) throw new Error('LBank: no data');
    const price = parseFloat(item.latest);
    return {
      exchange: 'LBank',
      price,
      change24h: parseFloat(item.change),
      volume24h: parseFloat(item.turnover),
    };
  }

  async function getXT(symbol) {
    const data = await fetchWithProxy(`https://sapi.xt.com/v4/public/ticker/24h?symbol=${symbol.toLowerCase()}_usdt`);
    const item = Array.isArray(data.result) ? data.result[0] : data.result;
    if (!item) throw new Error('XT: no data');
    const price = parseFloat(item.c);
    const open = parseFloat(item.o);
    return {
      exchange: 'XT.com',
      price,
      change24h: open ? ((price - open) / open) * 100 : parseFloat(item.cr) * 100,
      volume24h: parseFloat(item.v) * price,
    };
  }

  async function getWhiteBIT(symbol) {
    const data = await fetchWithProxy(`https://whitebit.com/api/v4/public/ticker`);
    const key = `${symbol}_USDT`;
    const item = data[key];
    if (!item) throw new Error('WhiteBIT: pair not listed');
    const price = parseFloat(item.last_price);
    return {
      exchange: 'WhiteBIT',
      price,
      change24h: parseFloat(item.change),
      volume24h: parseFloat(item.quote_volume),
    };
  }

  async function getPhemex(symbol) {
    const data = await fetchWithProxy(`https://api.phemex.com/md/spot/ticker/24hr?symbol=s${symbol}USDT`);
    const r = data.result;
    if (!r) throw new Error('Phemex: no data');
    // Phemex returns scaled integers; spot scale is 1e8 for prices.
    const SCALE = 1e8;
    const price = r.lastEp / SCALE;
    const open = r.openEp / SCALE;
    return {
      exchange: 'Phemex',
      price,
      change24h: open ? ((price - open) / open) * 100 : 0,
      volume24h: r.turnoverEv / SCALE,
    };
  }

  // Each entry: a function that returns Promise<{exchange, price, change24h, volume24h}>
  const EXCHANGES = [
    getBinance, getBybit, getOKX, getKuCoin, getGateIO, getMEXC, getHuobi, getKraken,
    getCoinbase, getBitstamp, getBitfinex, getCryptoCom, getBitGet, getPoloniex,
    getBingX, getBitmart, getLBank, getXT, getWhiteBIT, getPhemex,
  ];

  async function getAllPrices(symbol) {
    const results = await Promise.allSettled(EXCHANGES.map(fn => fn(symbol)));
    return results.map((r, i) => {
      if (r.status === 'fulfilled' && r.value && !isNaN(r.value.price) && r.value.price > 0) return r.value;
      console.warn(`Exchange ${i} (${EXCHANGES[i].name}) failed:`, r.reason?.message || 'bad data');
      return null;
    }).filter(Boolean);
  }

  // ─── COIN UNIVERSE (CoinGecko) ──────────────────────────────────────────────

  // Cached top coins list (TTL 6h) — used to populate searchable dropdowns for
  // both the Arbitrage and Scam tabs.
  const COINS_CACHE_KEY = 'cryptolens.topCoins.v1';
  const COINS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  function readCache() {
    try {
      const raw = localStorage.getItem(COINS_CACHE_KEY);
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > COINS_CACHE_TTL_MS) return null;
      return data;
    } catch { return null; }
  }

  function writeCache(data) {
    try { localStorage.setItem(COINS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
  }

  // Load the bundled top-500 coin list (shipped with the site as coins.json).
  // This avoids hitting CoinGecko via flaky CORS proxies on every page load.
  async function loadBundledCoins() {
    const res = await fetch('coins.json', { cache: 'force-cache' });
    if (!res.ok) throw new Error('coins.json: HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) throw new Error('coins.json: empty');
    return data;
  }

  // Best-effort live refresh of the coin list from CoinGecko via the CORS
  // proxies. If the proxies are rate-limited (common), we silently keep using
  // the bundled list / previous cache.
  async function refreshFromCoinGecko(limit = 500) {
    const perPage = 250;
    const pages = Math.ceil(limit / perPage);
    const all = [];
    // Sequential to be friendlier to the rate-limited public proxy.
    for (let p = 1; p <= pages; p++) {
      try {
        const data = await fetchWithProxy(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${p}&sparkline=false`);
        if (Array.isArray(data)) all.push(...data);
      } catch (e) {
        console.warn('CoinGecko page', p, 'failed:', e.message);
      }
    }
    if (!all.length) return null;
    return all.map(c => ({
      id: c.id,
      symbol: (c.symbol || '').toUpperCase(),
      name: c.name,
      image: c.image,
      rank: c.market_cap_rank,
    }));
  }

  async function getTopCoins(limit = 500) {
    const cached = readCache();
    if (cached && cached.length >= Math.min(limit, 100)) {
      // Kick off a background refresh but don't await it.
      refreshFromCoinGecko(limit).then(fresh => {
        if (fresh && fresh.length >= cached.length) writeCache(fresh);
      }).catch(() => {});
      return cached.slice(0, limit);
    }

    // First load: use the bundled list immediately.
    let bundled = null;
    try { bundled = await loadBundledCoins(); }
    catch (e) { console.warn('Bundled coin list unavailable:', e.message); }

    if (bundled) {
      writeCache(bundled);
      // Background refresh from CoinGecko (non-blocking).
      refreshFromCoinGecko(limit).then(fresh => {
        if (fresh && fresh.length >= bundled.length) writeCache(fresh);
      }).catch(() => {});
      return bundled.slice(0, limit);
    }

    // Fallback path: bundled file unavailable, try CoinGecko directly.
    const live = await refreshFromCoinGecko(limit);
    if (!live || !live.length) throw new Error('CoinGecko: no coins returned');
    writeCache(live);
    return live.slice(0, limit);
  }

  async function getCoinHistory(coinId, days = 30) {
    const data = await fetchWithProxy(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`);
    return {
      prices: data.prices.map(p => ({ t: p[0], v: p[1] })),
      volumes: data.total_volumes.map(v => ({ t: v[0], v: v[1] })),
    };
  }

  return { getAllPrices, getCoinHistory, getTopCoins };
})();
