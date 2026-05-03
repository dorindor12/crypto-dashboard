// app.js — Main application logic

// ─── STATE ───────────────────────────────────────────────────────────────────
let spreadHistory = [];
let spreadChartInst = null;
let scamPriceChartInst = null;
let scamVolChartInst = null;
let autoRefreshTimer = null;

// ─── TABS ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
  });
});

// ─── UTILS ────────────────────────────────────────────────────────────────────
function fmtPrice(price, symbol) {
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 100) return price.toFixed(3);
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtVol(vol) {
  if (vol >= 1e9) return '$' + (vol / 1e9).toFixed(1) + 'B';
  if (vol >= 1e6) return '$' + (vol / 1e6).toFixed(0) + 'M';
  if (vol >= 1e3) return '$' + (vol / 1e3).toFixed(0) + 'K';
  return '$' + vol.toFixed(0);
}

function fmtPct(pct) {
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
}

function setConnected(ok, msg) {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  dot.className = 'live-dot ' + (ok ? 'connected' : 'error');
  label.textContent = ok ? 'Подключено' : (msg || 'Ошибка');
  document.getElementById('last-update').textContent =
    new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── ARBITRAGE ────────────────────────────────────────────────────────────────
async function fetchAll() {
  const symbol = document.getElementById('coin-select').value;
  const tbody = document.getElementById('arb-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Загружаем данные с бирж...</td></tr>';

  document.getElementById('arb-signal').className = 'signal-box hidden';

  try {
    const results = await API.getAllPrices(symbol);
    if (results.length === 0) throw new Error('Нет данных');

    setConnected(true);
    renderArbTable(results, symbol);
  } catch (e) {
    setConnected(false, 'Ошибка API');
    tbody.innerHTML = `<tr><td colspan="6" class="loading-cell error-msg">
      Ошибка загрузки: ${e.message}.<br>
      <small>Проверь интернет-соединение или запусти через локальный прокси.</small>
    </td></tr>`;
  }
}

function renderArbTable(results, symbol) {
  const minFilter = parseFloat(document.getElementById('spread-filter').value || '0');

  // Sort by price ascending
  results.sort((a, b) => a.price - b.price);
  const minPrice = results[0].price;
  const maxPrice = results[results.length - 1].price;
  const maxSpread = ((maxPrice - minPrice) / minPrice) * 100;

  // Update metrics
  document.getElementById('m-maxspread').textContent = maxSpread.toFixed(3) + '%';
  document.getElementById('m-maxspread').className = 'metric-value ' + (maxSpread > 1 ? 'green' : '');
  document.getElementById('m-minprice').textContent = '$' + fmtPrice(minPrice);
  document.getElementById('m-maxprice').textContent = '$' + fmtPrice(maxPrice);
  document.getElementById('m-exchanges').textContent = results.length;

  // Signal
  const signalBox = document.getElementById('arb-signal');
  if (maxSpread > 1.5) {
    signalBox.className = 'signal-box red';
    signalBox.textContent = `⚡ Горячий арбитраж: спред ${maxSpread.toFixed(2)}% между ${results[0].exchange} и ${results[results.length-1].exchange}`;
  } else if (maxSpread > 0.5) {
    signalBox.className = 'signal-box amber';
    signalBox.textContent = `⬆ Умеренный спред ${maxSpread.toFixed(2)}% — следи за динамикой`;
  } else {
    signalBox.className = 'signal-box green';
    signalBox.textContent = `✓ Спред низкий: ${maxSpread.toFixed(2)}% — рынок выровнен`;
  }

  // Table rows
  const filtered = results.filter(r => {
    const sp = ((r.price - minPrice) / minPrice) * 100;
    return sp >= minFilter;
  });

  const tbody = document.getElementById('arb-tbody');
  tbody.innerHTML = filtered.map((r, i) => {
    const spread = ((r.price - minPrice) / minPrice) * 100;
    const barW = Math.min(100, spread * 50);
    const isMin = i === 0;
    const isMax = r.price === maxPrice;

    const spreadColor = spread > 1 ? '#1D9E75' : spread > 0.5 ? '#EF9F27' : '#555a6a';
    const changeClass = r.change24h >= 0 ? 'change-pos' : 'change-neg';
    const badge = isMin
      ? '<span class="badge badge-best">мин.</span>'
      : isMax
        ? '<span class="badge badge-hot">макс.</span>'
        : spread > 1
          ? '<span class="badge badge-mid">арбитраж</span>'
          : '<span class="badge badge-low">—</span>';

    return `<tr>
      <td><span class="exchange-name">${r.exchange}</span></td>
      <td><span class="price-cell">$${fmtPrice(r.price)}</span></td>
      <td>
        <div class="spread-cell">
          <div class="spread-bar-bg">
            <div class="spread-bar-fill" style="width:${barW}%;background:${spreadColor};"></div>
          </div>
          <span class="spread-val" style="color:${spreadColor};">${spread.toFixed(3)}%</span>
        </div>
      </td>
      <td class="${changeClass}">${fmtPct(r.change24h)}</td>
      <td style="color:#555a6a;">${fmtVol(r.volume24h)}</td>
      <td>${badge}</td>
    </tr>`;
  }).join('');

  // Update spread history chart
  spreadHistory.push({ t: Date.now(), v: maxSpread });
  if (spreadHistory.length > 30) spreadHistory.shift();
  updateSpreadChart();
}

function updateSpreadChart() {
  if (!spreadChartInst) {
    const ctx = document.getElementById('spreadChart').getContext('2d');
    spreadChartInst = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [{
          label: 'Макс. спред %',
          data: [],
          borderColor: '#5B8AF0',
          backgroundColor: 'rgba(91,138,240,0.08)',
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: '#5B8AF0',
          fill: true,
          borderWidth: 1.5,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'minute', displayFormats: { minute: 'HH:mm' } },
            ticks: { color: '#555a6a', font: { size: 11 } },
            grid: { color: 'rgba(255,255,255,0.04)' },
          },
          y: {
            ticks: { color: '#555a6a', font: { size: 11 }, callback: v => v.toFixed(2) + '%' },
            grid: { color: 'rgba(255,255,255,0.04)' },
          }
        }
      }
    });
  }

  spreadChartInst.data.datasets[0].data = spreadHistory.map(p => ({ x: p.t, y: p.v }));
  spreadChartInst.update('none');
}

// ─── SCAM PATTERN ────────────────────────────────────────────────────────────
async function fetchScamData() {
  const coinId = document.getElementById('scam-coin-select').value;
  const days = parseInt(document.getElementById('scam-days').value);

  document.getElementById('sm-cycles').textContent = '...';
  document.getElementById('sm-maxpump').textContent = '...';
  document.getElementById('sm-maxdump').textContent = '...';
  document.getElementById('sm-phase').textContent = '...';
  document.getElementById('scam-signal').className = 'signal-box hidden';

  try {
    const data = await API.getCoinHistory(coinId, days);
    setConnected(true);
    analyzeAndRender(data, days);
  } catch (e) {
    setConnected(false, 'Ошибка CoinGecko');
    console.error(e);
    document.getElementById('scam-signal').className = 'signal-box red';
    document.getElementById('scam-signal').textContent = 'Ошибка загрузки: ' + e.message;
  }
}

function analyzeAndRender(data, days) {
  const prices = data.prices;
  const volumes = data.volumes;

  if (!prices.length) return;

  // ── Detect pump & dump cycles ──────────────────────────────────────────────
  const priceVals = prices.map(p => p.v);
  const volVals = volumes.map(v => v.v);

  // Find local maxima and minima (pump tops and dump bottoms)
  const cycles = [];
  let maxPump = 0;
  let maxDump = 0;

  for (let i = 3; i < priceVals.length - 3; i++) {
    const isLocalMax = priceVals[i] > priceVals[i-1] && priceVals[i] > priceVals[i+1]
                    && priceVals[i] > priceVals[i-2] && priceVals[i] > priceVals[i+2];
    if (isLocalMax) {
      // Look back for the start of this pump
      let startIdx = i;
      for (let j = i - 1; j >= Math.max(0, i - 14); j--) {
        if (priceVals[j] < priceVals[startIdx]) startIdx = j;
      }
      const pumpPct = ((priceVals[i] - priceVals[startIdx]) / priceVals[startIdx]) * 100;
      if (pumpPct > 8) {
        // Look forward for the dump
        let dumpIdx = i;
        for (let j = i + 1; j < Math.min(priceVals.length, i + 14); j++) {
          if (priceVals[j] < priceVals[dumpIdx]) dumpIdx = j;
        }
        const dumpPct = ((priceVals[dumpIdx] - priceVals[i]) / priceVals[i]) * 100;
        if (Math.abs(dumpPct) > 5) {
          cycles.push({ peakIdx: i, startIdx, dumpIdx, pumpPct, dumpPct });
          if (pumpPct > maxPump) maxPump = pumpPct;
          if (Math.abs(dumpPct) > maxDump) maxDump = Math.abs(dumpPct);
        }
      }
    }
  }

  // Determine current phase
  const last = priceVals.length - 1;
  const recentWindow = Math.min(5, priceVals.length - 1);
  const recentChange = ((priceVals[last] - priceVals[last - recentWindow]) / priceVals[last - recentWindow]) * 100;
  const recentVolAvg = volVals.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const overallVolAvg = volVals.reduce((a, b) => a + b, 0) / volVals.length;
  const volRatio = recentVolAvg / overallVolAvg;

  let phase, phaseClass;
  if (recentChange > 15 && volRatio > 1.5) {
    phase = '🔴 Pump'; phaseClass = 'red';
  } else if (recentChange < -10 && volRatio > 1.2) {
    phase = '🟠 Dump'; phaseClass = 'amber';
  } else if (recentChange < -5) {
    phase = '🟡 Распродажа'; phaseClass = 'amber';
  } else if (volRatio > 1.3 && Math.abs(recentChange) < 5) {
    phase = '🟢 Накопление'; phaseClass = 'green';
  } else {
    phase = '⚪ Боковик'; phaseClass = '';
  }

  // Update metrics
  document.getElementById('sm-cycles').textContent = cycles.length;
  document.getElementById('sm-maxpump').textContent = '+' + maxPump.toFixed(1) + '%';
  document.getElementById('sm-maxdump').textContent = '-' + maxDump.toFixed(1) + '%';
  document.getElementById('sm-phase').textContent = phase;
  document.getElementById('sm-phase').className = 'metric-value ' + phaseClass;

  // Signal
  const signalBox = document.getElementById('scam-signal');
  if (phaseClass === 'red') {
    signalBox.className = 'signal-box red';
    signalBox.textContent = '⚡ Внимание: признаки активного памп-цикла — объём и цена резко растут';
  } else if (cycles.length > 3) {
    signalBox.className = 'signal-box amber';
    signalBox.textContent = `⚠ Обнаружено ${cycles.length} повторяющихся pump & dump циклов за период`;
  } else {
    signalBox.className = 'signal-box green';
    signalBox.textContent = `✓ Паттернов памп-дамп не обнаружено (${cycles.length} незначительных цикла)`;
  }

  // Render charts
  renderScamPriceChart(prices, cycles);
  renderScamVolChart(volumes, cycles);
}

function renderScamPriceChart(prices, cycles) {
  if (scamPriceChartInst) scamPriceChartInst.destroy();

  // Build background zones for pump/dump areas
  const annotations = {};
  cycles.forEach((c, i) => {
    annotations['pump_' + i] = {
      type: 'box',
      xMin: prices[c.startIdx].t,
      xMax: prices[c.peakIdx].t,
      backgroundColor: 'rgba(29,158,117,0.08)',
      borderColor: 'rgba(29,158,117,0.2)',
      borderWidth: 1,
    };
    if (c.dumpIdx < prices.length) {
      annotations['dump_' + i] = {
        type: 'box',
        xMin: prices[c.peakIdx].t,
        xMax: prices[c.dumpIdx].t,
        backgroundColor: 'rgba(216,90,48,0.08)',
        borderColor: 'rgba(216,90,48,0.2)',
        borderWidth: 1,
      };
    }
  });

  const ctx = document.getElementById('scamPriceChart').getContext('2d');
  scamPriceChartInst = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Цена USD',
        data: prices.map(p => ({ x: p.t, y: p.v })),
        borderColor: '#378ADD',
        backgroundColor: 'rgba(55,138,221,0.06)',
        tension: 0.3,
        pointRadius: 0,
        fill: true,
        borderWidth: 1.5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => 'Цена: $' + ctx.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day', displayFormats: { day: 'd MMM' } },
          ticks: { color: '#555a6a', font: { size: 11 } },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
        y: {
          ticks: {
            color: '#555a6a', font: { size: 11 },
            callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(1)+'K' : v >= 1 ? v.toFixed(2) : v.toFixed(4))
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
        }
      }
    }
  });

  // Draw pump/dump zones manually via plugin since annotation plugin not loaded
  // (keeping it simple without extra dependency)
}

function renderScamVolChart(volumes, cycles) {
  if (scamVolChartInst) scamVolChartInst.destroy();

  const avgVol = volumes.reduce((a, b) => a + b.v, 0) / volumes.length;
  const colors = volumes.map(v => {
    const isPumpZone = cycles.some(c =>
      v.t >= volumes[Math.max(0, c.startIdx)].t && v.t <= (volumes[c.peakIdx] || { t: 0 }).t
    );
    const isDumpZone = cycles.some(c =>
      v.t > (volumes[c.peakIdx] || { t: Infinity }).t && v.t <= (volumes[Math.min(volumes.length-1, c.dumpIdx)] || { t: 0 }).t
    );
    if (v.v > avgVol * 2) return '#D85A30';
    if (v.v > avgVol * 1.5) return '#EF9F27';
    return '#378ADD';
  });

  const ctx = document.getElementById('scamVolChart').getContext('2d');
  scamVolChartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      datasets: [{
        label: 'Объём',
        data: volumes.map(v => ({ x: v.t, y: v.v })),
        backgroundColor: colors,
        borderRadius: 2,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => 'Объём: ' + (ctx.parsed.y / 1e6).toFixed(1) + 'M'
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day', displayFormats: { day: 'd MMM' } },
          ticks: { color: '#555a6a', font: { size: 11 }, maxTicksLimit: 10 },
          grid: { display: false },
        },
        y: {
          ticks: { color: '#555a6a', font: { size: 11 }, callback: v => (v/1e6).toFixed(0)+'M' },
          grid: { color: 'rgba(255,255,255,0.04)' },
        }
      }
    }
  });
}

// ─── AUTO REFRESH ─────────────────────────────────────────────────────────────
function startAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    const activeTab = document.querySelector('.tab-section.active');
    if (activeTab && activeTab.id === 'tab-arbitrage') fetchAll();
  }, 30000); // every 30 seconds
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  fetchAll();
  startAutoRefresh();

  document.getElementById('coin-select').addEventListener('change', fetchAll);
  document.getElementById('spread-filter').addEventListener('change', fetchAll);
  document.getElementById('scam-coin-select').addEventListener('change', fetchScamData);
  document.getElementById('scam-days').addEventListener('change', fetchScamData);
});
