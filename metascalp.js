// metascalp.js — live order book + tape + iceberg/refill detector + alerts.
//
// Public WebSocket streams used (no auth, no CORS proxy needed):
//   Binance:  wss://stream.binance.com:9443/stream
//   Bybit V5: wss://stream.bybit.com/v5/public/spot
//   OKX V5:   wss://ws.okx.com:8443/ws/v5/public
//   Bitget V2:wss://ws.bitget.com/v2/ws/public
//
// MEXC and BingX are stubbed in v1 — MEXC moved to protobuf and BingX
// uses gzip-compressed frames; both will be added in a follow-up PR.

(function () {
  'use strict';

  // ─── DOM refs (lazy — populated on first use) ──────────────────────────────
  const $ = id => document.getElementById(id);

  // ─── State ─────────────────────────────────────────────────────────────────
  const state = {
    ws: null,
    exchange: null,
    symbol: null,
    bookKeeper: null,
    tapeBuf: [],          // last N trades, newest first
    cvdBuf: [],           // [{ts, signedQty, signedNotional}]
    alerts: [],           // last N alerts
    levelTrack: new Map(),// "side|price" → tracking entry for refill detector
    refillTimer: null,
    audioCtx: null,
    lastNotifTs: 0,
    seq: 0,
  };

  const TAPE_MAX = 200;
  const ALERTS_MAX = 50;
  const REFILL_WINDOW_MS = 2000;
  const REFILL_RECOVER_PCT = 0.80;
  const REFILL_DAMAGE_PCT = 0.30;   // ignore tiny nibbles
  const NOTIF_COOLDOWN_MS = 1500;

  // ─── Utility formatters ────────────────────────────────────────────────────
  function fmtPrice(p) {
    if (!isFinite(p)) return '—';
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    if (p >= 0.01) return p.toFixed(5);
    return p.toFixed(7);
  }
  function fmtSize(q) {
    if (!isFinite(q)) return '—';
    if (q >= 1e6) return (q / 1e6).toFixed(2) + 'M';
    if (q >= 1e3) return (q / 1e3).toFixed(2) + 'k';
    if (q >= 1) return q.toFixed(2);
    return q.toFixed(4);
  }
  function fmtUsd(v) {
    if (!isFinite(v)) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
    return '$' + v.toFixed(0);
  }
  function fmtBps(bps) {
    if (!isFinite(bps)) return '—';
    return (bps >= 0 ? '+' : '') + bps.toFixed(2) + ' bps';
  }
  function fmtPct(x) {
    if (!isFinite(x)) return '—';
    return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
  }
  function timeStr(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ru-RU', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  // ─── Exchange-agnostic order book keeper ───────────────────────────────────
  class OrderBook {
    constructor() {
      this.bids = new Map(); // priceKey(string) → size(number)
      this.asks = new Map();
    }
    snapshot(bids, asks) {
      this.bids.clear();
      this.asks.clear();
      for (const [p, q] of bids) {
        const qn = +q;
        if (qn > 0) this.bids.set(String(p), qn);
      }
      for (const [p, q] of asks) {
        const qn = +q;
        if (qn > 0) this.asks.set(String(p), qn);
      }
    }
    delta(bids, asks) {
      for (const [p, q] of bids) {
        const qn = +q;
        const k = String(p);
        if (qn === 0) this.bids.delete(k);
        else this.bids.set(k, qn);
      }
      for (const [p, q] of asks) {
        const qn = +q;
        const k = String(p);
        if (qn === 0) this.asks.delete(k);
        else this.asks.set(k, qn);
      }
    }
    topN(n) {
      const bids = [];
      for (const [p, q] of this.bids) bids.push([+p, q]);
      bids.sort((a, b) => b[0] - a[0]);
      const asks = [];
      for (const [p, q] of this.asks) asks.push([+p, q]);
      asks.sort((a, b) => a[0] - b[0]);
      return { bids: bids.slice(0, n), asks: asks.slice(0, n) };
    }
    sizeAt(side, price) {
      const k = String(price);
      const m = side === 'bid' ? this.bids : this.asks;
      return m.get(k) || 0;
    }
  }

  // ─── Connection adapters per exchange ──────────────────────────────────────

  // Binance combined stream — depth20@100ms + aggTrade. Top 20 snapshot every 100ms.
  function connectBinance(symbol, handlers) {
    const s = symbol.toLowerCase();
    const url = `wss://stream.binance.com:9443/stream?streams=${s}@depth20@100ms/${s}@aggTrade`;
    const ws = new WebSocket(url);
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const data = msg.data;
      if (!data) return;
      if (msg.stream && msg.stream.endsWith('@depth20@100ms')) {
        handlers.onSnapshot(data.bids, data.asks);
      } else if (msg.stream && msg.stream.endsWith('@aggTrade')) {
        // m=true → buyer is maker → SELL aggressor.
        handlers.onTrade({
          ts: data.T,
          price: +data.p,
          qty: +data.q,
          side: data.m ? 'sell' : 'buy',
        });
      }
    };
    ws.onerror = (e) => handlers.onError(e);
    ws.onclose = (ev) => handlers.onClose(ev);
    return ws;
  }

  // Bybit V5 spot — orderbook.50 (snapshot+delta) + publicTrade.
  function connectBybit(symbol, handlers) {
    const url = 'wss://stream.bybit.com/v5/public/spot';
    const ws = new WebSocket(url);
    let pingTimer = null;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: [`orderbook.50.${symbol}`, `publicTrade.${symbol}`],
      }));
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      }, 20000);
      handlers.onOpen();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!msg.topic) return;
      if (msg.topic.startsWith('orderbook.')) {
        const d = msg.data;
        if (msg.type === 'snapshot') handlers.onSnapshot(d.b, d.a);
        else if (msg.type === 'delta') handlers.onDelta(d.b, d.a);
      } else if (msg.topic.startsWith('publicTrade.')) {
        for (const t of msg.data) {
          handlers.onTrade({
            ts: +t.T,
            price: +t.p,
            qty: +t.v,
            side: (t.S || '').toLowerCase(), // "Buy" | "Sell"
          });
        }
      }
    };
    ws.onerror = (e) => handlers.onError(e);
    ws.onclose = (ev) => { if (pingTimer) clearInterval(pingTimer); handlers.onClose(ev); };
    return ws;
  }

  // OKX V5 — books (top 400, snapshot+update) + trades.
  function connectOkx(symbol, handlers) {
    // OKX uses "BTC-USDT" instId.
    const instId = symbol.endsWith('USDT') ? symbol.slice(0, -4) + '-USDT' : symbol;
    const url = 'wss://ws.okx.com:8443/ws/v5/public';
    const ws = new WebSocket(url);
    let pingTimer = null;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: [
          { channel: 'books', instId },
          { channel: 'trades', instId },
        ],
      }));
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, 20000);
      handlers.onOpen();
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.event) return; // sub ack
      if (!msg.arg || !msg.data) return;
      const ch = msg.arg.channel;
      if (ch === 'books') {
        for (const d of msg.data) {
          if (msg.action === 'snapshot') handlers.onSnapshot(d.bids, d.asks);
          else if (msg.action === 'update') handlers.onDelta(d.bids, d.asks);
        }
      } else if (ch === 'trades') {
        for (const t of msg.data) {
          handlers.onTrade({
            ts: +t.ts,
            price: +t.px,
            qty: +t.sz,
            side: t.side, // "buy" | "sell"
          });
        }
      }
    };
    ws.onerror = (e) => handlers.onError(e);
    ws.onclose = (ev) => { if (pingTimer) clearInterval(pingTimer); handlers.onClose(ev); };
    return ws;
  }

  // Bitget V2 spot — books (snapshot+update) + trade.
  function connectBitget(symbol, handlers) {
    const url = 'wss://ws.bitget.com/v2/ws/public';
    const ws = new WebSocket(url);
    let pingTimer = null;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: [
          { instType: 'SPOT', channel: 'books', instId: symbol },
          { instType: 'SPOT', channel: 'trade', instId: symbol },
        ],
      }));
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, 20000);
      handlers.onOpen();
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.event) return;
      if (!msg.arg || !msg.data) return;
      const ch = msg.arg.channel;
      if (ch === 'books') {
        for (const d of msg.data) {
          if (msg.action === 'snapshot') handlers.onSnapshot(d.bids, d.asks);
          else if (msg.action === 'update') handlers.onDelta(d.bids, d.asks);
        }
      } else if (ch === 'trade') {
        for (const t of msg.data) {
          // Bitget V2 trade format: { ts, price, size, side, tradeId }
          handlers.onTrade({
            ts: +t.ts,
            price: +t.price,
            qty: +t.size,
            side: t.side, // "buy" | "sell"
          });
        }
      }
    };
    ws.onerror = (e) => handlers.onError(e);
    ws.onclose = (ev) => { if (pingTimer) clearInterval(pingTimer); handlers.onClose(ev); };
    return ws;
  }

  // BingX spot — gzip-compressed JSON frames. Subscribes via reqType=sub on
  // dataType=<SYM>@depth20 and <SYM>@trade. Server sends "Ping" (gzipped),
  // we reply with literal "Pong". BingX uses dash-delimited symbols, so
  // "BTCUSDT" becomes "BTC-USDT".
  function bingxSymbol(sym) {
    if (sym.endsWith('USDT')) return sym.slice(0, -4) + '-USDT';
    if (sym.endsWith('USDC')) return sym.slice(0, -4) + '-USDC';
    return sym;
  }
  function connectBingx(symbol, handlers) {
    if (typeof pako === 'undefined') {
      throw new Error('pako library failed to load — нужен интернет до cdn.jsdelivr.net');
    }
    const bxSym = bingxSymbol(symbol);
    const url = 'wss://open-api-ws.bingx.com/market';
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let nextId = 1;
    const send = (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };
    ws.onopen = () => {
      send({ id: 'sub-' + nextId++, reqType: 'sub', dataType: bxSym + '@depth20' });
      send({ id: 'sub-' + nextId++, reqType: 'sub', dataType: bxSym + '@trade' });
      handlers.onOpen();
    };
    ws.onmessage = (ev) => {
      // Frames are always gzip-compressed (binary). Inflate to a string.
      let text;
      try {
        const buf = new Uint8Array(ev.data);
        text = pako.inflate(buf, { to: 'string' });
      } catch (e) {
        return;
      }
      // Server keep-alive: it sends literal "Ping" (gzipped); we answer "Pong".
      if (text === 'Ping') { ws.send('Pong'); return; }
      let msg;
      try { msg = JSON.parse(text); } catch (_) { return; }
      if (!msg.dataType || !msg.data) return;
      if (msg.dataType.endsWith('@depth20') || msg.dataType.endsWith('@depth100') || msg.dataType.endsWith('@depth50')) {
        // Snapshot frame: { bids: [[p,q]...], asks: [...] }
        const bids = msg.data.bids || [];
        const asks = msg.data.asks || [];
        if (bids.length || asks.length) handlers.onSnapshot(bids, asks);
      } else if (msg.dataType.endsWith('@trade')) {
        const t = msg.data;
        // m=true → buyer is maker → SELL aggressor (Binance convention).
        handlers.onTrade({
          ts: +t.T || +t.E || Date.now(),
          price: +t.p,
          qty: +t.q,
          side: t.m ? 'sell' : 'buy',
        });
      }
    };
    ws.onerror = (e) => handlers.onError(e);
    ws.onclose = (ev) => handlers.onClose(ev);
    return ws;
  }

  // MEXC spot v3 — protobuf push. We subscribe to:
  //   spot@public.limit.depth.v3.api.pb@<SYMBOL>@20  (top-20 snapshot)
  //   spot@public.aggre.deals.v3.api.pb@10ms@<SYMBOL>  (aggregated trades)
  // Each frame is a binary PushDataV3ApiWrapper. Schema is defined inline
  // below — only the fields we actually consume are described (protobuf wire
  // format permits dropping unused fields).
  const MEXC_PROTO_SCHEMA = `
    syntax = "proto3";

    message PushDataV3ApiWrapper {
      string channel = 1;
      PublicDealsV3Api publicDeals = 301;
      PublicLimitDepthsV3Api publicLimitDepths = 303;
      PublicAggreDealsV3Api publicAggreDeals = 314;
      string symbol = 3;
      int64 sendTime = 6;
    }

    message PublicLimitDepthsV3Api {
      repeated PublicLimitDepthV3ApiItem asks = 1;
      repeated PublicLimitDepthV3ApiItem bids = 2;
      string eventType = 3;
      string version = 4;
    }
    message PublicLimitDepthV3ApiItem {
      string price = 1;
      string quantity = 2;
    }

    message PublicDealsV3Api {
      repeated PublicDealsV3ApiItem deals = 1;
      string eventType = 2;
    }
    message PublicDealsV3ApiItem {
      string price = 1;
      string quantity = 2;
      int32 tradeType = 3;
      int64 time = 4;
    }

    message PublicAggreDealsV3Api {
      repeated PublicAggreDealsV3ApiItem deals = 1;
      string eventType = 2;
    }
    message PublicAggreDealsV3ApiItem {
      string price = 1;
      string quantity = 2;
      int32 tradeType = 3;
      int64 time = 4;
    }
  `;
  let mexcWrapperType = null;
  function getMexcType() {
    if (mexcWrapperType) return mexcWrapperType;
    if (typeof protobuf === 'undefined') {
      throw new Error('protobufjs library failed to load — нужен интернет до cdn.jsdelivr.net');
    }
    const root = protobuf.parse(MEXC_PROTO_SCHEMA, { keepCase: true }).root;
    mexcWrapperType = root.lookupType('PushDataV3ApiWrapper');
    return mexcWrapperType;
  }
  function connectMexc(symbol, handlers) {
    const type = getMexcType();
    const url = 'wss://wbs-api.mexc.com/ws';
    const depthTopic = `spot@public.limit.depth.v3.api.pb@${symbol}@20`;
    const tradesTopic = `spot@public.aggre.deals.v3.api.pb@10ms@${symbol}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let pingTimer = null;
    ws.onopen = () => {
      ws.send(JSON.stringify({ method: 'SUBSCRIPTION', params: [depthTopic, tradesTopic] }));
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'PING' }));
      }, 20000);
      handlers.onOpen();
    };
    ws.onmessage = (ev) => {
      // Subscription ack and PONG come back as JSON text.
      if (typeof ev.data === 'string') {
        // Quietly ignore acks/pongs.
        return;
      }
      let msg;
      try {
        msg = type.decode(new Uint8Array(ev.data));
      } catch (e) {
        return;
      }
      const ch = msg.channel || '';
      if (ch.startsWith('spot@public.limit.depth') && msg.publicLimitDepths) {
        const d = msg.publicLimitDepths;
        const bids = (d.bids || []).map(it => [it.price, it.quantity]);
        const asks = (d.asks || []).map(it => [it.price, it.quantity]);
        if (bids.length || asks.length) handlers.onSnapshot(bids, asks);
      } else if (ch.startsWith('spot@public.aggre.deals') && msg.publicAggreDeals) {
        for (const t of (msg.publicAggreDeals.deals || [])) {
          // tradeType: 1 = buy aggressor, 2 = sell aggressor.
          const tt = +t.tradeType;
          handlers.onTrade({
            ts: +t.time || Date.now(),
            price: +t.price,
            qty: +t.quantity,
            side: tt === 1 ? 'buy' : 'sell',
          });
        }
      } else if (ch.startsWith('spot@public.deals') && msg.publicDeals) {
        for (const t of (msg.publicDeals.deals || [])) {
          const tt = +t.tradeType;
          handlers.onTrade({
            ts: +t.time || Date.now(),
            price: +t.price,
            qty: +t.quantity,
            side: tt === 1 ? 'buy' : 'sell',
          });
        }
      }
    };
    ws.onerror = (e) => handlers.onError(e);
    ws.onclose = (ev) => { if (pingTimer) clearInterval(pingTimer); handlers.onClose(ev); };
    return ws;
  }

  function connectExchange(exchange, symbol, handlers) {
    if (exchange === 'binance') return connectBinance(symbol, handlers);
    if (exchange === 'bybit')   return connectBybit(symbol, handlers);
    if (exchange === 'okx')     return connectOkx(symbol, handlers);
    if (exchange === 'bitget')  return connectBitget(symbol, handlers);
    if (exchange === 'mexc')    return connectMexc(symbol, handlers);
    if (exchange === 'bingx')   return connectBingx(symbol, handlers);
    throw new Error('Unsupported exchange: ' + exchange);
  }

  // ─── Refill / iceberg detector ─────────────────────────────────────────────
  // For each (side, price) we keep the most recent observed level size and
  // start a tracking record the moment a trade hits it. After REFILL_WINDOW_MS
  // we check whether the level has recovered to ≥ REFILL_RECOVER_PCT of its
  // pre-trade size; if so and the cumulative damage was ≥ REFILL_DAMAGE_PCT,
  // we emit an alert.

  function levelKey(side, price) { return side + '|' + price; }

  function noteLevelSizes(book) {
    // Update last-seen size for every visible level. Levels not in top-N stay
    // at their last value (which is fine — they're outside our refill scope).
    const top = book.topN(20);
    for (const [p, q] of top.bids) {
      const k = levelKey('bid', p);
      const t = state.levelTrack.get(k);
      if (t && t.pending) {
        t.lastSeenSize = q;
        t.lastSeenTs = Date.now();
      } else {
        state.levelTrack.set(k, { lastSeenSize: q, lastSeenTs: Date.now(), pending: false });
      }
    }
    for (const [p, q] of top.asks) {
      const k = levelKey('ask', p);
      const t = state.levelTrack.get(k);
      if (t && t.pending) {
        t.lastSeenSize = q;
        t.lastSeenTs = Date.now();
      } else {
        state.levelTrack.set(k, { lastSeenSize: q, lastSeenTs: Date.now(), pending: false });
      }
    }
  }

  function onTradeForRefill(trade) {
    // Trade side: "buy" = aggressor bought = ate ASK side at trade.price.
    // Trade side: "sell" = aggressor sold = ate BID side at trade.price.
    const side = trade.side === 'buy' ? 'ask' : 'bid';
    const k = levelKey(side, trade.price);
    let t = state.levelTrack.get(k);
    const now = Date.now();
    if (!t) {
      // No prior reading for this level — capture current snapshot.
      const cur = state.bookKeeper.sizeAt(side, trade.price);
      t = { lastSeenSize: cur + trade.qty, lastSeenTs: now, pending: false };
      state.levelTrack.set(k, t);
    }
    if (!t.pending) {
      t.pending = true;
      t.preTradeSize = t.lastSeenSize;
      t.cumulativeDamage = trade.qty;
      t.firstTradeTs = now;
      t.lastTradeTs = now;
      t.refTradePrice = trade.price;
      t.refSide = side;
    } else {
      t.cumulativeDamage += trade.qty;
      t.lastTradeTs = now;
    }
  }

  function checkPendingRefills() {
    const now = Date.now();
    const fired = [];
    for (const [key, t] of state.levelTrack) {
      if (!t.pending) continue;
      if (now - t.lastTradeTs < REFILL_WINDOW_MS) continue;
      // Window elapsed — evaluate.
      const cur = state.bookKeeper.sizeAt(t.refSide, t.refTradePrice);
      const recoveredPct = t.preTradeSize > 0 ? cur / t.preTradeSize : 0;
      const damagePct = t.preTradeSize > 0 ? t.cumulativeDamage / t.preTradeSize : 0;
      if (recoveredPct >= REFILL_RECOVER_PCT && damagePct >= REFILL_DAMAGE_PCT) {
        fired.push({
          ts: now,
          side: t.refSide,                // "ask" or "bid"
          price: t.refTradePrice,
          preSize: t.preTradeSize,
          curSize: cur,
          damage: t.cumulativeDamage,
          recoveredPct,
          damagePct,
        });
      }
      t.pending = false;
      t.preTradeSize = 0;
      t.cumulativeDamage = 0;
    }
    return fired;
  }

  // ─── Indicators ────────────────────────────────────────────────────────────
  function computeIndicators(book) {
    const top = book.topN(50);
    const bestBid = top.bids[0];
    const bestAsk = top.asks[0];
    if (!bestBid || !bestAsk) return null;
    const bidPrice = bestBid[0], bidSize = bestBid[1];
    const askPrice = bestAsk[0], askSize = bestAsk[1];
    const mid = (bidPrice + askPrice) / 2;
    const spreadAbs = askPrice - bidPrice;
    const spreadBps = mid > 0 ? (spreadAbs / mid) * 10000 : 0;
    // Microprice — biased mid weighted by opposite side size.
    const totalTopSize = bidSize + askSize;
    const microprice = totalTopSize > 0
      ? (bidPrice * askSize + askPrice * bidSize) / totalTopSize
      : mid;
    // Imbalance ±10 bps.
    const bandLow = mid * (1 - 0.0010);
    const bandHigh = mid * (1 + 0.0010);
    let bidVol = 0, askVol = 0;
    for (const [p, q] of top.bids) if (p >= bandLow) bidVol += q * p; else break;
    for (const [p, q] of top.asks) if (p <= bandHigh) askVol += q * p; else break;
    const total = bidVol + askVol;
    const imbalance = total > 0 ? (bidVol - askVol) / total : 0;
    return { bidPrice, askPrice, mid, spreadAbs, spreadBps, microprice, imbalance, bidVol, askVol };
  }

  function appendCvd(trade) {
    const signedQty = trade.side === 'buy' ? trade.qty : -trade.qty;
    const signedNotional = signedQty * trade.price;
    state.cvdBuf.push({ ts: trade.ts || Date.now(), signedQty, signedNotional });
    // Drop entries older than 15 minutes.
    const cutoff = Date.now() - 15 * 60 * 1000;
    while (state.cvdBuf.length && state.cvdBuf[0].ts < cutoff) state.cvdBuf.shift();
  }

  function cvdWindow(ms) {
    const cutoff = Date.now() - ms;
    let n = 0;
    for (let i = state.cvdBuf.length - 1; i >= 0; i--) {
      if (state.cvdBuf[i].ts < cutoff) break;
      n += state.cvdBuf[i].signedNotional;
    }
    return n;
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────
  function renderBook() {
    const book = state.bookKeeper;
    if (!book) return;
    const { bids, asks } = book.topN(20);
    if (!bids.length || !asks.length) return;
    let maxBid = 0, maxAsk = 0;
    for (const [, q] of bids) if (q > maxBid) maxBid = q;
    for (const [, q] of asks) if (q > maxAsk) maxAsk = q;
    const maxSide = Math.max(maxBid, maxAsk) || 1;
    let html = '<div class="book-side book-asks">';
    // Asks rendered top-down with worst (highest) first → best ask just above mid.
    for (let i = asks.length - 1; i >= 0; i--) {
      const [p, q] = asks[i];
      const w = (q / maxSide) * 100;
      html += `<div class="book-row ask"><span class="book-bar" style="width:${w.toFixed(1)}%"></span><span class="book-price">${fmtPrice(p)}</span><span class="book-size">${fmtSize(q)}</span><span class="book-notional">${fmtUsd(p * q)}</span></div>`;
    }
    html += '</div>';
    const top = book.topN(1);
    const bestBid = top.bids[0], bestAsk = top.asks[0];
    if (bestBid && bestAsk) {
      const mid = (bestBid[0] + bestAsk[0]) / 2;
      const spread = bestAsk[0] - bestBid[0];
      const bps = (spread / mid) * 10000;
      html += `<div class="book-mid"><span>spread</span><b>${fmtPrice(spread)}</b><span>(${bps.toFixed(2)} bps)</span></div>`;
    }
    html += '<div class="book-side book-bids">';
    for (const [p, q] of bids) {
      const w = (q / maxSide) * 100;
      html += `<div class="book-row bid"><span class="book-bar" style="width:${w.toFixed(1)}%"></span><span class="book-price">${fmtPrice(p)}</span><span class="book-size">${fmtSize(q)}</span><span class="book-notional">${fmtUsd(p * q)}</span></div>`;
    }
    html += '</div>';
    $('ms-book').innerHTML = html;
    $('ms-book-meta').textContent = `${state.exchange.toUpperCase()} ${state.symbol}`;
  }

  function renderTape() {
    const minNotional = +($('ms-tape-min').value || 0);
    let html = '';
    let shown = 0;
    for (const t of state.tapeBuf) {
      const notional = t.price * t.qty;
      if (notional < minNotional) continue;
      const sideCls = t.side === 'buy' ? 'tape-buy' : 'tape-sell';
      const sizeCls = notional >= 100000 ? 'tape-big-100' : notional >= 10000 ? 'tape-big-10' : '';
      html += `<div class="tape-row ${sideCls} ${sizeCls}"><span class="tape-time">${timeStr(t.ts)}</span><span class="tape-price">${fmtPrice(t.price)}</span><span class="tape-size">${fmtSize(t.qty)}</span><span class="tape-notional">${fmtUsd(notional)}</span></div>`;
      shown++;
      if (shown >= 80) break;
    }
    $('ms-tape').innerHTML = html || '<div class="tape-empty">Нет сделок проходящих фильтр…</div>';
    $('ms-tape-meta').textContent = `${state.tapeBuf.length} последних, ${shown} в фильтре`;
  }

  function renderIndicators(ind) {
    if (!ind) return;
    $('ms-spread').innerHTML = `${fmtPrice(ind.spreadAbs)} <span class="metric-sub">${fmtBps(ind.spreadBps)}</span>`;
    $('ms-microprice').innerHTML = `${fmtPrice(ind.microprice)} <span class="metric-sub">mid ${fmtPrice(ind.mid)}</span>`;
    const imbCls = ind.imbalance >= 0.15 ? 'green' : ind.imbalance <= -0.15 ? 'red' : '';
    $('ms-imbalance').className = 'metric-value ' + imbCls;
    $('ms-imbalance').innerHTML = `${fmtPct(ind.imbalance)} <span class="metric-sub">bid ${fmtUsd(ind.bidVol)} / ask ${fmtUsd(ind.askVol)}</span>`;
    const c1 = cvdWindow(60 * 1000);
    const c5 = cvdWindow(5 * 60 * 1000);
    const c15 = cvdWindow(15 * 60 * 1000);
    function cvCls(v) { return v > 0 ? 'green' : v < 0 ? 'red' : ''; }
    $('ms-cvd').innerHTML =
      `<span class="${cvCls(c1)}">${fmtUsd(c1)}</span> / ` +
      `<span class="${cvCls(c5)}">${fmtUsd(c5)}</span> / ` +
      `<span class="${cvCls(c15)}">${fmtUsd(c15)}</span>`;
  }

  function renderAlerts() {
    if (!state.alerts.length) {
      $('ms-alerts').innerHTML = '<div class="alerts-empty">Алерты появятся при обнаружении iceberg / refill паттернов на стакане.</div>';
      $('ms-alerts-meta').textContent = '0 событий';
      return;
    }
    let html = '';
    for (const a of state.alerts) {
      const sideText = a.side === 'ask' ? 'ASK (sell wall)' : 'BID (buy wall)';
      const sideCls = a.side === 'ask' ? 'alert-ask' : 'alert-bid';
      const recoverPct = (a.recoveredPct * 100).toFixed(0);
      const damagePct = (a.damagePct * 100).toFixed(0);
      html += `<div class="alert-row ${sideCls}">
        <div class="alert-head">
          <span class="alert-time">${timeStr(a.ts)}</span>
          <span class="alert-tag">ALGO REFILL</span>
          <span class="alert-side">${sideText}</span>
        </div>
        <div class="alert-body">
          <span>@ <b>${fmtPrice(a.price)}</b></span>
          <span>${fmtSize(a.preSize)} → проедено ${damagePct}% → восстановлено ${recoverPct}% (${fmtSize(a.curSize)})</span>
        </div>
      </div>`;
    }
    $('ms-alerts').innerHTML = html;
    $('ms-alerts-meta').textContent = state.alerts.length + ' событий';
  }

  // ─── Alert side-effects ────────────────────────────────────────────────────
  function beep() {
    if (!$('ms-sound').checked) return;
    try {
      if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = state.audioCtx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.05;
      o.start();
      o.stop(ctx.currentTime + 0.12);
    } catch (_) { /* ignore */ }
  }

  function browserNotify(text) {
    if (!$('ms-notify').checked) return;
    if (Date.now() - state.lastNotifTs < NOTIF_COOLDOWN_MS) return;
    state.lastNotifTs = Date.now();
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') new Notification('Metascalp', { body: text });
    else if (Notification.permission !== 'denied') Notification.requestPermission();
  }

  function telegramNotify(text) {
    const url = ($('ms-tg-webhook').value || '').trim();
    if (!url) return;
    // Telegram bot URL convention: append &text=... to a sendMessage URL.
    const sep = url.includes('?') ? '&' : '?';
    const final = url + sep + 'text=' + encodeURIComponent(text);
    fetch(final, { method: 'GET' }).catch(() => { /* ignore */ });
  }

  function fireAlert(a) {
    state.alerts.unshift(a);
    if (state.alerts.length > ALERTS_MAX) state.alerts.length = ALERTS_MAX;
    renderAlerts();
    const text = `ALGO REFILL ${a.side === 'ask' ? 'sell wall' : 'buy wall'} @ ${fmtPrice(a.price)} on ${state.exchange.toUpperCase()} ${state.symbol} — ${(a.recoveredPct * 100).toFixed(0)}% recovered`;
    beep();
    browserNotify(text);
    telegramNotify(text);
  }

  // ─── Wiring ────────────────────────────────────────────────────────────────
  function setStatus(text, ok) {
    const el = $('ms-status');
    el.textContent = text;
    el.className = 'metascalp-status' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }

  function disconnect() {
    if (state.refillTimer) { clearInterval(state.refillTimer); state.refillTimer = null; }
    if (state.ws) {
      try { state.ws.onclose = null; state.ws.close(); } catch (_) {}
      state.ws = null;
    }
    $('ms-connect-btn').textContent = '▶ Подключить';
    $('ms-connect-btn').classList.remove('connected');
  }

  function connect() {
    disconnect();
    const exEl = document.querySelector('input[name="ms-exchange"]:checked');
    const exchange = exEl ? exEl.value : 'binance';
    const baseSymbol = (window.arbSelectedSymbol || 'BTC').toUpperCase();
    const symbol = baseSymbol + 'USDT';

    state.exchange = exchange;
    state.symbol = symbol;
    state.bookKeeper = new OrderBook();
    state.tapeBuf = [];
    state.cvdBuf = [];
    state.alerts = [];
    state.levelTrack.clear();

    $('ms-metrics').hidden = false;
    $('ms-grid').hidden = false;
    setStatus(`Подключаюсь к ${exchange.toUpperCase()} ${symbol}…`);

    const handlers = {
      onOpen() {
        setStatus(`Подключено к ${exchange.toUpperCase()} ${symbol}`, true);
        $('ms-connect-btn').textContent = '◼ Отключить';
        $('ms-connect-btn').classList.add('connected');
      },
      onSnapshot(bids, asks) {
        state.bookKeeper.snapshot(bids, asks);
        noteLevelSizes(state.bookKeeper);
        renderBook();
        const ind = computeIndicators(state.bookKeeper);
        if (ind) renderIndicators(ind);
      },
      onDelta(bids, asks) {
        state.bookKeeper.delta(bids, asks);
        noteLevelSizes(state.bookKeeper);
        renderBook();
        const ind = computeIndicators(state.bookKeeper);
        if (ind) renderIndicators(ind);
      },
      onTrade(trade) {
        state.tapeBuf.unshift(trade);
        if (state.tapeBuf.length > TAPE_MAX) state.tapeBuf.length = TAPE_MAX;
        appendCvd(trade);
        onTradeForRefill(trade);
        renderTape();
        // CVD numbers only — full indicators recompute on book updates.
        const ind = computeIndicators(state.bookKeeper);
        if (ind) renderIndicators(ind);
      },
      onError(e) {
        console.warn('[metascalp]', exchange, 'ws error', e);
        setStatus(`Ошибка соединения с ${exchange.toUpperCase()}`, false);
      },
      onClose(ev) {
        setStatus(`Соединение закрыто (${ev && ev.code ? ev.code : 'no code'})`, false);
        $('ms-connect-btn').textContent = '▶ Подключить';
        $('ms-connect-btn').classList.remove('connected');
      },
    };

    try {
      state.ws = connectExchange(exchange, symbol, handlers);
    } catch (e) {
      setStatus('Не удалось открыть стрим: ' + e.message, false);
      return;
    }

    state.refillTimer = setInterval(() => {
      const events = checkPendingRefills();
      for (const e of events) fireAlert(e);
    }, 500);
  }

  // ─── Init when DOM is ready ────────────────────────────────────────────────
  function init() {
    if (!$('ms-connect-btn')) return; // not on this page yet
    $('ms-connect-btn').addEventListener('click', () => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) disconnect();
      else connect();
    });
    $('ms-tape-min').addEventListener('change', renderTape);
    $('ms-notify').addEventListener('change', () => {
      if ($('ms-notify').checked && 'Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission();
      }
    });
    // Persist Telegram webhook URL across reloads.
    const saved = localStorage.getItem('ms-tg-webhook');
    if (saved) $('ms-tg-webhook').value = saved;
    $('ms-tg-webhook').addEventListener('change', () => {
      localStorage.setItem('ms-tg-webhook', $('ms-tg-webhook').value || '');
    });

    // Reconnect when the user picks a different coin while we're streaming.
    document.addEventListener('input', (e) => {
      if (!e.target || e.target.id !== 'global-coin-input') return;
      // Coin selection actually fires through the combo's onSelect callback;
      // we hook into that via a periodic check on arbSelectedSymbol.
    });
    let lastSym = window.arbSelectedSymbol;
    setInterval(() => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      if (window.arbSelectedSymbol !== lastSym) {
        lastSym = window.arbSelectedSymbol;
        connect();
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
