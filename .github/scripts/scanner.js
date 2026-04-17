// .github/scripts/scanner.js
// Runs every 5 min via GitHub Actions
// Per-user Telegram from Firebase settings + OneSignal push broadcast

import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import fetch from 'node-fetch'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// ── Setup ────────────────────────────────────────────────────────────────
const OS_APP_ID  = '8ef4fedd-fb79-4a04-a445-fcc5857cbd81'
const OS_API_KEY = process.env.ONESIGNAL_API_KEY

// Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

// ── Dedup (persists between runs via GitHub cache) ───────────────────────
const DEDUP_FILE = '/tmp/ema_dedup.json'
let recentAlerts = {}
if (existsSync(DEDUP_FILE)) {
  try { recentAlerts = JSON.parse(readFileSync(DEDUP_FILE, 'utf8')) } catch {}
}
function isDuplicate(id, symbol, dir) {
  const key = `${id}_${symbol}_${dir}`, now = Date.now()
  Object.keys(recentAlerts).forEach(k => { if (now - recentAlerts[k] > 3600000) delete recentAlerts[k] })
  if (recentAlerts[key] && now - recentAlerts[key] < 3600000) return true
  recentAlerts[key] = now
  writeFileSync(DEDUP_FILE, JSON.stringify(recentAlerts))
  return false
}

// ── Default settings ─────────────────────────────────────────────────────
const DEFAULT = {
  gapEnabled: false, gap9_20: 0.015, gap20_40: 0.025, gap40_80: 0,
  rsiCapEnabled: true, rsiTolerance: 20,
  wickEnabled: true, wickTouchPct: 1.5,
  scoreFilterEnabled: false, scoreMin: 5,
  slope: {
    e9:  { enabled: true, bars: 1, minPct: 0 },
    e20: { enabled: true, bars: 2, minPct: 0.015 },
    e40: { enabled: true, bars: 2, minPct: 0.015 },
    e80: { enabled: true, bars: 2, minPct: 0 },
  }
}

function tryParse(s, fb) { try { return JSON.parse(s) } catch { return fb } }
function parseSettings(d) {
  const slope = typeof d.slope === 'string' ? tryParse(d.slope, DEFAULT.slope) : (d.slope || DEFAULT.slope)
  return {
    gapEnabled:          d.gapEnabled          ?? DEFAULT.gapEnabled,
    gap9_20:             d.gap9_20             ?? DEFAULT.gap9_20,
    gap20_40:            d.gap20_40            ?? DEFAULT.gap20_40,
    gap40_80:            d.gap40_80            ?? DEFAULT.gap40_80,
    rsiCapEnabled:       d.rsiCapEnabled       ?? DEFAULT.rsiCapEnabled,
    rsiTolerance:        d.rsiTolerance        ?? DEFAULT.rsiTolerance,
    wickEnabled:         d.wickEnabled         ?? DEFAULT.wickEnabled,
    wickTouchPct:        d.wickTouchPct        ?? DEFAULT.wickTouchPct,
    scoreFilterEnabled:  d.scoreFilterEnabled  ?? DEFAULT.scoreFilterEnabled,
    scoreMin:            d.scoreMin            ?? DEFAULT.scoreMin,
    slope,
  }
}

// ── EMA / RSI / Slope ─────────────────────────────────────────────────────
function calcEMA(c,p){const k=2/(p+1);let e=c[0];for(let i=1;i<c.length;i++)e=c[i]*k+e*(1-k);return e}
function calcEMAH(c,p,n=8){const k=2/(p+1);let e=c[0];const h=[e];for(let i=1;i<c.length;i++){e=c[i]*k+e*(1-k);h.push(e)}return h.slice(-n)}
function calcRSI(c,p=14){if(c.length<p+2)return 50;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d)}return 100-100/(1+g/(l||1e-4))}
function slopeUp(h,b,m){if(!h||h.length<b+1)return false;const r=h.slice(-(b+1));for(let i=1;i<r.length;i++)if((r[i]-r[i-1])/r[i-1]*100<m)return false;return true}
function slopeDn(h,b,m){if(!h||h.length<b+1)return false;const r=h.slice(-(b+1));for(let i=1;i<r.length;i++)if((r[i-1]-r[i])/r[i-1]*100<m)return false;return true}

// ── Signal detection — 5-candle cross (synced with signals.js) ───────────
function detectBull(cd, cfg) {
  if (!cd || cd.length < 85) return { ok: false }
  const cl = cd.map(c => c.c), n = cl.length
  const e9 = calcEMA(cl,9), e20 = calcEMA(cl,20), e40 = calcEMA(cl,40), e80 = calcEMA(cl,80)
  const rsi = calcRSI(cl), price = cl[n-1], lc = cd[n-1]
  const sl = cfg.slope, mb = Math.max(sl.e9.bars, sl.e20.bars, sl.e40.bars, sl.e80.bars) + 2
  const h9=calcEMAH(cl,9,mb), h20=calcEMAH(cl,20,mb), h40=calcEMAH(cl,40,mb), h80=calcEMAH(cl,80,mb)
  const emaOk = e9>e20 && e20>e40 && e40>=e80*0.995
  const gapOk = cfg.gapEnabled ? e9>e20*(1+cfg.gap9_20/100) && e20>e40*(1+cfg.gap20_40/100) : true
  const prOk  = price>=e80*0.97 && price<=e9*1.03 && price>e20 && price>=e9*0.995
  const lb = Math.min(5, n-1)
  const recentCross = cl.slice(n-lb-1,n).some((p,i,arr)=>i>0&&arr[i-1]<=calcEMA(cl.slice(0,n-lb+i),9)&&p>calcEMA(cl.slice(0,n-lb+i+1),9))
  const cross  = recentCross || (cl[n-2]<=e9 && price>e9) || (cd[n-2]?.c<=e9*1.005 && price>e9*1.005)
  const candOk = lc.c > lc.o
  const rsiOk  = cfg.rsiCapEnabled ? rsi>50 && rsi<=50+cfg.rsiTolerance : rsi>50
  const wkOk   = cfg.wickEnabled ? Math.min(...cd.slice(-3).map(c=>c.l))<e40*(1+cfg.wickTouchPct/100) : true
  const r9=sl.e9.enabled?slopeUp(h9,sl.e9.bars,sl.e9.minPct):true
  const r20=sl.e20.enabled?slopeUp(h20,sl.e20.bars,sl.e20.minPct):true
  const r40=sl.e40.enabled?slopeUp(h40,sl.e40.bars,sl.e40.minPct):true
  const r80=sl.e80.enabled?slopeUp(h80,sl.e80.bars,sl.e80.minPct):true
  const ok = emaOk&&gapOk&&prOk&&cross&&candOk&&rsiOk&&wkOk&&r9&&r20&&r40&&r80
  return { ok, price, rsi, e9, e20, e40, e80 }
}

function detectBear(cd, cfg) {
  if (!cd || cd.length < 85) return { ok: false }
  const cl = cd.map(c => c.c), n = cl.length
  const e9 = calcEMA(cl,9), e20 = calcEMA(cl,20), e40 = calcEMA(cl,40), e80 = calcEMA(cl,80)
  const rsi = calcRSI(cl), price = cl[n-1], lc = cd[n-1]
  const sl = cfg.slope, mb = Math.max(sl.e9.bars, sl.e20.bars, sl.e40.bars, sl.e80.bars) + 2
  const h9=calcEMAH(cl,9,mb), h20=calcEMAH(cl,20,mb), h40=calcEMAH(cl,40,mb), h80=calcEMAH(cl,80,mb)
  const emaOk = e9<e20 && e20<e40 && e40<=e80*1.005
  const gapOk = cfg.gapEnabled ? e9<e20*(1-cfg.gap9_20/100) && e20<e40*(1-cfg.gap20_40/100) : true
  const prOk  = price<=e80*1.03 && price>=e9*0.97 && price<e20 && price<=e9*1.005
  const lb = Math.min(5, n-1)
  const recentCrossB = cl.slice(n-lb-1,n).some((p,i,arr)=>i>0&&arr[i-1]>=calcEMA(cl.slice(0,n-lb+i),9)&&p<calcEMA(cl.slice(0,n-lb+i+1),9))
  const cross  = recentCrossB || (cl[n-2]>=e9 && price<e9) || (cd[n-2]?.c>=e9*0.995 && price<e9*0.995)
  const candOk = lc.c < lc.o
  const rsiOk  = cfg.rsiCapEnabled ? rsi<50 && rsi>=50-cfg.rsiTolerance : rsi<50
  const wkOk   = cfg.wickEnabled ? Math.max(...cd.slice(-3).map(c=>c.h))>e40*(1-cfg.wickTouchPct/100) : true
  const f9=sl.e9.enabled?slopeDn(h9,sl.e9.bars,sl.e9.minPct):true
  const f20=sl.e20.enabled?slopeDn(h20,sl.e20.bars,sl.e20.minPct):true
  const f40=sl.e40.enabled?slopeDn(h40,sl.e40.bars,sl.e40.minPct):true
  const f80=sl.e80.enabled?slopeDn(h80,sl.e80.bars,sl.e80.minPct):true
  const ok = emaOk&&gapOk&&prOk&&cross&&candOk&&rsiOk&&wkOk&&f9&&f20&&f40&&f80
  return { ok, price, rsi, e9, e20, e40, e80 }
}

// ── Binance ───────────────────────────────────────────────────────────────
const candleCache = {}
async function fetchCandles(symbol) {
  if (candleCache[symbol]) return candleCache[symbol]
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    const data = (await r.json()).map(k => ({ o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5], t:k[0] }))
    candleCache[symbol] = data; return data
  } catch { return null }
}

// ── Telegram ──────────────────────────────────────────────────────────────
async function sendTelegram(token, chatId, text, label = '') {
  if (!token || !chatId) return false
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false })
    })
    const d = await r.json()
    if (d.ok) console.log(`  TG [${label}]: sent ✅`)
    else console.log(`  TG [${label}]: FAILED — ${d.description}`)
    return d.ok
  } catch (e) { console.log(`  TG [${label}]: error — ${e.message}`); return false }
}

// ── OneSignal push broadcast ──────────────────────────────────────────────
async function sendOneSignal(title, body, url) {
  if (!OS_API_KEY) return
  try {
    const r = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${OS_API_KEY}` },
      body: JSON.stringify({ app_id: OS_APP_ID, included_segments: ['All'], headings: { en: title }, contents: { en: body }, url })
    })
    const d = await r.json()
    if (d.id) console.log(`  OneSignal: sent ✅ (${d.id})`)
    else console.log(`  OneSignal: FAILED`, d.errors || d)
  } catch (e) { console.log(`  OneSignal: error — ${e.message}`) }
}

// ── Message builders ──────────────────────────────────────────────────────
const fp = v => { if (!v) return '0'; if (v<0.0001) return v.toFixed(8); if (v<1) return v.toFixed(4); if (v<100) return v.toFixed(2); return Math.round(v).toLocaleString() }

function buildTgMsg(symbol, dir, r) {
  const base = symbol.replace('USDT', '')
  const label = dir === 'bull' ? '🟢 LONG ▲' : '🔴 SHORT ▼'
  return `${label} <b>${base}/USDT</b>
💰 Price: <b>$${fp(r.price)}</b>  RSI: <b>${r.rsi.toFixed(1)}</b>
📈 EMA9: ${fp(r.e9)}  EMA20: ${fp(r.e20)}
📉 EMA40: ${fp(r.e40)}  EMA80: ${fp(r.e80)}
🕐 ${new Date().toUTCString()}
🔗 <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}&interval=15">TradingView</a>`
}

// ── Pairs — dynamic top-volume fetch (v10.0) ─────────────────────────────
const SPOT_COUNT = 150
async function getTopSpotPairs(n = SPOT_COUNT) {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr', { signal: AbortSignal.timeout(10000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const tickers = await r.json()
    const filtered = tickers
      .filter(t =>
        t.symbol.endsWith('USDT') &&
        !t.symbol.match(/BULL|BEAR|UP|DOWN|3L|3S|TUSD|USDC|BUSD|DAI|FDUSD|UST|USDP/)
      )
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, n)
      .map(t => t.symbol)
    console.log(`  Dynamic SPOT list: fetched top ${filtered.length} coins by volume`)
    return filtered
  } catch(e) {
    console.log(`  ⚠️  Dynamic fetch failed (${e.message}), using fallback list`)
    return ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','TONUSDT','DOTUSDT','LINKUSDT','TRXUSDT','UNIUSDT','NEARUSDT','LTCUSDT','ICPUSDT','APTUSDT','ARBUSDT','PEPEUSDT','SUIUSDT','HBARUSDT','INJUSDT','OPUSDT','STXUSDT','RENDERUSDT','WIFUSDT','FETUSDT','LDOUSDT','FTMUSDT','BONKUSDT','TIAUSDT','MKRUSDT','AAVEUSDT','FLOKIUSDT','ENAUSDT','JUPUSDT','GALAUSDT','ALGOUSDT','VETUSDT','SANDUSDT','QNTUSDT','AXSUSDT','MANAUSDT','SEIUSDT','CRVUSDT','PYTHUSDT','EIGENUSDT','APEUSDT','GMTUSDT','CHZUSDT','ZILUSDT','HOTUSDT','ETHFIUSDT','NEIROUSDT','MEWUSDT','BOMEUSDT','POPCATUSDT','GOATUSDT','PNUTUSDT','TURBOUSDT','ACTUSDT','ATOMUSDT','THETAUSDT','FILUSDT','RUNEUSDT','IMXUSDT','GRTUSDT']
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== EMA Scanner v10.0 — ${new Date().toUTCString()} ===`)
  console.log(`OneSignal:  ${OS_API_KEY ? 'configured' : 'MISSING'}`)
  console.log(`Firebase:   ${process.env.FIREBASE_SERVICE_ACCOUNT ? 'configured' : 'MISSING'}`)

  // Load users with Telegram enabled from Firebase
  let users = []
  try {
    const snap = await db.collection('settings').get()
    snap.forEach(doc => {
      const d = doc.data()
      if (d.tgOn && d.tgToken && d.tgChatId)
        users.push({ uid: doc.id, token: d.tgToken, chatId: d.tgChatId, cfg: parseSettings(d) })
    })
    console.log(`Users with Telegram: ${users.length}`)
  } catch (e) { console.log('Firebase read failed:', e.message) }

  // Fetch all candles once
  const PAIRS = await getTopSpotPairs(SPOT_COUNT)
  console.log(`\nFetching candles for ${PAIRS.length} pairs...`)
  for (const sym of PAIRS) { await fetchCandles(sym); await new Promise(r => setTimeout(r, 80)) }
  console.log('Candles ready.')

  // ── Per-user Telegram (respects each user's own settings) ──
  let totalTg = 0
  for (const user of users) {
    let uc = 0
    for (const sym of PAIRS) {
      const cd = candleCache[sym]; if (!cd) continue
      for (const [detect, dir] of [[detectBull, 'bull'], [detectBear, 'bear']]) {
        const r = detect(cd, user.cfg); if (!r.ok) continue
        if (isDuplicate(`tg_${user.uid}`, sym, dir)) continue
        uc++; totalTg++
        console.log(`  [${user.uid.slice(0,8)}] ${dir.toUpperCase()}: ${sym} @ $${fp(r.price)} RSI:${r.rsi.toFixed(1)}`)
        await sendTelegram(user.token, user.chatId, buildTgMsg(sym, dir, r), user.uid.slice(0,8))
      }
    }
    if (uc > 0) console.log(`  → ${uc} signals sent to user ${user.uid.slice(0,8)}`)
  }

  // ── OneSignal push — broadcast to all subscribers (once per signal) ──
  let totalPush = 0
  for (const sym of PAIRS) {
    const cd = candleCache[sym]; if (!cd) continue
    for (const [detect, dir] of [[detectBull, 'bull'], [detectBear, 'bear']]) {
      const r = detect(cd, DEFAULT); if (!r.ok) continue
      if (isDuplicate('push', sym, dir)) continue
      totalPush++
      const base = sym.replace('USDT', '')
      const title = dir === 'bull' ? `🟢 LONG — ${base}/USDT` : `🔴 SHORT — ${base}/USDT`
      const body  = `Price: $${fp(r.price)}  RSI: ${r.rsi.toFixed(1)}`
      const url   = `https://www.tradingview.com/chart/?symbol=BINANCE:${sym}&interval=15`
      console.log(`  PUSH ${dir.toUpperCase()}: ${sym}`)
      await sendOneSignal(title, body, url)
    }
  }

  Object.keys(candleCache).forEach(k => delete candleCache[k])
  console.log(`\n=== Done. TG signals: ${totalTg} | Push signals: ${totalPush} ===`)
}

main().catch(e => { console.error('❌ Error:', e.message); process.exit(1) })
