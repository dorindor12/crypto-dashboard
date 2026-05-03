// api.js — Real exchange data fetcher with CORS proxy

const API = (() => {

  const PROXIES = [
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
        if (json.contents) return JSON.parse(json.contents);
        return json;
      } catch (e) {
        console.warn('Proxy failed, trying next...', e.message);
      }
    }
    throw new Error('All proxies failed for: ' + url);
  }

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
    return { exchange: 'Huobi', price, change24h: ((price - open) / open) * 100, volume24h: t.amount * price };
  }

  async function getKraken(symbol) {
    const krakenSymbol = symbol === 'BTC' ? 'XBT' : symbol;
    const data = await fetchWithProxy(`https://api.kraken.com/0/public/Ticker?pair=${krakenSymbol}USDT`);
    const keys = Object.keys(data.result);
    const item = data.result[keys[0]];
    const price = parseFloat(item.c[0]), open = parseFloat(item.o);
    return { exchange: 'Kraken', price, change24h: ((price - open) / open) * 100, volume24h: parseFloat(item.v[1]) * price };
  }

  async function getAllPrices(symbol) {
    const fetchers = [getBinance(symbol), getBybit(symbol), getOKX(symbol), getKuCoin(symbol), getGateIO(symbol), getMEXC(symbol), getHuobi(symbol), getKraken(symbol)];
    const results = await Promise.allSettled(fetchers);
    return results.map((r, i) => {
      if (r.status === 'fulfilled' && r.value && !isNaN(r.value.price) && r.value.price > 0) return r.value;
      console.warn(`Exchange ${i} failed:`, r.reason?.message || 'bad data');
      return null;
    }).filter(Boolean);
  }

  async function getCoinHistory(coinId, days = 30) {
    const data = await fetchWithProxy(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`);
    return {
      prices: data.prices.map(p => ({ t: p[0], v: p[1] })),
      volumes: data.total_volumes.map(v => ({ t: v[0], v: v[1] })),
    };
  }

  return { getAllPrices, getCoinHistory };
})();
