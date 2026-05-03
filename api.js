// api.js — Real exchange data fetcher
// Uses public APIs (no API key required for price data)

const API = (() => {

  // Proxy to bypass CORS. Use allorigins for client-side or remove if running server-side.
  const PROXY = 'https://api.allorigins.win/get?url=';

  async function fetchJSON(url, useProxy = true) {
    const target = useProxy ? `${PROXY}${encodeURIComponent(url)}` : url;
    const res = await fetch(target, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // allorigins wraps response in {contents: "..."}
    return useProxy ? JSON.parse(json.contents) : json;
  }

  // ─── BINANCE ───────────────────────────────────────────────────────────────
  async function getBinance(symbol) {
    // symbol e.g. "BTCUSDT"
    const data = await fetchJSON(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`
    );
    return {
      exchange: 'Binance',
      price: parseFloat(data.lastPrice),
      change24h: parseFloat(data.priceChangePercent),
      volume24h: parseFloat(data.quoteVolume),
    };
  }

  // ─── BYBIT ─────────────────────────────────────────────────────────────────
  async function getBybit(symbol) {
    const data = await fetchJSON(
      `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}USDT`
    );
    const item = data.result.list[0];
    return {
      exchange: 'Bybit',
      price: parseFloat(item.lastPrice),
      change24h: parseFloat(item.price24hPcnt) * 100,
      volume24h: parseFloat(item.turnover24h),
    };
  }

  // ─── OKX ───────────────────────────────────────────────────────────────────
  async function getOKX(symbol) {
    const data = await fetchJSON(
      `https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT`
    );
    const item = data.data[0];
    return {
      exchange: 'OKX',
      price: parseFloat(item.last),
      change24h: ((parseFloat(item.last) - parseFloat(item.open24h)) / parseFloat(item.open24h)) * 100,
      volume24h: parseFloat(item.volCcy24h),
    };
  }

  // ─── KUCOIN ────────────────────────────────────────────────────────────────
  async function getKuCoin(symbol) {
    const data = await fetchJSON(
      `https://api.kucoin.com/api/v1/market/stats?symbol=${symbol}-USDT`
    );
    const d = data.data;
    return {
      exchange: 'KuCoin',
      price: parseFloat(d.last),
      change24h: parseFloat(d.changeRate) * 100,
      volume24h: parseFloat(d.volValue),
    };
  }

  // ─── GATE.IO ───────────────────────────────────────────────────────────────
  async function getGateIO(symbol) {
    const data = await fetchJSON(
      `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${symbol}_USDT`
    );
    const item = data[0];
    return {
      exchange: 'Gate.io',
      price: parseFloat(item.last),
      change24h: parseFloat(item.change_percentage),
      volume24h: parseFloat(item.quote_volume),
    };
  }

  // ─── MEXC ──────────────────────────────────────────────────────────────────
  async function getMEXC(symbol) {
    const data = await fetchJSON(
      `https://api.mexc.com/api/v3/ticker/24hr?symbol=${symbol}USDT`
    );
    return {
      exchange: 'MEXC',
      price: parseFloat(data.lastPrice),
      change24h: parseFloat(data.priceChangePercent),
      volume24h: parseFloat(data.quoteVolume),
    };
  }

  // ─── HUOBI / HTX ───────────────────────────────────────────────────────────
  async function getHuobi(symbol) {
    const data = await fetchJSON(
      `https://api.huobi.pro/market/detail/merged?symbol=${symbol.toLowerCase()}usdt`
    );
    const t = data.tick;
    const price = t.close;
    const open = t.open;
    return {
      exchange: 'Huobi',
      price,
      change24h: ((price - open) / open) * 100,
      volume24h: t.amount * price,
    };
  }

  // ─── KRAKEN ────────────────────────────────────────────────────────────────
  async function getKraken(symbol) {
    // Kraken uses different pair names
    const krakenSymbol = symbol === 'BTC' ? 'XBT' : symbol;
    const data = await fetchJSON(
      `https://api.kraken.com/0/public/Ticker?pair=${krakenSymbol}USDT`
    );
    const keys = Object.keys(data.result);
    const item = data.result[keys[0]];
    const price = parseFloat(item.c[0]);
    const open = parseFloat(item.o);
    return {
      exchange: 'Kraken',
      price,
      change24h: ((price - open) / open) * 100,
      volume24h: parseFloat(item.v[1]) * price,
    };
  }

  // ─── ALL EXCHANGES ─────────────────────────────────────────────────────────
  async function getAllPrices(symbol) {
    const fetchers = [
      getBinance(symbol),
      getBybit(symbol),
      getOKX(symbol),
      getKuCoin(symbol),
      getGateIO(symbol),
      getMEXC(symbol),
      getHuobi(symbol),
      getKraken(symbol),
    ];

    const results = await Promise.allSettled(fetchers);
    return results
      .map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        console.warn(`Exchange ${i} failed:`, r.reason);
        return null;
      })
      .filter(Boolean);
  }

  // ─── COINGECKO — for scam pattern ─────────────────────────────────────────
  async function getCoinHistory(coinId, days = 30) {
    const data = await fetchJSON(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
      true
    );
    return {
      prices: data.prices.map(p => ({ t: p[0], v: p[1] })),
      volumes: data.total_volumes.map(v => ({ t: v[0], v: v[1] })),
    };
  }

  return { getAllPrices, getCoinHistory };
})();
