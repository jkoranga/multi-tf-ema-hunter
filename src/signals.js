// SIGNAL ENGINE v7 — per-EMA independent slope
export function calcEMA(closes, period) {
  const k=2/(period+1);let e=closes[0];for(let i=1;i<closes.length;i++)e=closes[i]*k+e*(1-k);return e
}
export function calcEMAHistory(closes, period, count=8) {
  const k=2/(period+1);let e=closes[0];const h=[e];for(let i=1;i<closes.length;i++){e=closes[i]*k+e*(1-k);h.push(e)}return h.slice(-count)
}
export function calcRSI(closes, period=14) {
  if(closes.length<period+2)return 50;let g=0,l=0;for(let i=closes.length-period;i<closes.length;i++){const d=closes[i]-closes[i-1];d>0?(g+=d):(l+=Math.abs(d))}return 100-100/(1+g/(l||1e-4))
}
function slopeUp(h,bars,minPct){if(!h||h.length<bars+1)return false;const r=h.slice(-(bars+1));for(let i=1;i<r.length;i++){if((r[i]-r[i-1])/r[i-1]*100<minPct)return false}return true}
function slopeDn(h,bars,minPct){if(!h||h.length<bars+1)return false;const r=h.slice(-(bars+1));for(let i=1;i<r.length;i++){if((r[i-1]-r[i])/r[i-1]*100<minPct)return false}return true}
function gapBull(e9,e20,e40,e80,g1,g2,g3){return(g1===0?e9>e20:e9>e20*(1+g1/100))&&(g2===0?e20>e40:e20>e40*(1+g2/100))&&(g3===0?e40>e80:e40>e80*(1+g3/100))}
function gapBear(e9,e20,e40,e80,g1,g2,g3){return(g1===0?e9<e20:e9<e20*(1-g1/100))&&(g2===0?e20<e40:e20<e40*(1-g2/100))&&(g3===0?e40<e80:e40<e80*(1-g3/100))}
function wickBull(cds,e40,pct){if(!pct)return true;return Math.min(...cds.slice(-3).map(c=>c.l))<e40*(1+pct/100)}
function wickBear(cds,e40,pct){if(!pct)return true;return Math.max(...cds.slice(-3).map(c=>c.h))>e40*(1-pct/100)}
export function calcStrength(rsiVal,dir,cds,h9,h20,h40){
  let s=0;const dist=dir==='bull'?rsiVal-50:50-rsiVal;s+=dist>=20?3:dist>=10?2:dist>=3?1:0
  ;[h9,h20,h40].filter(Boolean).forEach(h=>{if(h.length<2)return;const r=h.slice(-4);let tot=0;for(let i=1;i<r.length;i++){const chg=dir==='bull'?(r[i]-r[i-1])/r[i-1]*100:(r[i-1]-r[i])/r[i-1]*100;tot+=Math.max(0,chg)};const avg=tot/(r.length-1);s+=avg>=0.15?1.4:avg>=0.07?0.9:avg>=0.02?0.4:0})
  if(cds?.length){const lc=cds[cds.length-1],bp=Math.abs(lc.c-lc.o)/((lc.h-lc.l)||1e-4)*100;s+=bp>=70?3:bp>=50?2:bp>=30?1:0}
  return Math.min(10,Math.max(1,Math.round(s)))
}
export const DEFAULT_SLOPE={e9:{enabled:true,bars:1,minPct:0},e20:{enabled:true,bars:2,minPct:0.015},e40:{enabled:true,bars:2,minPct:0.015},e80:{enabled:true,bars:2,minPct:0}}
export const DEFAULT_SETTINGS={slope:DEFAULT_SLOPE,gap9_20:0.015,gap20_40:0.025,gap40_80:0,gapEnabled:true,rsiTolerance:20,rsiCapEnabled:true,wickTouchPct:1.5,wickEnabled:true,scoreFilterEnabled:false,scoreMin:5,soundEnabled:true,tgOn:true,tgToken:'',tgChatId:''}
export function detectBull(candles,cfg={}){
  const s={...DEFAULT_SETTINGS,...cfg};if(!candles||candles.length<85)return{ok:false}
  const cl=candles.map(c=>c.c),n=cl.length,e9=calcEMA(cl,9),e20=calcEMA(cl,20),e40=calcEMA(cl,40),e80=calcEMA(cl,80)
  const rsiVal=calcRSI(cl),price=cl[n-1],prevPrice=cl[n-2],lc=candles[n-1]
  const sl=s.slope||DEFAULT_SLOPE,maxBars=Math.max(sl.e9.bars,sl.e20.bars,sl.e40.bars,sl.e80.bars)+2
  const h9=calcEMAHistory(cl,9,maxBars),h20=calcEMAHistory(cl,20,maxBars),h40=calcEMAHistory(cl,40,maxBars),h80=calcEMAHistory(cl,80,maxBars)
  const emaOrdered=e9>e20&&e20>e40&&e40>=e80*.995
  const emaGapOk=s.gapEnabled?gapBull(e9,e20,e40,e80,s.gap9_20,s.gap20_40,s.gap40_80):true
  const nearAllEmas=price>=e80*.97&&price<=e9*1.03,aboveEma20=price>e20,nearEma9=price>=e9*.995
  // Cross: check if price crossed EMA9 within last 5 candles
  const lookback=Math.min(5,n-1)
  const recentCross=cl.slice(n-lookback-1,n).some((p,i,arr)=>i>0&&arr[i-1]<=calcEMA(cl.slice(0,n-lookback+i),9)&&p>calcEMA(cl.slice(0,n-lookback+i+1),9))
  const bullCross=recentCross||(prevPrice<=e9&&price>e9)||(candles[n-2]?.c<=e9*1.005&&price>e9*1.005),bullCandle=lc.c>lc.o
  const rsiOk=s.rsiCapEnabled&&s.rsiTolerance<50?rsiVal>50&&rsiVal<=50+s.rsiTolerance:rsiVal>50
  const wickOk=s.wickEnabled?wickBull(candles,e40,s.wickTouchPct):true
  const r9=sl.e9.enabled?slopeUp(h9,sl.e9.bars,sl.e9.minPct):true,r20=sl.e20.enabled?slopeUp(h20,sl.e20.bars,sl.e20.minPct):true
  const r40=sl.e40.enabled?slopeUp(h40,sl.e40.bars,sl.e40.minPct):true,r80=sl.e80.enabled?slopeUp(h80,sl.e80.bars,sl.e80.minPct):true
  const checks={emaOrdered,emaGapOk,nearAllEmas,aboveEma20,nearEma9,bullCross,bullCandle,rsiOk,wickOk,r9,r20,r40,r80}
  const ok=Object.values(checks).every(Boolean),strength=ok?calcStrength(rsiVal,'bull',candles,h9,h20,h40):0
  return{ok,e9,e20,e40,e80,rsi:rsiVal,price,h9,h20,h40,h80,checks,strength}
}
export function detectBear(candles,cfg={}){
  const s={...DEFAULT_SETTINGS,...cfg};if(!candles||candles.length<85)return{ok:false}
  const cl=candles.map(c=>c.c),n=cl.length,e9=calcEMA(cl,9),e20=calcEMA(cl,20),e40=calcEMA(cl,40),e80=calcEMA(cl,80)
  const rsiVal=calcRSI(cl),price=cl[n-1],prevPrice=cl[n-2],lc=candles[n-1]
  const sl=s.slope||DEFAULT_SLOPE,maxBars=Math.max(sl.e9.bars,sl.e20.bars,sl.e40.bars,sl.e80.bars)+2
  const h9=calcEMAHistory(cl,9,maxBars),h20=calcEMAHistory(cl,20,maxBars),h40=calcEMAHistory(cl,40,maxBars),h80=calcEMAHistory(cl,80,maxBars)
  const emaOrdered=e9<e20&&e20<e40&&e40<=e80*1.005
  const emaGapOk=s.gapEnabled?gapBear(e9,e20,e40,e80,s.gap9_20,s.gap20_40,s.gap40_80):true
  const nearAllEmas=price<=e80*1.03&&price>=e9*.97,belowEma20=price<e20,nearEma9=price<=e9*1.005
  const lookbackB=Math.min(5,n-1)
  const recentCrossB=cl.slice(n-lookbackB-1,n).some((p,i,arr)=>i>0&&arr[i-1]>=calcEMA(cl.slice(0,n-lookbackB+i),9)&&p<calcEMA(cl.slice(0,n-lookbackB+i+1),9))
  const bearCross=recentCrossB||(prevPrice>=e9&&price<e9)||(candles[n-2]?.c>=e9*.995&&price<e9*.995),bearCandle=lc.c<lc.o
  const rsiOk=s.rsiCapEnabled&&s.rsiTolerance<50?rsiVal<50&&rsiVal>=50-s.rsiTolerance:rsiVal<50
  const wickOk=s.wickEnabled?wickBear(candles,e40,s.wickTouchPct):true
  const f9=sl.e9.enabled?slopeDn(h9,sl.e9.bars,sl.e9.minPct):true,f20=sl.e20.enabled?slopeDn(h20,sl.e20.bars,sl.e20.minPct):true
  const f40=sl.e40.enabled?slopeDn(h40,sl.e40.bars,sl.e40.minPct):true,f80=sl.e80.enabled?slopeDn(h80,sl.e80.bars,sl.e80.minPct):true
  const checks={emaOrdered,emaGapOk,nearAllEmas,belowEma20,nearEma9,bearCross,bearCandle,rsiOk,wickOk,f9,f20,f40,f80}
  const ok=Object.values(checks).every(Boolean),strength=ok?calcStrength(rsiVal,'bear',candles,h9,h20,h40):0
  return{ok,e9,e20,e40,e80,rsi:rsiVal,price,h9,h20,h40,h80,checks,strength}
}
