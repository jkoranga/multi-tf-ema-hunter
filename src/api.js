// ════════════════════════════════════════════════════════════
//  BINANCE PUBLIC API  —  no API key required
//  Endpoint: GET /api/v3/klines
//  Returns: [[openTime, open, high, low, close, volume, ...], ...]
// ════════════════════════════════════════════════════════════

const BASE = 'https://api.binance.com'

// Fetch klines for a symbol at a given interval, returns array of {o,h,l,c,v}
export async function fetchCandles(symbol, interval = '15m', retries = 2) {
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) {
        // 429 = rate limit, 400 = bad symbol
        if (res.status === 429) await sleep(2000)
        if (res.status === 400) return null  // symbol doesn't exist on Binance
        throw new Error(`HTTP ${res.status}`)
      }
      const data = await res.json()
      return data.map(k => ({
        o: parseFloat(k[1]),
        h: parseFloat(k[2]),
        l: parseFloat(k[3]),
        c: parseFloat(k[4]),
        v: parseFloat(k[5]),
        t: k[0],  // open time ms
      }))
    } catch (err) {
      if (attempt === retries) return null
      await sleep(500 * (attempt + 1))
    }
  }
  return null
}

// Fetch 24h ticker stats for a symbol: price, volume, change%
export async function fetchTicker(symbol) {
  try {
    const res = await fetch(
      `${BASE}/api/v3/ticker/24hr?symbol=${symbol}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return null
    const d = await res.json()
    return {
      price:     parseFloat(d.lastPrice),
      vol24h:    parseFloat(d.quoteVolume) / 1e6,   // USDT millions
      change24h: parseFloat(d.priceChangePercent),
      high24h:   parseFloat(d.highPrice),
      low24h:    parseFloat(d.lowPrice),
    }
  } catch {
    return null
  }
}

// Fetch exchange info once to get all USDT perpetual-like spot pairs
// We use spot USDT pairs as proxy (Binance futures requires separate endpoint)
export async function fetchAllUSDTPairs() {
  try {
    const res = await fetch(
      `${BASE}/api/v3/exchangeInfo`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.symbols
      .filter(s =>
        s.quoteAsset === 'USDT' &&
        s.status === 'TRADING' &&
        s.isSpotTradingAllowed
      )
      .map(s => s.symbol)
  } catch {
    return null
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
