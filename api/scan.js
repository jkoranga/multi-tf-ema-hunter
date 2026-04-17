// api/scan.js — Vercel Cron + Web Push
import webpush from 'web-push'
import { initializeApp, cert, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

webpush.setVapidDetails(
  'mailto:admin@emahunter.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
)

function getDb(){
  if(!getApps().length)initializeApp({credential:cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))})
  return getFirestore()
}

const recent={}
function isDup(id,sym,dir){const k=`${id}_${sym}_${dir}`,now=Date.now();if(recent[k]&&now-recent[k]<3600000)return true;recent[k]=now;return false}

function calcEMA(c,p){const k=2/(p+1);let e=c[0];for(let i=1;i<c.length;i++)e=c[i]*k+e*(1-k);return e}
function calcEMAH(c,p,n=8){const k=2/(p+1);let e=c[0];const h=[e];for(let i=1;i<c.length;i++){e=c[i]*k+e*(1-k);h.push(e)}return h.slice(-n)}
function calcRSI(c,p=14){if(c.length<p+2)return 50;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d)}return 100-100/(1+g/(l||1e-4))}
function slopeUp(h,b,m){if(!h||h.length<b+1)return false;const r=h.slice(-(b+1));for(let i=1;i<r.length;i++)if((r[i]-r[i-1])/r[i-1]*100<m)return false;return true}
function slopeDn(h,b,m){if(!h||h.length<b+1)return false;const r=h.slice(-(b+1));for(let i=1;i<r.length;i++)if((r[i-1]-r[i])/r[i-1]*100<m)return false;return true}

function detectBull(cd){
  if(!cd||cd.length<85)return{ok:false}
  const cl=cd.map(c=>c.c),n=cl.length
  const e9=calcEMA(cl,9),e20=calcEMA(cl,20),e40=calcEMA(cl,40),e80=calcEMA(cl,80)
  const rsi=calcRSI(cl),price=cl[n-1],lc=cd[n-1]
  const h20=calcEMAH(cl,20,5),h40=calcEMAH(cl,40,5)
  const ok=e9>e20&&e20>e40&&e40>=e80*0.995&&e9>e20*1.0005&&e20>e40*1.0005&&
    price>=e80*0.97&&price<=e9*1.03&&price>e20&&price>=e9*0.995&&
    ((cl[n-2]<=e9&&price>e9)||(cd[n-2]?.c<=e9*1.001&&price>e9*1.001))&&lc.c>lc.o&&
    rsi>50&&rsi<=70&&Math.min(...cd.slice(-3).map(c=>c.l))<e40*0.985&&
    slopeUp(h20,3,0)&&slopeUp(h40,3,0)
  return{ok,price,rsi,e9,e20,e40,e80}
}
function detectBear(cd){
  if(!cd||cd.length<85)return{ok:false}
  const cl=cd.map(c=>c.c),n=cl.length
  const e9=calcEMA(cl,9),e20=calcEMA(cl,20),e40=calcEMA(cl,40),e80=calcEMA(cl,80)
  const rsi=calcRSI(cl),price=cl[n-1],lc=cd[n-1]
  const h20=calcEMAH(cl,20,5),h40=calcEMAH(cl,40,5)
  const ok=e9<e20&&e20<e40&&e40<=e80*1.005&&e9<e20*0.9995&&e20<e40*0.9995&&
    price<=e80*1.03&&price>=e9*0.97&&price<e20&&price<=e9*1.005&&
    ((cl[n-2]>=e9&&price<e9)||(cd[n-2]?.c>=e9*0.999&&price<e9*0.999))&&lc.c<lc.o&&
    rsi<50&&rsi>=30&&Math.max(...cd.slice(-3).map(c=>c.h))>e40*1.015&&
    slopeDn(h20,3,0)&&slopeDn(h40,3,0)
  return{ok,price,rsi,e9,e20,e40,e80}
}

async function fetchCandles(s){
  try{const r=await fetch(`https://api.binance.com/api/v3/klines?symbol=${s}&interval=15m&limit=100`);if(!r.ok)return null;return(await r.json()).map(k=>({o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5],t:k[0]}))}catch{return null}
}

// ── Dynamic top-volume pairs (v10.0) ──────────────────────────────────────
// Fetches all 24hr tickers in ONE call (fast), picks top N by volume.
// This replaces the old hardcoded PAIRS array.
async function getTopSpotPairs(n = 150) {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const tickers = await r.json()
    return tickers
      .filter(t =>
        t.symbol.endsWith('USDT') &&
        !t.symbol.match(/BULL|BEAR|UP|DOWN|3L|3S|TUSD|USDC|BUSD|DAI|FDUSD|UST|USDP/)
      )
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, n)
      .map(t => t.symbol)
  } catch {
    // Fallback list if ticker endpoint is down
    return ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','TONUSDT','DOTUSDT','LINKUSDT','TRXUSDT','UNIUSDT','NEARUSDT','LTCUSDT','ICPUSDT','APTUSDT','ARBUSDT','PEPEUSDT','SUIUSDT','HBARUSDT','INJUSDT','OPUSDT','STXUSDT','RENDERUSDT','WIFUSDT','FETUSDT','LDOUSDT','FTMUSDT','BONKUSDT','TIAUSDT','MKRUSDT','AAVEUSDT','FLOKIUSDT','ENAUSDT','JUPUSDT','GALAUSDT','ALGOUSDT','VETUSDT','SANDUSDT','QNTUSDT','AXSUSDT','MANAUSDT','SEIUSDT','CRVUSDT','PYTHUSDT','EIGENUSDT','APEUSDT','GMTUSDT','CHZUSDT','ZILUSDT','HOTUSDT','ETHFIUSDT','NEIROUSDT','MEWUSDT','BOMEUSDT','POPCATUSDT','GOATUSDT','PNUTUSDT','TURBOUSDT','ACTUSDT','ATOMUSDT','THETAUSDT','FILUSDT','RUNEUSDT','IMXUSDT','GRTUSDT']
  }
}

export default async function handler(req,res){
  const db=getDb()
  const snap=await db.collection('pushSubscriptions').get()
  if(snap.empty)return res.status(200).json({message:'No subscribers'})
  const subs=[];snap.forEach(d=>subs.push({id:d.id,...d.data()}))

  const PAIRS = await getTopSpotPairs(150)
  const signals=[]
  for(const sym of PAIRS){
    const cd=await fetchCandles(sym);if(!cd)continue
    const bull=detectBull(cd),bear=detectBear(cd)
    if(bull.ok)signals.push({sym,dir:'bull',r:bull})
    if(bear.ok)signals.push({sym,dir:'bear',r:bear})
    await new Promise(r=>setTimeout(r,50))
  }

  let sent=0
  for(const sub of subs){
    for(const sig of signals){
      if(isDup(sub.id,sig.sym,sig.dir))continue
      const base=sig.sym.replace('USDT','')
      const payload=JSON.stringify({
        title:sig.dir==='bull'?`🟢 LONG — ${base}/USDT`:`🔴 SHORT — ${base}/USDT`,
        body:`Price: $${sig.r.price.toFixed(4)}  RSI: ${sig.r.rsi.toFixed(1)}`,
        tag:`${sig.sym}_${sig.dir}`,
        url:`https://www.tradingview.com/chart/?symbol=BINANCE:${sig.sym}&interval=15`
      })
      try{await webpush.sendNotification(sub.subscription,payload);sent++}
      catch(e){if(e.statusCode===410||e.statusCode===404)await db.collection('pushSubscriptions').doc(sub.id).delete()}
    }
  }
  return res.status(200).json({scanned:PAIRS.length,signals:signals.length,subs:subs.length,sent})
}
