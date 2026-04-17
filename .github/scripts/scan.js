// GitHub Actions Scanner v10.0 — Multi-Timeframe
// Per-user settings + timeframe from Firebase
import fetch from 'node-fetch'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const OS_APP_ID  = '8ef4fedd-fb79-4a04-a445-fcc5857cbd81'
const OS_API_KEY = process.env.ONESIGNAL_API_KEY

let db=null
function getDb(){
  if(!db){try{initializeApp({credential:cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});db=getFirestore()}catch(e){console.log('Firebase init failed:',e.message)}}
  return db
}

const DEFAULT={gapEnabled:false,gap9_20:0.015,gap20_40:0.025,gap40_80:0,rsiCapEnabled:true,rsiTolerance:20,wickEnabled:true,wickTouchPct:1.5,scoreFilterEnabled:false,scoreMin:5,timeframe:'15m',slope:{e9:{enabled:true,bars:1,minPct:0},e20:{enabled:true,bars:2,minPct:0.015},e40:{enabled:true,bars:2,minPct:0.015},e80:{enabled:true,bars:2,minPct:0}}}

function tryParse(s,fb){try{return JSON.parse(s)}catch{return fb}}
function parseSettings(d){
  const slope=typeof d.slope==='string'?tryParse(d.slope,DEFAULT.slope):(d.slope||DEFAULT.slope)
  return{gapEnabled:d.gapEnabled??DEFAULT.gapEnabled,gap9_20:d.gap9_20??DEFAULT.gap9_20,gap20_40:d.gap20_40??DEFAULT.gap20_40,gap40_80:d.gap40_80??DEFAULT.gap40_80,rsiCapEnabled:d.rsiCapEnabled??DEFAULT.rsiCapEnabled,rsiTolerance:d.rsiTolerance??DEFAULT.rsiTolerance,wickEnabled:d.wickEnabled??DEFAULT.wickEnabled,wickTouchPct:d.wickTouchPct??DEFAULT.wickTouchPct,scoreFilterEnabled:d.scoreFilterEnabled??DEFAULT.scoreFilterEnabled,scoreMin:d.scoreMin??DEFAULT.scoreMin,timeframe:d.timeframe||'15m',slope}
}

function calcEMA(c,p){const k=2/(p+1);let e=c[0];for(let i=1;i<c.length;i++)e=c[i]*k+e*(1-k);return e}
function calcEMAH(c,p,n=6){const k=2/(p+1);let e=c[0];const h=[e];for(let i=1;i<c.length;i++){e=c[i]*k+e*(1-k);h.push(e)}return h.slice(-n)}
function calcRSI(c,p=14){if(c.length<p+2)return 50;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d)}return 100-100/(1+g/(l||1e-4))}
function slopeUp(h,b,m){if(!h||h.length<b+1)return false;const r=h.slice(-(b+1));for(let i=1;i<r.length;i++)if((r[i]-r[i-1])/r[i-1]*100<m)return false;return true}
function slopeDn(h,b,m){if(!h||h.length<b+1)return false;const r=h.slice(-(b+1));for(let i=1;i<r.length;i++)if((r[i-1]-r[i])/r[i-1]*100<m)return false;return true}

function detectBull(cd,cfg){
  if(!cd||cd.length<85)return{ok:false}
  const cl=cd.map(c=>c.c),n=cl.length
  const e9=calcEMA(cl,9),e20=calcEMA(cl,20),e40=calcEMA(cl,40),e80=calcEMA(cl,80)
  const rsi=calcRSI(cl),price=cl[n-1],lc=cd[n-1]
  const sl=cfg.slope,mb=Math.max(sl.e9.bars,sl.e20.bars,sl.e40.bars,sl.e80.bars)+2
  const h9=calcEMAH(cl,9,mb),h20=calcEMAH(cl,20,mb),h40=calcEMAH(cl,40,mb),h80=calcEMAH(cl,80,mb)
  const emaOk=e9>e20&&e20>e40&&e40>=e80*0.995
  const gapOk=cfg.gapEnabled?e9>e20*(1+cfg.gap9_20/100)&&e20>e40*(1+cfg.gap20_40/100):true
  const prOk=price>=e80*0.97&&price<=e9*1.03&&price>e20&&price>=e9*0.995
  const lb=Math.min(5,n-1)
  const rc=cl.slice(n-lb-1,n).some((p,i,arr)=>i>0&&arr[i-1]<=calcEMA(cl.slice(0,n-lb+i),9)&&p>calcEMA(cl.slice(0,n-lb+i+1),9))
  const cross=rc||(cl[n-2]<=e9&&price>e9)||(cd[n-2]?.c<=e9*1.005&&price>e9*1.005)
  const candOk=lc.c>lc.o
  const rsiOk=cfg.rsiCapEnabled?rsi>50&&rsi<=50+cfg.rsiTolerance:rsi>50
  const wkOk=cfg.wickEnabled?Math.min(...cd.slice(-3).map(c=>c.l))<e40*(1+cfg.wickTouchPct/100):true
  const r9=sl.e9.enabled?slopeUp(h9,sl.e9.bars,sl.e9.minPct):true
  const r20=sl.e20.enabled?slopeUp(h20,sl.e20.bars,sl.e20.minPct):true
  const r40=sl.e40.enabled?slopeUp(h40,sl.e40.bars,sl.e40.minPct):true
  const r80=sl.e80.enabled?slopeUp(h80,sl.e80.bars,sl.e80.minPct):true
  return{ok:emaOk&&gapOk&&prOk&&cross&&candOk&&rsiOk&&wkOk&&r9&&r20&&r40&&r80,price,rsi,e9,e20,e40,e80}
}

function detectBear(cd,cfg){
  if(!cd||cd.length<85)return{ok:false}
  const cl=cd.map(c=>c.c),n=cl.length
  const e9=calcEMA(cl,9),e20=calcEMA(cl,20),e40=calcEMA(cl,40),e80=calcEMA(cl,80)
  const rsi=calcRSI(cl),price=cl[n-1],lc=cd[n-1]
  const sl=cfg.slope,mb=Math.max(sl.e9.bars,sl.e20.bars,sl.e40.bars,sl.e80.bars)+2
  const h9=calcEMAH(cl,9,mb),h20=calcEMAH(cl,20,mb),h40=calcEMAH(cl,40,mb),h80=calcEMAH(cl,80,mb)
  const emaOk=e9<e20&&e20<e40&&e40<=e80*1.005
  const gapOk=cfg.gapEnabled?e9<e20*(1-cfg.gap9_20/100)&&e20<e40*(1-cfg.gap20_40/100):true
  const prOk=price<=e80*1.03&&price>=e9*0.97&&price<e20&&price<=e9*1.005
  const lb=Math.min(5,n-1)
  const rcB=cl.slice(n-lb-1,n).some((p,i,arr)=>i>0&&arr[i-1]>=calcEMA(cl.slice(0,n-lb+i),9)&&p<calcEMA(cl.slice(0,n-lb+i+1),9))
  const cross=rcB||(cl[n-2]>=e9&&price<e9)||(cd[n-2]?.c>=e9*0.995&&price<e9*0.995)
  const candOk=lc.c<lc.o
  const rsiOk=cfg.rsiCapEnabled?rsi<50&&rsi>=50-cfg.rsiTolerance:rsi<50
  const wkOk=cfg.wickEnabled?Math.max(...cd.slice(-3).map(c=>c.h))>e40*(1-cfg.wickTouchPct/100):true
  const f9=sl.e9.enabled?slopeDn(h9,sl.e9.bars,sl.e9.minPct):true
  const f20=sl.e20.enabled?slopeDn(h20,sl.e20.bars,sl.e20.minPct):true
  const f40=sl.e40.enabled?slopeDn(h40,sl.e40.bars,sl.e40.minPct):true
  const f80=sl.e80.enabled?slopeDn(h80,sl.e80.bars,sl.e80.minPct):true
  return{ok:emaOk&&gapOk&&prOk&&cross&&candOk&&rsiOk&&wkOk&&f9&&f20&&f40&&f80,price,rsi,e9,e20,e40,e80}
}

const candleCache={}
async function fetchCandles(sym,tf,futures){
  tf=tf||'15m';futures=futures||false
  const key=sym+'_'+tf+'_'+(futures?'f':'s')
  if(candleCache[key])return candleCache[key]
  try{
    const url=(futures?'https://fapi.binance.com/fapi/v1/klines':'https://api.binance.com/api/v3/klines')+'?symbol='+sym+'&interval='+tf+'&limit=100'
    const r=await fetch(url,{signal:AbortSignal.timeout(8000)})
    if(!r.ok)return null
    const data=(await r.json()).map(k=>({o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5],t:k[0]}))
    candleCache[key]=data;return data
  }catch{return null}
}

const fp=v=>{if(!v)return'0';if(v<0.0001)return v.toFixed(8);if(v<1)return v.toFixed(4);if(v<100)return v.toFixed(2);return Math.round(v).toLocaleString()}
const tvInt=tf=>tf==='5m'?5:tf==='1h'?60:tf==='4h'?240:15

function buildMsg(sym,dir,r,tf,futures){
  tf=tf||'15m';futures=futures||false
  const base=sym.replace('USDT',''),label=dir==='bull'?'🟢 LONG ▲':'🔴 SHORT ▼'
  return label+' <b>'+base+'/USDT'+(futures?' PERP':'')+' ['+tf+']</b>\n'+
    '💰 Price: <b>$'+fp(r.price)+'</b>  RSI: <b>'+r.rsi.toFixed(1)+'</b>\n'+
    '📈 EMA9: '+fp(r.e9)+'  EMA20: '+fp(r.e20)+'\n'+
    '📉 EMA40: '+fp(r.e40)+'  EMA80: '+fp(r.e80)+'\n'+
    '🕐 '+new Date().toUTCString()+'\n'+
    '🔗 <a href="https://www.tradingview.com/chart/?symbol=BINANCE:'+sym+'&interval='+tvInt(tf)+'">TradingView</a>'
}

async function tgSend(token,chatId,text,label){
  label=label||''
  if(!token||!chatId){console.log('  TG ['+label+']: missing credentials');return false}
  try{
    const r=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML',disable_web_page_preview:false})})
    const d=await r.json()
    if(d.ok)console.log('  TG ['+label+']: sent ✅')
    else console.log('  TG ['+label+']: FAILED - '+d.description)
    return d.ok
  }catch(e){console.log('  TG ['+label+']: error - '+e.message);return false}
}

async function sendOneSignal(title,body,url){
  if(!OS_API_KEY)return
  try{
    const r=await fetch('https://onesignal.com/api/v1/notifications',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Key '+OS_API_KEY},body:JSON.stringify({app_id:OS_APP_ID,included_segments:['All'],headings:{en:title},contents:{en:body},url})})
    const d=await r.json()
    if(d.id)console.log('  OneSignal: sent ✅ ('+d.id+')')
    else console.log('  OneSignal: FAILED',d.errors||d)
  }catch(e){console.log('  OneSignal: error - '+e.message)}
}

const SPOT_COUNT=150
async function getTopSpotPairs(n){
  n=n||SPOT_COUNT
  try{
    const r=await fetch('https://api.binance.com/api/v3/ticker/24hr',{signal:AbortSignal.timeout(10000)})
    if(!r.ok)throw new Error('HTTP '+r.status)
    const filtered=(await r.json()).filter(t=>t.symbol.endsWith('USDT')&&!t.symbol.match(/BULL|BEAR|UP|DOWN|3L|3S|TUSD|USDC|BUSD|DAI|FDUSD|UST|USDP/)).sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume)).slice(0,n).map(t=>t.symbol)
    console.log('  Dynamic SPOT: top '+filtered.length+' coins')
    return filtered
  }catch(e){
    console.log('  ⚠️  Dynamic fetch failed ('+e.message+'), using fallback')
    return['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','TONUSDT','DOTUSDT','LINKUSDT','TRXUSDT','UNIUSDT','NEARUSDT','LTCUSDT','ICPUSDT','APTUSDT','ARBUSDT','PEPEUSDT','SUIUSDT','HBARUSDT','INJUSDT','OPUSDT','WIFUSDT','FETUSDT','FTMUSDT','MKRUSDT','AAVEUSDT','GALAUSDT','ALGOUSDT','VETUSDT','AXSUSDT','MANAUSDT','CRVUSDT','APEUSDT','ATOMUSDT','FILUSDT','RUNEUSDT','IMXUSDT','GRTUSDT']
  }
}
const FUTURES=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','NEARUSDT','INJUSDT','SUIUSDT','APTUSDT','ARBUSDT','OPUSDT','ATOMUSDT','FTMUSDT','AAVEUSDT']

const seen={}
function isDup(k){const now=Date.now();if(seen[k]&&now-seen[k]<3600000)return true;seen[k]=now;return false}

async function main(){
  console.log('\n=== Multi-TF EMA Hunter v10.0 — '+new Date().toUTCString()+' ===')
  console.log('OneSignal: '+(OS_API_KEY?'configured ✅':'MISSING ❌'))
  console.log('Firebase:  '+(process.env.FIREBASE_SERVICE_ACCOUNT?'configured ✅':'MISSING ❌'))

  let users=[]
  try{
    const db=getDb()
    if(db){
      const snap=await db.collection('settings').get()
      let total=0
      snap.forEach(doc=>{
        total++
        const d=doc.data()
        console.log('  Doc ['+doc.id.slice(0,8)+'] tgOn:'+d.tgOn+' token:'+!!d.tgToken+' chatId:'+!!d.tgChatId+' tf:'+(d.timeframe||'15m'))
        if(d.tgOn&&d.tgToken&&d.tgChatId)users.push({uid:doc.id,token:d.tgToken,chatId:d.tgChatId,cfg:parseSettings(d)})
      })
      console.log('Total docs: '+total+' | Telegram users: '+users.length)
      if(total===0)console.log('  ⚠️  No docs — open app, login, save settings with Telegram enabled')
      users.forEach(u=>console.log('  ✅ ['+u.uid.slice(0,8)+'] TF:'+u.cfg.timeframe+' RSI:'+u.cfg.rsiTolerance+' Gap:'+u.cfg.gapEnabled))
    }
  }catch(e){console.log('Firebase read failed:',e.message)}

  const SPOT=await getTopSpotPairs(SPOT_COUNT)
  const allPairs=[...SPOT.map(s=>({s,futures:false})),...FUTURES.map(s=>({s,futures:true}))]

  // Fetch candles for all needed TFs
  const allTFs=[...new Set([...users.map(u=>u.cfg.timeframe||'15m'),'15m'])]
  console.log('\nFetching candles — pairs:'+allPairs.length+' TFs:['+allTFs.join(',')+']')
  for(const tf of allTFs){
    for(const p of allPairs){await fetchCandles(p.s,tf,p.futures);await new Promise(r=>setTimeout(r,60))}
  }
  console.log('Candles ready.')

  let totalTg=0,totalPush=0

  // ── TELEGRAM — per user, their own TF + settings ──
  if(users.length>0){
    console.log('\nScanning Telegram for '+users.length+' user(s)...')
    for(const user of users){
      const utf=user.cfg.timeframe||'15m';let uc=0
      for(const{s:sym,futures}of allPairs){
        const ck=sym+'_'+utf+'_'+(futures?'f':'s')
        const cd=candleCache[ck];if(!cd)continue
        for(const[detect,dir]of[[detectBull,'bull'],[detectBear,'bear']]){
          const r=detect(cd,user.cfg);if(!r.ok)continue
          const dk='tg_'+user.uid+'_'+sym+'_'+dir+'_'+utf+'_'+(futures?'f':'s')
          if(isDup(dk))continue
          uc++;totalTg++
          console.log('  ['+user.uid.slice(0,8)+'] '+dir.toUpperCase()+(futures?' PERP':'')+' ['+utf+']: '+sym+' $'+fp(r.price)+' RSI:'+r.rsi.toFixed(1))
          await tgSend(user.token,user.chatId,buildMsg(sym,dir,r,utf,futures),user.uid.slice(0,8))
        }
      }
      console.log('  → '+uc+' signals for ['+user.uid.slice(0,8)+'] on '+utf)
    }
  } else {
    console.log('\n⚠️  No Telegram users — login + Save Settings with Telegram enabled')
  }

  // ── ONESIGNAL — always 15m default, broadcast to all subscribers ──
  console.log('\nScanning OneSignal push (15m default)...')
  for(const{s:sym,futures}of allPairs){
    const cd=candleCache[sym+'_15m_'+(futures?'f':'s')];if(!cd)continue
    for(const[detect,dir]of[[detectBull,'bull'],[detectBear,'bear']]){
      const r=detect(cd,DEFAULT);if(!r.ok)continue
      const pk='push_'+sym+'_'+dir+'_'+(futures?'f':'s')
      if(isDup(pk))continue
      totalPush++
      const base=sym.replace('USDT','')
      const title=(dir==='bull'?'🟢 LONG':'🔴 SHORT')+(futures?' PERP':'')+' '+base+'/USDT [15m]'
      console.log('  PUSH '+dir.toUpperCase()+(futures?' PERP':'')+': '+sym)
      await sendOneSignal(title,'$'+fp(r.price)+'  RSI: '+r.rsi.toFixed(1),'https://www.tradingview.com/chart/?symbol=BINANCE:'+sym+'&interval=15')
    }
  }

  Object.keys(candleCache).forEach(k=>delete candleCache[k])
  console.log('\n=== Done. Telegram: '+totalTg+' | Push: '+totalPush+' ===')
}

async function loop(){
  const START=Date.now(),MAX=55*60*1000;let round=0
  while(Date.now()-START<MAX){
    round++
    console.log('\n━━━ ROUND '+round+' ━━━')
    await main()
    const rem=MAX-(Date.now()-START)
    if(rem<=0)break
    console.log('\n⏱ Waiting 1 min... ('+Math.round(rem/60000)+'m left)')
    await new Promise(r=>setTimeout(r,60000))
  }
  console.log('\n✅ Loop complete.')
  process.exit(0)
}

loop().catch(e=>{console.error('Error:',e);process.exit(1)})
