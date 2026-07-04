// Vercel serverless function: proxies ChartInspect's on-chain API so the
// CHARTINSPECT_API_KEY never reaches the browser. Reproduces the original
// artifact's exact post-processing pipeline for these indicators:
//   Sharpe:            sharpe_average -> 14d causal EMA -> expanding no-lookahead
//                      median/MAD z-score (365d warm-up) -> sign-flip
//   Cost Basis P/L:    log(unrealized_profit_usd / unrealized_loss_usd)
//                      -> 7d causal EMA -> expanding no-lookahead median/MAD
//                      z-score (365d warm-up) -> sign-flip
//   On-Chain Risk:     onchain-risk-composite's `risk` field -> 7d causal EMA
//                      -> same expanding no-lookahead median/MAD z-score -> sign-flip
// Sign-flip convention matches the rest of the app: + = buy/cheap, - = sell/expensive.
//
// Also returns a `priceByMs` series from ChartInspect's dedicated OHLCV
// price endpoint (/api/v1/crypto/prices/BTC) -- so the app can use
// ChartInspect as its single data source for both price and indicators,
// instead of a separate free-API price chain. If that dedicated endpoint
// fails for some reason, falls back to the `btc_price` field bundled with
// the on-chain metric responses (fetched anyway), and only falls back to
// the client's free Bitstamp/Binance/CoinGecko chain if ChartInspect itself
// is unreachable entirely.

const CHARTINSPECT_BASE = "https://chartinspect.com/api/v1/onchain";
const CHARTINSPECT_PRICE_URL = "https://chartinspect.com/api/v1/crypto/prices/BTC";
const SHARPE_EMA_SPAN = 14;
const CBPL_EMA_SPAN = 7;
const RISK_EMA_SPAN = 7;
const ZSCORE_WARMUP_DAYS = 365;
const HISTORY_DAYS = 6000; // ask for as much as exists; ChartInspect returns whatever it actually has
const CACHE_MS = 60 * 60 * 1000; // 1 hour -- these are daily-resolution metrics, no need to refetch more often

function emaSeries(values, span) {
  const k = 2 / (span + 1);
  const out = new Array(values.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { out[i] = prev; continue; }
    prev = Number.isFinite(prev) ? v * k + prev * (1 - k) : v;
    out[i] = prev;
  }
  return out;
}

function expandingRobustZ(values, warmup) {
  // No-lookahead expanding median/MAD z-score: the score at index i is
  // computed only from values[0..i], so it never uses future information.
  const n = values.length;
  const sorted = [];
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
      sorted.splice(lo, 0, v);
    }
    if (sorted.length < Math.min(warmup, 20)) continue;
    const m = sorted.length;
    const med = m % 2 ? sorted[(m - 1) / 2] : (sorted[m / 2 - 1] + sorted[m / 2]) / 2;
    const devs = sorted.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
    const dm = devs.length % 2 ? devs[(devs.length - 1) / 2] : (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2;
    const scale = (dm || 1e-9) * 1.4826;
    out[i] = Math.max(-3, Math.min(3, (v - med) / scale));
  }
  return out;
}

function dayMsFromDateStr(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

async function fetchChartInspect(metric, apiKey) {
  const url = `${CHARTINSPECT_BASE}/${metric}?chain=bitcoin&days=${HISTORY_DAYS}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(`ChartInspect ${metric} fetch failed (HTTP ${res.status}).`);
  const json = await res.json();
  if (!json.success || !Array.isArray(json.data)) throw new Error(`Unexpected ChartInspect ${metric} response.`);
  return json.data;
}

async function fetchChartInspectPrice(apiKey) {
  // Dedicated OHLCV price endpoint -- separate from the on-chain metric
  // endpoints above, and likely deeper history than their bundled
  // btc_price field, since price reconstruction is simpler than the
  // composite on-chain metrics that also use this "days" parameter.
  const url = `${CHARTINSPECT_PRICE_URL}?days=${HISTORY_DAYS}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(`ChartInspect price fetch failed (HTTP ${res.status}).`);
  const json = await res.json();
  if (!json.success || !Array.isArray(json.data)) throw new Error("Unexpected ChartInspect price response.");
  const priceByMs = {};
  for (const row of json.data) {
    const close = Number(row.close);
    const ts = Number(row.timestamp);
    if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(ts)) continue;
    const d = new Date(ts * 1000);
    const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    priceByMs[dayMs] = close;
  }
  return priceByMs;
}

function buildZByMs(rows, valueFn, emaSpan) {
  rows.sort((a, b) => dayMsFromDateStr(a.date) - dayMsFromDateStr(b.date));
  const raw = rows.map(valueFn);
  const smoothed = emaSeries(raw, emaSpan);
  const zRaw = expandingRobustZ(smoothed, ZSCORE_WARMUP_DAYS);
  const zByMs = {};
  rows.forEach((r, i) => {
    const z = zRaw[i];
    if (Number.isFinite(z)) zByMs[dayMsFromDateStr(r.date)] = -z; // sign-flip: + = buy/cheap
  });
  return zByMs;
}

function mergePriceByMs(target, rows) {
  for (const r of rows) {
    const close = Number(r.btc_price ?? r.price);
    if (!Number.isFinite(close) || close <= 0) continue;
    target[dayMsFromDateStr(r.date)] = close;
  }
}

let cache = { at: 0, body: null };

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (cache.body && Date.now() - cache.at < CACHE_MS) {
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
      return res.status(200).json(cache.body);
    }

    const apiKey = process.env.CHARTINSPECT_API_KEY;
    if (!apiKey) throw new Error("Server misconfigured: CHARTINSPECT_API_KEY is not set.");

    const [sharpeRows, cbplRows, riskRows, priceResult] = await Promise.all([
      fetchChartInspect("realized-pl-sharpe-ratio", apiKey),
      fetchChartInspect("relative-unrealized-pl", apiKey),
      fetchChartInspect("onchain-risk-composite", apiKey),
      fetchChartInspectPrice(apiKey).catch((e) => {
        console.warn("ChartInspect dedicated price endpoint failed; will fall back to bundled btc_price fields.", e);
        return null;
      }),
    ]);

    // ---- Sharpe ----
    const sharpeZByMs = buildZByMs(sharpeRows, (r) => Number(r.sharpe_average), SHARPE_EMA_SPAN);

    // ---- Cost Basis P/L ----
    // log(profit/loss); the 121 known $0-loss days (undefined ratio) get
    // patched to the max finite log-ratio seen elsewhere in the series,
    // same handling as the original artifact.
    cbplRows.sort((a, b) => dayMsFromDateStr(a.date) - dayMsFromDateStr(b.date));
    const cbplLogRatio = cbplRows.map((r) => {
      const profit = Number(r.unrealized_profit_usd);
      const loss = Number(r.unrealized_loss_usd);
      if (!Number.isFinite(profit) || !Number.isFinite(loss) || loss <= 0) return NaN;
      const ratio = profit / loss;
      return Number.isFinite(ratio) && ratio > 0 ? Math.log(ratio) : NaN;
    });
    const finiteLogRatios = cbplLogRatio.filter(Number.isFinite);
    const maxFiniteLogRatio = finiteLogRatios.length ? Math.max(...finiteLogRatios) : 0;
    const cbplPatched = cbplLogRatio.map((v) => (Number.isFinite(v) ? v : maxFiniteLogRatio));
    const cbplSmoothed = emaSeries(cbplPatched, CBPL_EMA_SPAN);
    const cbplZRaw = expandingRobustZ(cbplSmoothed, ZSCORE_WARMUP_DAYS);
    const cbplZByMs = {};
    cbplRows.forEach((r, i) => {
      const z = cbplZRaw[i];
      if (Number.isFinite(z)) cbplZByMs[dayMsFromDateStr(r.date)] = -z;
    });

    // ---- On-Chain Risk Composite ----
    // ChartInspect's own `risk` field is already a composite score; high
    // risk = expensive/sell, so it gets the same sign-flip as the others.
    const onchainRiskZByMs = buildZByMs(riskRows, (r) => Number(r.risk), RISK_EMA_SPAN);

    // ---- Price ----
    // Primary: ChartInspect's dedicated OHLCV endpoint. Fallback: the
    // btc_price field bundled with the on-chain metric responses above
    // (already fetched, so this costs nothing extra) if the dedicated
    // endpoint failed for some reason.
    let priceByMs = priceResult;
    if (!priceByMs || !Object.keys(priceByMs).length) {
      priceByMs = {};
      mergePriceByMs(priceByMs, sharpeRows);
      mergePriceByMs(priceByMs, cbplRows);
      mergePriceByMs(priceByMs, riskRows);
    }

    const body = {
      success: true,
      priceByMs,
      sharpeZByMs,
      cbplZByMs,
      onchainRiskZByMs,
      priceCount: Object.keys(priceByMs).length,
      sharpeCount: sharpeRows.length,
      cbplCount: cbplRows.length,
      onchainRiskCount: riskRows.length,
      generatedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), body };

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
    return res.status(200).json(body);
  } catch (err) {
    console.error("onchain-metrics proxy error:", err);
    return res.status(502).json({ success: false, error: String(err.message || err) });
  }
};
