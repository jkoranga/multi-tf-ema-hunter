import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchCandles, fetchTicker } from './api.js'
import { detectBull, detectBear, DEFAULT_SETTINGS, calcEMA } from './signals.js'
import { PAIRS, MCAP_RANGES, VOL_MIN } from './pairs.js'
import { loginWithGoogle, loginWithEmail, registerWithEmail, logout, onAuthChange, saveSignal, fetchSignals, deleteSignal, deleteAllSignals, updateSignal, saveSettings, fetchSettings, sendTelegram, buildTgMessage, saveScanResult, fetchScanHistory, clearScanHistory } from './firebase.js'

// ── OneSignal ────────────────────────────────────────────────
const OS_APP_ID = '8ef4fedd-fb79-4a04-a445-fcc5857cbd81'

async function getOS() {
  // SDK already initialized by index.html — just wait for it to be ready
  if (window.OneSignal) return window.OneSignal
  return new Promise((resolve, reject) => {
    window.OneSignalDeferred = window.OneSignalDeferred || []
    window.OneSignalDeferred.push((OS) => resolve(OS))
    setTimeout(() => reject(new Error('OneSignal not available — reload the page and try again')), 8000)
  })
}

async function enableOneSignalPush(setPushOn) {
  try {
    if (!('Notification' in window)) { alert('Your browser does not support push notifications. Please use Chrome.'); return }
    if (Notification.permission === 'denied') { alert('Notifications are blocked.\n\nFix: tap the lock icon in your browser address bar → Allow Notifications → reload the page.'); return }
    const OS = await getOS()
    const already = OS.User?.PushSubscription?.optedIn || false
    if (already) {
      // Already subscribed — just update state
      setPushOn(true); localStorage.setItem('pushOn', 'true'); return
    }
    // Try silent opt-in first (works if permission was previously granted)
    try {
      await OS.User.PushSubscription.optIn()
      await new Promise(r => setTimeout(r, 1500))
      const opted = OS.User?.PushSubscription?.optedIn || false
      if (opted) { setPushOn(true); localStorage.setItem('pushOn', 'true'); return }
    } catch {}
    // Fall back to permission prompt
    await OS.Notifications.requestPermission()
    await new Promise(r => setTimeout(r, 2000))
    const opted = OS.User?.PushSubscription?.optedIn || false
    setPushOn(opted); localStorage.setItem('pushOn', String(opted))
    if (opted) alert('✅ Push notifications enabled!')
    else alert('❌ Could not subscribe.\n\nTap the lock icon in your browser → Allow Notifications → reload and try again.')
  } catch (e) {
    alert('Push error: ' + e.message + '\n\n• Use Chrome\n• Allow notifications when prompted\n• Reload and try again')
  }
}

async function isOneSignalSubscribed() {
  try { return window.OneSignal?.User?.PushSubscription?.optedIn || false } catch { return false }
}

// ── Theme ────────────────────────────────────────────────────
const D={bg:'#060a12',panel:'#0a1220',p2:'#0d1828',brd:'#152235',brd2:'#1e3350',txt:'#e2eeff',ts:'#7a9dc4',tm:'#3a5878',td:'#1a3050',bull:'#00e676',bear:'#ff3d5a',acc:'#00b4ff',warn:'#ffaa00',pink:'#ff6b9d',gold:'#ffc107',cb:'rgba(0,230,118,0.05)',cr:'rgba(255,61,90,0.05)',gl:'rgba(0,180,255,0.015)',sh:'rgba(0,0,0,0.95)',hb:'rgba(0,230,118,0.07)',hr:'rgba(255,61,90,0.07)'}
const L={bg:'#f0f5fc',panel:'#ffffff',p2:'#f7faff',brd:'#d0dcea',brd2:'#a0bcd8',txt:'#0d1f35',ts:'#1a3550',tm:'#3a6080',td:'#7a9ab8',bull:'#00897b',bear:'#d32f2f',acc:'#0277bd',warn:'#ef6c00',pink:'#ad1457',gold:'#f57f17',cb:'rgba(0,137,123,0.06)',cr:'rgba(211,47,47,0.06)',gl:'rgba(2,119,189,0.02)',sh:'rgba(0,0,0,0.15)',hb:'rgba(0,137,123,0.07)',hr:'rgba(211,47,47,0.07)'}

const fp=v=>{if(!v)return'0';if(v<1e-6)return v.toFixed(10);if(v<.0001)return v.toFixed(8);if(v<1)return v.toFixed(4);if(v<100)return v.toFixed(2);return v.toLocaleString('en-US',{maximumFractionDigits:0})}
const fv=v=>v>=1000?(v/1000).toFixed(1)+'B':v.toFixed(0)+'M'
const fm=v=>v>=1000?(v/1000).toFixed(0)+'B':v+'M'
const tvInterval=tf=>tf==='5m'?5:tf==='15m'?15:tf==='1h'?60:tf==='4h'?240:15
const tvL=(s,tf='15m')=>`https://www.tradingview.com/chart/?symbol=BINANCE:${s}&interval=${tvInterval(tf)}`
const fdt=ts=>{const d=new Date(ts);return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}
const fdtDate=ts=>new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'})
const fdtTime=ts=>new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})
function playAlert(dir){try{const ctx=new(window.AudioContext||window.webkitAudioContext)();[dir==='bull'?523:784,dir==='bull'?659:659,dir==='bull'?784:523].forEach((f,i)=>{const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='sine';g.gain.setValueAtTime(.12,ctx.currentTime+i*.12);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+i*.12+.22);o.start(ctx.currentTime+i*.12);o.stop(ctx.currentTime+i*.12+.22)})}catch{}}

// ── Components ───────────────────────────────────────────────
function TgTestBtn({token,chatId,T}){
  const [st,setSt]=useState('idle') // idle | sending | ok | fail
  const send=async()=>{
    if(!token||!chatId){setSt('fail');setTimeout(()=>setSt('idle'),3000);return}
    setSt('sending')
    try{
      const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:'✅ EMA Signal Hunter — Telegram connected successfully!',parse_mode:'HTML'})})
      const d=await r.json()
      setSt(d.ok?'ok':'fail')
    }catch{setSt('fail')}
    setTimeout(()=>setSt('idle'),4000)
  }
  const color=st==='ok'?T.bull:st==='fail'?T.bear:T.acc
  const label=st==='sending'?'SENDING..':st==='ok'?'✓ SENT!':st==='fail'?'✗ FAILED':'SEND TEST MSG'
  return <button onClick={send} disabled={st==='sending'} style={{width:'100%',marginTop:8,marginBottom:6,padding:'9px 12px',border:`1px solid ${color}55`,background:`${color}10`,color:color,fontFamily:'JetBrains Mono,monospace',fontSize:11,fontWeight:700,cursor:st==='sending'?'wait':'pointer',borderRadius:6,letterSpacing:.5,transition:'all .2s'}}>{label}</button>
}
function Confirm({T,title,msg,okLabel,okColor,onOk,onCancel}){return <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.85)',zIndex:9000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}><div style={{background:T.panel,border:`1px solid ${T.brd2}`,padding:'28px 24px',maxWidth:320,width:'100%',borderRadius:12,boxShadow:`0 20px 60px ${T.sh}`}}><div style={{fontSize:17,fontWeight:700,color:T.txt,marginBottom:8,fontFamily:'Rajdhani,sans-serif',letterSpacing:.5}}>{title}</div><div style={{fontSize:12,color:T.ts,marginBottom:22,lineHeight:1.7,fontFamily:'JetBrains Mono,monospace'}}>{msg}</div><div style={{display:'flex',gap:10}}><button onClick={onCancel} style={{flex:1,padding:11,border:`1px solid ${T.brd}`,background:'transparent',color:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:11,cursor:'pointer',fontWeight:700,borderRadius:6}}>CANCEL</button><button onClick={onOk} style={{flex:1,padding:11,border:`1px solid ${okColor||T.bear}`,background:`${okColor||T.bear}18`,color:okColor||T.bear,fontFamily:'JetBrains Mono,monospace',fontSize:11,cursor:'pointer',fontWeight:700,borderRadius:6}}>{okLabel||'DELETE'}</button></div></div></div>}

function Tog({on,onChange,T,color}){const c=color||T.acc;return <div onClick={()=>onChange(!on)} style={{width:42,height:24,borderRadius:12,cursor:'pointer',background:on?c:T.brd,transition:'all .25s',position:'relative',flexShrink:0,boxShadow:on?`0 0 12px ${c}66`:'none'}}><div style={{position:'absolute',top:3,left:on?20:3,width:18,height:18,borderRadius:'50%',background:'#fff',transition:'left .25s',boxShadow:'0 2px 4px rgba(0,0,0,.3)'}}/></div>}

function Score({s,T,sm}){const c=s>=8?T.bull:s>=6?T.gold:s>=4?T.warn:T.bear,sz=sm?28:36,inner=sm?20:26;return <div style={{width:sz,height:sz,borderRadius:'50%',background:`conic-gradient(${c} ${s*36}deg,${T.brd} 0)`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,boxShadow:`0 0 8px ${c}44`}}><div style={{width:inner,height:inner,borderRadius:'50%',background:T.panel,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'JetBrains Mono,monospace',fontSize:sm?8:10,fontWeight:900,color:c}}>{s}</div></div>}

function MC({cds,dir,T,W=90,H=30}){if(!cds?.length)return null;const vis=cds.slice(-14),mx=Math.max(...vis.map(c=>c.h)),mn=Math.min(...vis.map(c=>c.l)),rng=mx-mn||1,bw=W/vis.length,sy=v=>H-((v-mn)/rng)*H,cl=vis.map(c=>c.c),e9h=cl.map((_,i)=>calcEMA(cl.slice(0,i+1),Math.min(9,i+1))),e20h=cl.map((_,i)=>calcEMA(cl.slice(0,i+1),Math.min(20,i+1)));return <svg width={W} height={H} style={{display:'block',flexShrink:0}}>{vis.map((c,i)=>{const x=i*bw+bw*.14,cw=bw*.72,bu=c.c>=c.o,col=bu?T.bull:T.bear,bt=sy(Math.max(c.o,c.c)),bh=Math.max(1.5,Math.abs(sy(c.o)-sy(c.c)));return<g key={i}><line x1={x+cw/2} y1={sy(c.h)} x2={x+cw/2} y2={sy(c.l)} stroke={col} strokeWidth={.6} opacity={.5}/><rect x={x} y={bt} width={cw} height={bh} fill={col} opacity={.9} rx={.5}/></g>})} <polyline points={e20h.map((v,i)=>`${i*bw+bw/2},${sy(v)}`).join(' ')} fill="none" stroke={T.pink} strokeWidth={1.3} opacity={.9} strokeLinecap="round"/><polyline points={e9h.map((v,i)=>`${i*bw+bw/2},${sy(v)}`).join(' ')} fill="none" stroke={dir==='bull'?T.bull:T.bear} strokeWidth={1.1} opacity={.75} strokeDasharray="2,1.5"/></svg>}

function RSIA({rv,T,sm}){const r=sm?14:20,cx=sm?18:26,cy=sm?18:26,ang=(Math.min(100,Math.max(0,rv))/100)*Math.PI,x=cx+r*Math.cos(Math.PI-ang),y=cy-r*Math.sin(ang),col=rv>70?T.warn:rv<30?T.bear:rv>50?T.bull:T.acc;return <svg width={sm?36:52} height={sm?20:30} style={{display:'block',flexShrink:0}}><path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke={T.brd} strokeWidth={sm?2.5:3}/><path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${x} ${y}`} fill="none" stroke={col} strokeWidth={sm?2.5:3} strokeLinecap="round"/><text x={cx} y={cy} textAnchor="middle" fill={col} fontSize={sm?7:9} fontFamily="JetBrains Mono,monospace" fontWeight="bold">{rv.toFixed(0)}</text></svg>}

function LoginPage({T,onSkip}){
  const[mode,setMode]=useState('login'),[email,setEmail]=useState(''),[pass,setPass]=useState(''),[err,setErr]=useState(''),[loading,setLoading]=useState(false)
  const doG=async()=>{setLoading(true);setErr('');try{await loginWithGoogle()}catch(e){const m=e.message||'';setErr(m.includes('unauthorized-domain')?'Add your Vercel URL to Firebase -> Authentication -> Authorized domains':'Google login failed - try email instead')};setLoading(false)}
  const doE=async()=>{if(!email||!pass){setErr('Enter email and password');return}setLoading(true);setErr('');try{mode==='login'?await loginWithEmail(email,pass):await registerWithEmail(email,pass)}catch(e){const m=e.message||'';setErr(m.includes('invalid-credential')||m.includes('wrong-password')?'Wrong email or password':m.includes('already-in-use')?'Email already registered':m.includes('weak-password')?'Password needs 6+ characters':'Login failed')};setLoading(false)}
  return <div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh',padding:20,background:T.bg}}>
    <div style={{background:T.panel,border:`1px solid ${T.brd2}`,padding:'40px 32px',width:'100%',maxWidth:380,borderRadius:16,boxShadow:`0 24px 80px ${T.sh}`}}>
      <div style={{textAlign:'center',marginBottom:32}}>
        <div style={{fontSize:28,fontWeight:900,letterSpacing:3,marginBottom:6,fontFamily:'Rajdhani,sans-serif'}}><span style={{color:T.acc}}>EMA-</span><span style={{color:T.bull}}>SIGNAL</span><span style={{color:T.txt}}>-HUNTER</span></div>
        <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.tm,letterSpacing:2}}>v9.17 - MULTI-TF · PARALLEL · 150+ PAIRS</div>
      </div>
      <button onClick={doG} disabled={loading} style={{width:'100%',padding:13,background:'transparent',border:`1px solid ${T.brd2}`,color:T.txt,fontFamily:'Rajdhani,sans-serif',fontSize:14,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:12,marginBottom:16,borderRadius:8,transition:'all .2s'}}>
        <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.2 0 5.9 1.1 8.1 2.9l6-6C34.5 3.1 29.6 1 24 1 14.9 1 7.1 6.4 3.5 14.1l7 5.4C12.4 13.4 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.4 5.5-5 7.2l7.7 6c4.5-4.1 7.1-10.2 7.1-17.2z"/><path fill="#FBBC05" d="M10.5 28.5c-.5-1.5-.8-3-.8-4.5s.3-3 .8-4.5L3.5 14C1.3 18.1 0 22.9 0 28s1.3 9.9 3.5 14l7-5.5z"/><path fill="#34A853" d="M24 47c5.6 0 10.4-1.9 13.8-5.1l-7.7-6c-2 1.4-4.5 2.2-6.1 2.2-6.3 0-11.6-3.9-13.5-9.6l-7 5.5C7.1 41.6 14.9 47 24 47z"/></svg>
        Continue with Google
      </button>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}><div style={{flex:1,height:1,background:T.brd}}/><span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.tm}}>or email</span><div style={{flex:1,height:1,background:T.brd}}/></div>
      <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" style={{width:'100%',padding:'12px 14px',background:`${T.acc}08`,border:`1px solid ${T.brd}`,color:T.txt,fontFamily:'JetBrains Mono,monospace',fontSize:13,marginBottom:10,outline:'none',borderRadius:8,boxSizing:'border-box'}}/>
      <input value={pass} onChange={e=>setPass(e.target.value)} placeholder="Password" type="password" onKeyDown={e=>e.key==='Enter'&&doE()} style={{width:'100%',padding:'12px 14px',background:`${T.acc}08`,border:`1px solid ${T.brd}`,color:T.txt,fontFamily:'JetBrains Mono,monospace',fontSize:13,marginBottom:14,outline:'none',borderRadius:8,boxSizing:'border-box'}}/>
      {err&&<div style={{color:T.bear,fontFamily:'JetBrains Mono,monospace',fontSize:10,marginBottom:12,padding:'8px 10px',background:`${T.bear}10`,border:`1px solid ${T.bear}33`,lineHeight:1.6,borderRadius:6}}>{err}</div>}
      <button onClick={doE} disabled={loading} style={{width:'100%',padding:13,background:`${T.acc}18`,border:`2px solid ${T.acc}`,color:T.acc,fontFamily:'Rajdhani,sans-serif',fontSize:15,fontWeight:700,cursor:'pointer',letterSpacing:2,borderRadius:8,transition:'all .2s'}}>{loading?'...':(mode==='login'?'LOGIN':'CREATE ACCOUNT')}</button>
      <div style={{textAlign:'center',marginTop:12}}><button onClick={()=>setMode(m=>m==='login'?'register':'login')} style={{background:'none',border:'none',color:T.tm,cursor:'pointer',fontFamily:'JetBrains Mono,monospace',fontSize:10,textDecoration:'underline',padding:0}}>{mode==='login'?'No account? Register':'Have account? Login'}</button></div>
      <div style={{textAlign:'center',marginTop:16,paddingTop:14,borderTop:`1px solid ${T.brd}`}}><button onClick={onSkip} style={{background:'none',border:'none',color:T.tm,cursor:'pointer',fontFamily:'JetBrains Mono,monospace',fontSize:10,padding:0}}>Continue without account</button></div>
    </div>
  </div>
}

function SigCard({sig,T,onSave,saved,isNew}){
  const bull=sig.dir==='bull',ac=bull?T.bull:T.bear,age=Math.floor((Date.now()-sig.ts)/60000)
  const isFutures=sig.market==='futures'
  return <div style={{background:bull?T.cb:T.cr,border:`1px solid ${bull?T.bull+'30':T.bear+'30'}`,borderLeft:`3px solid ${ac}`,padding:'12px 14px',position:'relative',overflow:'hidden',opacity:age>30?.65:1,animation:isNew?'slideIn .35s cubic-bezier(.22,1,.36,1)':'none',borderRadius:8,marginBottom:1}}>
    {isNew&&<div style={{position:'absolute',top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${ac},transparent)`,animation:'fadeOut 2s forwards'}}/>}
    <div style={{display:'flex',alignItems:'center',gap:10}}>
      <Score s={sig.strength||1} T={T}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:4}}>
          <span className="t-pair" style={{fontFamily:'Rajdhani,sans-serif',fontSize:17,fontWeight:800,color:T.txt,letterSpacing:.5}}>{sig.pair.replace('USDT','')}<span className="t-sub" style={{fontSize:11,color:T.tm,fontWeight:500}}>/USDT</span></span>
          {isFutures&&<span style={{fontSize:9,padding:'2px 6px',background:`${T.warn}20`,border:`1px solid ${T.warn}44`,color:T.warn,fontFamily:'JetBrains Mono,monospace',fontWeight:700,borderRadius:4}}>PERP</span>}
          <span className="t-dir" style={{fontFamily:'Rajdhani,sans-serif',fontSize:14,fontWeight:700,color:ac}}>{bull?' LONG':' SHORT'}</span>
          <span className="t-price" style={{fontFamily:'JetBrains Mono,monospace',fontSize:13,color:T.acc,fontWeight:700}}>${fp(sig.price)}</span>
          {sig.change24h!=null&&<span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:sig.change24h>=0?T.bull:T.bear,fontWeight:700}}>{sig.change24h>=0?'+':''}{sig.change24h.toFixed(2)}%</span>}
        </div>
        <div style={{display:'flex',gap:5,flexWrap:'wrap',alignItems:'center'}}>
          {[['RSI '+sig.rsi?.toFixed(0),T.ts],[fm(sig.mcap),T.tm],sig.vol24h?[fv(sig.vol24h)+' vol',T.tm]:null].filter(Boolean).map(([l,c],i)=><span key={i} style={{fontSize:10,padding:'2px 7px',border:`1px solid ${c}33`,color:c,fontFamily:'JetBrains Mono,monospace',background:`${c}08`,borderRadius:4}}>{l}</span>)}
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center',marginTop:5}}>
          <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.td,letterSpacing:.3}}>{fdtDate(sig.ts)}</span>
          <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.ts,fontWeight:700}}>{fdtTime(sig.ts)}</span>
          {age>0&&<span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.td}}>{age}m ago</span>}
        </div>
      </div>
      <RSIA rv={sig.rsi} T={T} sm/>
      <MC cds={sig.cds} dir={sig.dir} T={T}/>
      <div style={{display:'flex',flexDirection:'column',gap:5,flexShrink:0}}>
        <button onClick={e=>{e.stopPropagation();onSave&&onSave(sig)}} style={{padding:'5px 9px',border:`1px solid ${saved?T.bull:T.brd}`,background:saved?`${T.bull}18`:'transparent',color:saved?T.bull:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',fontWeight:700,transition:'all .2s',borderRadius:5}}>{saved?' saved':'+ save'}</button>
        <a href={tvL(sig.pair,sig.tf||'15m')} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{padding:'5px 9px',border:`1px solid ${T.acc}44`,background:`${T.acc}0c`,color:T.acc,fontFamily:'JetBrains Mono,monospace',fontSize:9,textDecoration:'none',fontWeight:700,textAlign:'center',borderRadius:5}}>📈 TV</a>
      </div>
    </div>
  </div>
}

function Toast({sig,onDone,T}){
  useEffect(()=>{const t=setTimeout(onDone,8000);return()=>clearTimeout(t)},[])
  const bull=sig.dir==='bull',ac=bull?T.bull:T.bear
  return <div style={{position:'fixed',bottom:20,right:16,zIndex:9999,background:T.panel,borderLeft:`3px solid ${ac}`,border:`1px solid ${ac}44`,padding:'12px 16px',maxWidth:300,boxShadow:`0 8px 32px ${T.sh}`,animation:'slideIn .3s cubic-bezier(.22,1,.36,1)',borderRadius:10}}>
    <div style={{display:'flex',alignItems:'center',gap:10}}>
      <Score s={sig.strength||1} T={T} sm/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:15,fontWeight:800,color:ac}}>{bull?'':''} {sig.pair.replace('USDT','')} {!bull?'':''}</div>
        <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.ts}}>${fp(sig.price)} - RSI {sig.rsi?.toFixed(0)} - Score {sig.strength}/10</div>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:4,flexShrink:0}}>
        <a href={tvL(sig.pair,sig.tf||'15m')} target="_blank" rel="noreferrer" style={{padding:'5px 8px',border:`1px solid ${ac}44`,background:`${ac}12`,color:ac,fontFamily:'Rajdhani,sans-serif',fontSize:11,fontWeight:700,textDecoration:'none',borderRadius:5,textAlign:'center'}}>TV&nbsp;&gt;</a>
        <button onClick={onDone} style={{padding:'4px 8px',border:`1px solid ${T.brd}`,background:'transparent',color:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',borderRadius:5}}>✕ close</button>
      </div>
    </div>
  </div>
}


function WatchlistTab({T,watchlist,setWatchlist,wInput,setWInput,setMarket,setPage}){
  const addToWatchlist=()=>{
    const p=wInput.toUpperCase().trim()
    if(!p)return
    const sym=p.includes('USDT')?p:p+'USDT'
    if(watchlist.includes(sym)){alert(`${sym} already in watchlist`);return}
    const updated=[...watchlist,sym]
    setWatchlist(updated)
    try{localStorage.setItem('watchlist_v9',JSON.stringify(updated))}catch{}
    setWInput('')
  }
  const removeFromWatchlist=sym=>{
    const updated=watchlist.filter(s=>s!==sym)
    setWatchlist(updated)
    try{localStorage.setItem('watchlist_v9',JSON.stringify(updated))}catch{}
  }
  const scanWatchlist=()=>{
    if(watchlist.length===0){alert('Add symbols to your watchlist first');return}
    setMarket('watchlist')
    setPage('scanner')
  }
  const popularPairs=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','PEPEUSDT','SUIUSDT','AVAXUSDT','LINKUSDT']
  return <div>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,paddingBottom:10,borderBottom:`1px solid ${T.brd}`}}>
      <div>
        <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:18,fontWeight:800,color:T.txt}}>⭐ Watchlist</div>
        <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.tm,marginTop:3}}>{watchlist.length} symbols - scan only these</div>
      </div>
      {watchlist.length>0&&<button onClick={scanWatchlist} style={{padding:'10px 16px',border:`2px solid ${T.bull}`,background:`${T.bull}15`,color:T.bull,fontFamily:'Rajdhani,sans-serif',fontSize:13,fontWeight:800,cursor:'pointer',borderRadius:8,letterSpacing:1}}>▶ SCAN LIST</button>}
    </div>

    {/* Add symbol */}
    <div style={{background:T.panel,border:`1px solid ${T.acc}33`,borderRadius:10,padding:14,marginBottom:14}}>
      <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.tm,marginBottom:8}}>Add symbol to watchlist:</div>
      <div style={{display:'flex',gap:8}}>
        <input value={wInput} onChange={e=>setWInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addToWatchlist()} placeholder="e.g. BTC or BTCUSDT" style={{flex:1,padding:'10px 12px',background:`${T.acc}06`,border:`1px solid ${T.brd}`,color:T.txt,fontFamily:'JetBrains Mono,monospace',fontSize:12,outline:'none',borderRadius:8}}/>
        <button onClick={addToWatchlist} style={{padding:'10px 16px',border:`2px solid ${T.acc}`,background:`${T.acc}15`,color:T.acc,fontFamily:'Rajdhani,sans-serif',fontSize:13,fontWeight:800,cursor:'pointer',borderRadius:8}}>+ ADD</button>
      </div>
    </div>

    {/* Quick add popular */}
    <div style={{marginBottom:14}}>
      <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,marginBottom:8,letterSpacing:1}}>QUICK ADD:</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
        {popularPairs.filter(p=>!watchlist.includes(p)).map(p=><button key={p} onClick={()=>{const updated=[...watchlist,p];setWatchlist(updated);try{localStorage.setItem('watchlist_v9',JSON.stringify(updated))}catch{}}} style={{padding:'5px 10px',border:`1px solid ${T.brd}`,background:T.panel,color:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',borderRadius:6,transition:'all .15s'}}>+ {p.replace('USDT','')}</button>)}
      </div>
    </div>

    {/* Watchlist items */}
    {watchlist.length===0?<div style={{textAlign:'center',padding:48,border:`2px dashed ${T.brd}`,background:T.panel,borderRadius:12}}>
      <div style={{fontSize:36,opacity:.15,marginBottom:12}}>⭐</div>
      <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:14,color:T.ts,letterSpacing:2,marginBottom:8}}>WATCHLIST EMPTY</div>
      <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,color:T.tm}}>Add symbols above to create your watchlist</div>
    </div>
    :<div style={{display:'flex',flexDirection:'column',gap:6}}>
      {watchlist.map((sym,i)=>{
        const base=sym.replace('USDT','')
        return <div key={sym} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 14px',background:T.panel,border:`1px solid ${T.brd}`,borderRadius:8}}>
          <div style={{width:36,height:36,borderRadius:8,background:`${T.acc}15`,border:`1px solid ${T.acc}33`,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'Rajdhani,sans-serif',fontSize:13,fontWeight:800,color:T.acc,flexShrink:0}}>{base.slice(0,3)}</div>
          <div style={{flex:1}}>
            <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:16,fontWeight:800,color:T.txt}}>{base}<span style={{fontSize:11,color:T.tm,fontWeight:400}}>/USDT</span></div>
            <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,marginTop:2}}>#{i+1} in watchlist</div>
          </div>
          <a href={`https://www.tradingview.com/chart/?symbol=BINANCE:${sym}&interval=${tvInterval(cfgSnap.timeframe||'15m')}`} target="_blank" rel="noreferrer" style={{padding:'5px 9px',border:`1px solid ${T.acc}33`,background:`${T.acc}08`,color:T.acc,fontFamily:'JetBrains Mono,monospace',fontSize:9,textDecoration:'none',borderRadius:5}}>📈 TV</a>
          <button onClick={()=>removeFromWatchlist(sym)} style={{padding:'5px 9px',border:`1px solid ${T.bear}44`,background:`${T.bear}08`,color:T.bear,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',borderRadius:5}}>✕</button>
        </div>
      })}
      <button onClick={()=>{setWatchlist([]);try{localStorage.removeItem('watchlist_v9')}catch{}}} style={{padding:'8px',border:`1px solid ${T.bear}33`,background:'transparent',color:T.bear,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',borderRadius:8,marginTop:4}}>🗑 Clear All</button>
    </div>}
  </div>
}

function SavedTab({T,user,local,onDelLocal,onDelAllLocal}){
  const[sigs,setSigs]=useState([]),[loading,setLoading]=useState(false),[filter,setFilter]=useState('all'),[sort,setSort]=useState('date'),[exp,setExp]=useState(null),[editId,setEditId]=useState(null),[noteText,setNoteText]=useState(''),[cDel,setCDel]=useState(null),[cAll,setCAll]=useState(false)
  const[history,setHistory]=useState([]),[histLoading,setHistLoading]=useState(false),[histTab,setHistTab]=useState('saved'),[cClearHist,setCClearHist]=useState(false)
  const load=useCallback(async()=>{if(!user)return;setLoading(true);setSigs(await fetchSignals(user.uid));setLoading(false)},[user])
  const loadHistory=useCallback(async()=>{if(!user)return;setHistLoading(true);setHistory(await fetchScanHistory(user.uid));setHistLoading(false)},[user])
  useEffect(()=>{load()},[load])
  useEffect(()=>{if(histTab==='history')loadHistory()},[histTab,loadHistory])
  const all=user?sigs:local,filtered=all.filter(s=>filter==='all'||s.dir===filter).sort((a,b)=>sort==='score'?(b.strength||0)-(a.strength||0):((b.savedAt?.seconds||0)-(a.savedAt?.seconds||0)||((b.signalTs||b.ts||0)-(a.signalTs||a.ts||0))))
  const wins=all.filter(s=>s.outcome==='win').length,losses=all.filter(s=>s.outcome==='loss').length
  const doDel=async()=>{const id=cDel;setCDel(null);if(user){await deleteSignal(id);setSigs(p=>p.filter(s=>s.id!==id))}else onDelLocal(id)}
  const doAll=async()=>{setCAll(false);if(user){await deleteAllSignals(user.uid);setSigs([])}else onDelAllLocal()}
  const doOut=async(id,o)=>{if(user){await updateSignal(id,{outcome:o});setSigs(p=>p.map(s=>s.id===id?{...s,outcome:o}:s))}}
  const doNote=async(id)=>{if(user){await updateSignal(id,{notes:noteText});setSigs(p=>p.map(s=>s.id===id?{...s,notes:noteText}:s))};setEditId(null)}
  const exportCSV=()=>{const rows=[['Pair','Dir','Price','RSI','Score','Outcome','Notes','Date']];filtered.forEach(s=>rows.push([s.pair,s.dir,fp(s.price),s.rsi?.toFixed(1)||'',s.strength||'',s.outcome||'open',(s.notes||'').replace(/,/g,' '),fdt(s.savedAt?.seconds*1000||s.signalTs||s.ts||0)]));const blob=new Blob([rows.map(r=>r.join(',')).join('\n')],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='signals.csv';a.click()}
  return <div>
    {cDel&&<Confirm T={T} title="Delete Signal?" msg="Remove permanently?" okLabel="DELETE" onOk={doDel} onCancel={()=>setCDel(null)}/>}
    {cAll&&<Confirm T={T} title={`Delete All ${all.length}?`} msg="Delete all signals permanently?" okLabel={`DELETE ALL`} onOk={doAll} onCancel={()=>setCAll(false)}/>}
    {cClearHist&&<Confirm T={T} title="Clear Scan History?" msg="Remove all 25 scan results from Firebase?" okLabel="CLEAR" okColor={T.warn} onOk={async()=>{setCClearHist(false);if(user){await clearScanHistory(user.uid);setHistory([])}}} onCancel={()=>setCClearHist(false)}/>}

    {/* Sub-tabs: Saved Signals vs Scan History */}
    <div style={{display:'flex',gap:0,borderRadius:10,overflow:'hidden',border:`1px solid ${T.brd}`,marginBottom:14}}>
      {[['saved','💾 Saved Signals'],['history','📋 Scan History']].map(([t,l])=><button key={t} onClick={()=>setHistTab(t)} style={{flex:1,padding:'11px 8px',border:'none',borderBottom:`2px solid ${histTab===t?T.acc:'transparent'}`,background:histTab===t?`${T.acc}12`:T.panel,color:histTab===t?T.acc:T.tm,fontFamily:'Rajdhani,sans-serif',fontSize:13,fontWeight:histTab===t?800:500,cursor:'pointer',transition:'all .2s'}}>{l}</button>)}
    </div>
    {histTab==='saved'&&<>
    <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:8,marginBottom:14}}>
      {[{v:all.length,l:'Total',c:T.acc},{v:all.filter(s=>s.dir==='bull').length,l:'Long',c:T.bull},{v:all.filter(s=>s.dir==='bear').length,l:'Short',c:T.bear},{v:wins,l:'Wins',c:T.bull},{v:losses,l:'Losses',c:T.bear}].map(({v,l,c})=><div key={l} style={{background:T.panel,border:`1px solid ${T.brd}`,padding:'10px 4px',textAlign:'center',borderRadius:8}}><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:26,fontWeight:800,color:c,lineHeight:1}}>{v}</div><div style={{fontSize:9,color:T.tm,marginTop:3,fontWeight:700,fontFamily:'JetBrains Mono,monospace'}}>{l}</div></div>)}
    </div>
    <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap',alignItems:'center'}}>
      <div style={{display:'flex',gap:0,borderRadius:8,overflow:'hidden',border:`1px solid ${T.brd}`}}>{[['all','ALL'],['bull','🟢'],['bear','🔴']].map(([f,l])=><button key={f} onClick={()=>setFilter(f)} style={{padding:'7px 12px',border:'none',background:filter===f?`${T.acc}18`:T.panel,color:filter===f?T.acc:T.tm,fontFamily:'JetBrains Mono,monospace',fontWeight:700,fontSize:11,cursor:'pointer'}}>{l}</button>)}</div>
      <div style={{display:'flex',gap:0,borderRadius:8,overflow:'hidden',border:`1px solid ${T.brd}`}}>{[['date','Date'],['score','Score']].map(([s,l])=><button key={s} onClick={()=>setSort(s)} style={{padding:'7px 12px',border:'none',background:sort===s?`${T.pink}18`:T.panel,color:sort===s?T.pink:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:11,cursor:'pointer'}}>{l}</button>)}</div>
      <button onClick={exportCSV} style={{padding:'7px 12px',border:`1px solid ${T.brd}`,background:T.panel,color:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',borderRadius:8}}>📥 CSV</button>
      {user&&<button onClick={load} style={{padding:'7px 12px',border:`1px solid ${T.brd}`,background:T.panel,color:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:11,cursor:'pointer',borderRadius:8}}>↻</button>}
      {all.length>0&&<button onClick={()=>setCAll(true)} style={{padding:'7px 12px',border:`1px solid ${T.bear}44`,background:`${T.bear}08`,color:T.bear,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',marginLeft:'auto',borderRadius:8}}>🗑 All</button>}
    </div>
    {!user&&local.length===0&&<div style={{textAlign:'center',padding:48,fontFamily:'JetBrains Mono,monospace',color:T.tm,border:`2px dashed ${T.brd}`,background:T.panel,borderRadius:12}}><div style={{fontSize:36,opacity:.2,marginBottom:12}}>💾</div><div style={{fontSize:13,color:T.ts,letterSpacing:2,marginBottom:8}}>NO SAVED SIGNALS</div><div style={{fontSize:11,color:T.tm}}>Tap "+ save" on any signal in the Scanner tab</div></div>}
    {loading?<div style={{textAlign:'center',padding:36,fontFamily:'JetBrains Mono,monospace',color:T.tm,fontSize:13}}>Loading...</div>
    :<div style={{display:'flex',flexDirection:'column',gap:6}}>{filtered.map(sig=>{
      const bull=sig.dir==='bull',ac=bull?T.bull:T.bear,isExp=exp===sig.id,ts=sig.savedAt?.seconds?sig.savedAt.seconds*1000:(sig.signalTs||sig.ts||0)
      return <div key={sig.id} style={{background:bull?T.hb:T.hr,border:`1px solid ${bull?T.bull+'22':T.bear+'22'}`,borderLeft:`3px solid ${ac}`,overflow:'hidden',borderRadius:8}}>
        <div onClick={()=>setExp(isExp?null:sig.id)} style={{display:'flex',alignItems:'center',gap:8,padding:'11px 14px',cursor:'pointer',flexWrap:'wrap'}}>
          <Score s={sig.strength||1} T={T} sm/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
              <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:16,fontWeight:800,color:T.txt}}>{sig.pair.replace('USDT','')}<span style={{fontSize:10,color:T.tm}}>/USDT</span></span>
              <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:14,fontWeight:700,color:ac}}>{bull?' LONG':' SHORT'}</span>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:13,color:T.acc,fontWeight:700}}>${fp(sig.price)}</span>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,padding:'2px 6px',border:`1px solid ${ac}33`,color:ac,borderRadius:4}}>RSI {sig.rsi?.toFixed(0)}</span>
            </div>
            <div style={{display:'flex',gap:6,alignItems:'center',marginTop:4}}>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.td}}>{fdtDate(ts)}</span>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.ts,fontWeight:700}}>{fdtTime(ts)}</span>
            </div>
          </div>
          <div style={{display:'flex',gap:4}}>{[['win','WIN',T.bull],['loss','LOSS',T.bear],['open','-',T.tm]].map(([o,l,c])=><button key={o} onClick={e=>{e.stopPropagation();doOut(sig.id,o)}} style={{padding:'3px 7px',border:`1px solid ${sig.outcome===o?c:T.brd}`,background:sig.outcome===o?`${c}18`:'transparent',color:sig.outcome===o?c:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:8,cursor:'pointer',fontWeight:sig.outcome===o?'bold':'normal',borderRadius:4}}>{l}</button>)}</div>
          <a href={tvL(sig.pair,sig.tf||'15m')} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{padding:'3px 8px',border:`1px solid ${T.acc}33`,color:T.acc,fontFamily:'JetBrains Mono,monospace',fontSize:9,textDecoration:'none',fontWeight:700,borderRadius:4}}>📈</a>
          <button onClick={e=>{e.stopPropagation();setCDel(sig.id)}} style={{padding:'3px 8px',border:`1px solid ${T.bear}44`,background:`${T.bear}08`,color:T.bear,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',borderRadius:4}}>🗑</button>
        </div>
        {isExp&&<div style={{padding:'12px 14px 16px',borderTop:`1px dashed ${T.brd}`,animation:'fadeIn .2s'}}>
          <div style={{paddingTop:6}}><div style={{fontSize:9,color:T.tm,letterSpacing:2,marginBottom:6,fontWeight:700,fontFamily:'JetBrains Mono,monospace'}}>NOTES</div>
          {editId===sig.id?<div style={{display:'flex',gap:8}}><input value={noteText} onChange={e=>setNoteText(e.target.value)} placeholder="Add notes..." style={{flex:1,padding:'8px 10px',background:`${T.acc}06`,border:`1px solid ${T.brd}`,color:T.txt,fontFamily:'JetBrains Mono,monospace',fontSize:12,outline:'none',borderRadius:6}}/><button onClick={()=>doNote(sig.id)} style={{padding:'8px 12px',border:`1px solid ${T.bull}`,background:`${T.bull}15`,color:T.bull,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',fontWeight:700,borderRadius:6}}>Save</button><button onClick={()=>setEditId(null)} style={{padding:'8px 10px',border:`1px solid ${T.brd}`,background:'transparent',color:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',borderRadius:6}}>✕</button></div>
          :<div style={{display:'flex',gap:8,alignItems:'center'}}><span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:sig.notes?T.ts:T.td,flex:1,fontStyle:sig.notes?'normal':'italic'}}>{sig.notes||'No notes yet'}</span><button onClick={()=>{setEditId(sig.id);setNoteText(sig.notes||'')}} style={{padding:'5px 10px',border:`1px solid ${T.brd}`,background:'transparent',color:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',borderRadius:5}}>✎ Edit</button></div>}
          </div>
        </div>}
      </div>
    })}</div>}
    </>}

    {histTab==='history'&&<>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
        <div>
          <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:15,fontWeight:800,color:T.txt}}>Recent Scan Results</div>
          <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,marginTop:2}}>Last 25 signals auto-saved from scanner · Firebase only</div>
        </div>
        <div style={{display:'flex',gap:6}}>
          {user&&<button onClick={loadHistory} style={{padding:'6px 10px',border:`1px solid ${T.brd}`,background:T.panel,color:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',borderRadius:6}}>↻</button>}
          {history.length>0&&<button onClick={()=>setCClearHist(true)} style={{padding:'6px 10px',border:`1px solid ${T.warn}44`,background:`${T.warn}08`,color:T.warn,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',borderRadius:6}}>🗑 Clear</button>}
        </div>
      </div>
      {!user&&<div style={{textAlign:'center',padding:48,border:`2px dashed ${T.brd}`,background:T.panel,borderRadius:12}}><div style={{fontSize:32,opacity:.2,marginBottom:12}}>🔒</div><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:14,color:T.ts,letterSpacing:2,marginBottom:8}}>LOGIN REQUIRED</div><div style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,color:T.tm}}>Sign in to view scan history saved to Firebase</div></div>}
      {user&&histLoading&&<div style={{textAlign:'center',padding:36,fontFamily:'JetBrains Mono,monospace',color:T.tm,fontSize:12}}>Loading history...</div>}
      {user&&!histLoading&&history.length===0&&<div style={{textAlign:'center',padding:48,border:`2px dashed ${T.brd}`,background:T.panel,borderRadius:12}}><div style={{fontSize:32,opacity:.2,marginBottom:12}}>📡</div><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:14,color:T.ts,letterSpacing:2,marginBottom:8}}>NO HISTORY YET</div><div style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,color:T.tm}}>Run a scan — signals auto-save here (max 25)</div></div>}
      {user&&!histLoading&&<div style={{display:'flex',flexDirection:'column',gap:6}}>
        {history.map((sig,idx)=>{
          const bull=sig.dir==='bull',ac=bull?T.bull:T.bear,ts=sig.savedAt?.seconds?sig.savedAt.seconds*1000:(sig.signalTs||sig.ts||0)
          return <div key={sig.id} style={{background:bull?T.cb:T.cr,border:`1px solid ${bull?T.bull+'30':T.bear+'30'}`,borderLeft:`3px solid ${ac}`,padding:'11px 14px',borderRadius:8,position:'relative'}}>
            <div style={{position:'absolute',top:8,right:10,fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.td}}>#{history.length-idx}</div>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <Score s={sig.strength||1} T={T}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:3}}>
                  <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:16,fontWeight:800,color:T.txt}}>{sig.pair?.replace('USDT','')}<span style={{fontSize:10,color:T.tm}}>/USDT</span></span>
                  {sig.market==='futures'&&<span style={{fontSize:9,padding:'2px 5px',background:`${T.warn}20`,border:`1px solid ${T.warn}44`,color:T.warn,fontFamily:'JetBrains Mono,monospace',borderRadius:4}}>PERP</span>}
                  <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:14,fontWeight:700,color:ac}}>{bull?' LONG':' SHORT'}</span>
                  <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:13,color:T.acc,fontWeight:700}}>${fp(sig.price)}</span>
                  {sig.change24h!=null&&<span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:sig.change24h>=0?T.bull:T.bear,fontWeight:700}}>{sig.change24h>=0?'+':''}{sig.change24h?.toFixed(2)}%</span>}
                </div>
                <div style={{display:'flex',gap:5,flexWrap:'wrap',alignItems:'center',marginBottom:4}}>
                  {[['RSI '+(sig.rsi?.toFixed(0)||'?'),T.ts],sig.vol24h?[fv(sig.vol24h)+' vol',T.tm]:null].filter(Boolean).map(([l,c],i)=><span key={i} style={{fontSize:10,padding:'2px 6px',border:`1px solid ${c}33`,color:c,fontFamily:'JetBrains Mono,monospace',background:`${c}08`,borderRadius:4}}>{l}</span>)}
                </div>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.td}}>{fdtDate(ts)}</span>
                  <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.ts,fontWeight:700}}>{fdtTime(ts)}</span>
                </div>
              </div>
              <RSIA rv={sig.rsi||50} T={T} sm/>
              <MC cds={sig.cds} dir={sig.dir} T={T}/>
              <a href={tvL(sig.pair,sig.tf||'15m')} target="_blank" rel="noreferrer" style={{padding:'5px 9px',border:`1px solid ${T.acc}44`,background:`${T.acc}0c`,color:T.acc,fontFamily:'JetBrains Mono,monospace',fontSize:9,textDecoration:'none',fontWeight:700,borderRadius:5,flexShrink:0}}>📈 TV</a>
            </div>
          </div>
        })}
      </div>}
    </>}
  </div>
}

function SettingsTab({T,dark,setDark,cfg,onSave,user,onLogout,onLogin,saving,saved,pushOn,setPushOn}){
  const[loc,setLoc]=useState(()=>JSON.parse(JSON.stringify(cfg)))
  const[customPair,setCustomPair]=useState(''),[customPairs,setCustomPairs]=useState(()=>{try{return JSON.parse(localStorage.getItem('custom_pairs')||'[]')}catch{return[]}})
  useEffect(()=>setLoc(JSON.parse(JSON.stringify(cfg))),[cfg])
  const set=(k,v)=>setLoc(p=>({...p,[k]:v}))
  const setSl=(ema,k,v)=>setLoc(p=>({...p,slope:{...p.slope,[ema]:{...(p.slope?.[ema]||{}), [k]:v}}}))
  const addCustomPair=()=>{const p=customPair.toUpperCase().trim();if(!p)return;const arr=[...customPairs,p.includes('USDT')?p:p+'USDT'].filter((v,i,a)=>a.indexOf(v)===i);setCustomPairs(arr);try{localStorage.setItem('custom_pairs',JSON.stringify(arr))}catch{};setCustomPair('')}
  const removeCustomPair=p=>{const arr=customPairs.filter(x=>x!==p);setCustomPairs(arr);try{localStorage.setItem('custom_pairs',JSON.stringify(arr))}catch{}}

  const Sec=({title,col,children})=><div style={{background:T.panel,border:`1px solid ${col||T.brd}`,padding:16,marginBottom:10,borderRadius:10}}><div style={{fontSize:10,letterSpacing:2.5,color:col||T.tm,textTransform:'uppercase',marginBottom:12,fontWeight:800,fontFamily:'JetBrains Mono,monospace',borderBottom:`1px solid ${T.brd}`,paddingBottom:8}}>{title}</div>{children}</div>
  const Row=({label,sub,children})=><div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 0',borderBottom:`1px solid ${T.brd}18`}}><div style={{flex:1,marginRight:14}}><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:15,color:T.txt,fontWeight:600,textAlign:'left'}}>{label}</div>{sub&&<div style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.tm,marginTop:3,textAlign:'left'}}>{sub}</div>}</div><div style={{flexShrink:0,textAlign:'right'}}>{children}</div></div>
  const Pills=({opts,val,pick,c})=><div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:8}}>{opts.map(([v,l])=>{const a=val===v||Math.abs((val||0)-(v||0))<0.001;return <button key={v} onClick={()=>pick(v)} style={{padding:'4px 10px',border:`1px solid ${a?(c||T.acc):T.brd}`,background:a?`${c||T.acc}18`:'transparent',color:a?(c||T.acc):T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',fontWeight:a?'bold':'normal',transition:'all .15s',borderRadius:5}}>{l}</button>})}</div>
  const EMARow=({ema,col,label})=>{const s=loc.slope?.[ema]||{on:false,bars:3,minPct:0};return <div style={{padding:'10px 12px',border:`1px solid ${s.on?col:T.brd}`,background:s.on?`${col}08`:'transparent',marginBottom:6,transition:'all .2s',borderRadius:8}}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:s.on?10:0}}>
      <div style={{display:'flex',alignItems:'center',gap:10}}><div style={{width:20,height:3,background:col,borderRadius:2,opacity:s.on?1:.4}}/><span style={{fontFamily:'Rajdhani,sans-serif',fontSize:14,fontWeight:700,color:s.on?col:T.tm}}>{label}</span></div>
      <Tog on={s.on} onChange={v=>setSl(ema,'on',v)} T={T} color={col}/>
    </div>
    {s.on&&<><div style={{fontSize:9,color:T.tm,fontFamily:'JetBrains Mono,monospace',marginBottom:4}}>Bars:</div>
    <div style={{display:'flex',gap:4,marginBottom:10}}>{[1,2,3,4,5].map(v=><button key={v} onClick={()=>setSl(ema,'bars',v)} style={{flex:1,padding:'5px 2px',border:`1px solid ${s.bars===v?col:T.brd}`,background:s.bars===v?`${col}18`:'transparent',color:s.bars===v?col:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:11,cursor:'pointer',fontWeight:s.bars===v?'bold':'normal',borderRadius:5}}>{v}</button>)}</div>
    <div style={{fontSize:9,color:T.tm,fontFamily:'JetBrains Mono,monospace',marginBottom:4}}>Min % per bar:</div>
    <div style={{display:'flex',gap:3,flexWrap:'wrap'}}>{[[-0.025,'-0.025%'],[-0.015,'-0.015%'],[0,'0%'],[0.015,'0.015%'],[0.025,'0.025%'],[0.05,'0.05%'],[0.1,'0.1%'],[0.15,'0.15%'],[0.2,'0.2%']].map(([v,l])=><button key={v} onClick={()=>setSl(ema,'minPct',v)} style={{padding:'4px 8px',border:`1px solid ${Math.abs((s.minPct||0)-v)<0.0001?col:T.brd}`,background:Math.abs((s.minPct||0)-v)<0.0001?`${col}18`:'transparent',color:Math.abs((s.minPct||0)-v)<0.0001?col:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',fontWeight:Math.abs((s.minPct||0)-v)<0.0001?'bold':'normal',borderRadius:5}}>{l}</button>)}</div></>}
  </div>}

  return <div>
    <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16,padding:'14px 16px',background:T.panel,border:`1px solid ${T.acc}44`,borderRadius:10}}>
      <div style={{flex:1}}><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:16,fontWeight:800,color:T.txt}}>Settings</div><div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,marginTop:2}}>{user?'Auto-sync to Firebase on Save':'Local only - login to sync'}</div></div>
      {saved&&<span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.bull}}>✓ Saved</span>}
      <button onClick={()=>{
        // Merge: if fields blank, keep existing saved token/chatId from cfg
        const toSave={...loc}
        onSave(toSave)
      }} disabled={saving} style={{padding:'10px 22px',border:`2px solid ${T.acc}`,background:`${T.acc}18`,color:T.acc,fontFamily:'Rajdhani,sans-serif',fontSize:14,fontWeight:800,cursor:saving?'not-allowed':'pointer',letterSpacing:1,borderRadius:8,opacity:saving?.7:1}}>{saving?'SAVING...':'SAVE'}</button>
    </div>

    <Sec title="Account">{user?<div><div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14,padding:'12px 14px',background:`${T.bull}08`,border:`1px solid ${T.bull}22`,borderRadius:8}}>{user.photoURL&&<img src={user.photoURL} style={{width:40,height:40,borderRadius:'50%',border:`2px solid ${T.bull}44`}} alt=""/>}<div><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:15,fontWeight:700,color:T.txt}}>{user.displayName||'User'}</div><div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,marginTop:2}}>{user.email}</div><div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.bull,marginTop:2}}>✓ Cloud sync active</div></div></div><button onClick={onLogout} style={{width:'100%',padding:10,border:`1px solid ${T.bear}44`,background:`${T.bear}0c`,color:T.bear,fontFamily:'Rajdhani,sans-serif',fontSize:14,cursor:'pointer',fontWeight:700,letterSpacing:1,borderRadius:8}}>LOGOUT</button></div>:<div><div style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.tm,marginBottom:12,lineHeight:1.8}}>Not logged in. Login to sync signals and settings.</div><button onClick={onLogin} style={{width:'100%',padding:10,border:`1px solid ${T.acc}`,background:`${T.acc}10`,color:T.acc,fontFamily:'Rajdhani,sans-serif',fontSize:14,cursor:'pointer',fontWeight:700,letterSpacing:1,borderRadius:8}}>LOGIN / CREATE ACCOUNT</button></div>}</Sec>

    <Sec title="Appearance"><Row label="Dark Mode" sub={dark?'Dark theme active':'Light theme active'}><Tog on={dark} onChange={setDark} T={T} color={T.acc}/></Row></Sec>

    <Sec title="Timeframe" col={T.acc}>
      <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,marginBottom:8}}>Select candle timeframe for signal detection</div>
      <div style={{display:'flex',gap:6}}>
        {TF_OPTIONS.map(({v,l})=>{
          const active=loc.timeframe===v||(v==='15m'&&!loc.timeframe)
          return <button key={v} onClick={()=>set('timeframe',v)} style={{flex:1,padding:'10px 4px',border:`2px solid ${active?T.acc:T.brd}`,background:active?`${T.acc}18`:'transparent',color:active?T.acc:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:12,fontWeight:active?800:400,cursor:'pointer',borderRadius:7,transition:'all .2s',letterSpacing:.5}}>{l}</button>
        })}
      </div>
      <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:8,color:T.td,marginTop:6}}>Changing TF reconnects WebSocket · Save to persist</div>
    </Sec>
    <Sec title="Alerts & Notifications" col={T.warn}>
      <Row label="Sound Alert" sub={loc.soundOn?'Plays tone on signal':'Silent'}><Tog on={loc.soundOn} onChange={v=>set('soundOn',v)} T={T} color={T.warn}/></Row>
      <Row label="Telegram Alert" sub={loc.tgOn?'Sending to your bot':'Disabled'}><Tog on={loc.tgOn} onChange={v=>set('tgOn',v)} T={T} color={T.acc}/></Row>
      {loc.tgOn&&<div style={{marginTop:12}}>
        <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,marginBottom:5}}>Bot Token:</div>
        <input value={loc.tgToken||''} onChange={e=>set('tgToken',e.target.value)} placeholder="123456789:AAF..." style={{width:'100%',padding:'9px 12px',background:`${T.acc}06`,border:`1px solid ${T.brd}`,color:T.txt,fontFamily:'JetBrains Mono,monospace',fontSize:11,outline:'none',marginBottom:10,borderRadius:6,boxSizing:'border-box'}}/>
        <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,marginBottom:5}}>Chat ID:</div>
        <input value={loc.tgChatId||''} onChange={e=>set('tgChatId',e.target.value)} placeholder="Your chat ID" style={{width:'100%',padding:'9px 12px',background:`${T.acc}06`,border:`1px solid ${T.brd}`,color:T.txt,fontFamily:'JetBrains Mono,monospace',fontSize:11,outline:'none',marginBottom:6,borderRadius:6,boxSizing:'border-box'}}/>
        <TgTestBtn token={loc.tgToken} chatId={loc.tgChatId} T={T}/>
        <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:8,color:T.td}}>Get token from @BotFather - Get ID from @userinfobot</div>
      </div>}
      <div style={{padding:'12px 0',borderBottom:`1px solid ${T.brd}18`}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
          <div>
            <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:15,color:T.txt,fontWeight:600,textAlign:'left'}}>Push Notification</div>
            <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.tm,marginTop:3,textAlign:'left'}}>{pushOn?' Active - alerts when browser closed':' Disabled - tap Enable to activate'}</div>
          </div>
          <div style={{flexShrink:0}}>
            {pushOn
              ?<div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 16px',border:`2px solid ${T.bull}`,background:`${T.bull}15`,borderRadius:8}}>
                <div style={{width:8,height:8,borderRadius:'50%',background:T.bull,boxShadow:`0 0 8px ${T.bull}`}}/>
                <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,color:T.bull,fontWeight:700}}>ENABLED</span>
              </div>
              :<button onClick={async()=>{
                await enableOneSignalPush(setPushOn)
              }} style={{padding:'8px 16px',border:`2px solid ${T.brd}`,background:'transparent',color:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:11,cursor:'pointer',fontWeight:700,borderRadius:8,transition:'all .2s'}}>ENABLE</button>
            }
          </div>
        </div>
        {pushOn&&<button onClick={()=>{setPushOn(false);localStorage.setItem('pushOn','false');alert('Push notifications disabled.')}} style={{padding:'5px 12px',border:`1px solid ${T.bear}44`,background:`${T.bear}08`,color:T.bear,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',borderRadius:6}}>Disable</button>}
        <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.td,marginTop:6,lineHeight:1.6}}>Powered by OneSignal - Use Chrome - Allow notifications when asked</div>
      </div>
    </Sec>
    <Sec title="RSI Cap" col={T.acc}>
      <Row label="RSI Cap" sub={loc.rsiCapEnabled?`Bull >${50} cap ${loc.rsiBullCap??60} | Bear <50 floor ${loc.rsiBearCap??40}`:'Any RSI above/below 50'}><Tog on={loc.rsiCapEnabled} onChange={v=>set('rsiCapEnabled',v)} T={T} color={T.acc}/></Row>
      {loc.rsiCapEnabled&&<>
        <div style={{marginTop:10}}><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:12,color:T.bull,fontWeight:700,marginBottom:4}}>🟢 BULL CAP — RSI must be ≤ this</div><Pills opts={[[55,'55'],[60,'60'],[65,'65'],[70,'70'],[75,'75'],[100,'Any']]} val={loc.rsiBullCap??60} pick={v=>set('rsiBullCap',v)} c={T.bull}/></div>
        <div style={{marginTop:10}}><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:12,color:T.bear,fontWeight:700,marginBottom:4}}>🔴 BEAR FLOOR — RSI must be ≥ this</div><Pills opts={[[0,'Any'],[25,'25'],[30,'30'],[35,'35'],[40,'40'],[45,'45']]} val={loc.rsiBearCap??40} pick={v=>set('rsiBearCap',v)} c={T.bear}/></div>
      </>}
    </Sec>
    <Sec title="3-Candle Wick Touch" col={T.pink}>
      <Row label="Wick Touch" sub={loc.wickEnabled?`${loc.wickTouchPct}% from EMA40`:'Disabled'}><Tog on={loc.wickEnabled} onChange={v=>set('wickEnabled',v)} T={T} color={T.pink}/></Row>
      {loc.wickEnabled&&<Pills opts={[[0,'Off'],[0.5,'0.5%'],[1,'1%'],[1.5,'1.5%'],[2,'2%'],[3,'3%']]} val={loc.wickTouchPct} pick={v=>set('wickTouchPct',v)} c={T.pink}/>}
    </Sec>
    <Sec title="EMA Gap" col={T.warn}>
      <Row label="EMA Gap Filter" sub={loc.gapEnabled?`9->20:${loc.gap9_20}% - 20->40:${loc.gap20_40}%`:'Disabled'}><Tog on={loc.gapEnabled} onChange={v=>set('gapEnabled',v)} T={T} color={T.warn}/></Row>
      {loc.gapEnabled&&[['9->20','gap9_20'],['20->40','gap20_40'],['40->80','gap40_80']].map(([lbl,key])=><div key={key} style={{marginTop:10}}><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:12,color:T.ts,fontWeight:600,marginBottom:4}}>EMA {lbl}</div><Pills opts={[[0,'None'],[0.025,'0.025%'],[0.05,'0.05%'],[0.1,'0.1%'],[0.2,'0.2%'],[0.5,'0.5%'],[1,'1%']]} val={loc[key]} pick={v=>set(key,v)} c={T.warn}/></div>)}
    </Sec>
    <Sec title="EMA Slope" col={T.bull}>
      <EMARow ema="e9"  col={T.bull}  label="EMA 9  - Fast"/>
      <EMARow ema="e20" col={T.pink}  label="EMA 20 - Primary ★"/>
      <EMARow ema="e40" col={T.ts}    label="EMA 40 - Mid"/>
      <EMARow ema="e80" col={T.tm}    label="EMA 80 - Anchor"/>
    </Sec>
    <Sec title="Signal Strength Filter" col={T.gold}>
      <Row label="Min Score Filter" sub={loc.scoreFilterEnabled?`Only score ${loc.scoreMin||6}+`:'Showing all signals'}><Tog on={loc.scoreFilterEnabled} onChange={v=>set('scoreFilterEnabled',v)} T={T} color={T.gold}/></Row>
      {loc.scoreFilterEnabled&&<Pills opts={[[5,'5+'],[6,'6+'],[7,'7+'],[8,'8+'],[9,'9+'],[10,'10']]} val={loc.scoreMin||6} pick={v=>set('scoreMin',v)} c={T.gold}/>}
    </Sec>
  </div>
}

const TF_OPTIONS=[{v:'5m',l:'5m',ms:5*60*1000},{v:'15m',l:'15m',ms:15*60*1000},{v:'1h',l:'1h',ms:60*60*1000},{v:'4h',l:'4h',ms:4*60*60*1000}]
const INIT_CFG=()=>{try{const s=JSON.parse(localStorage.getItem('ema_v9_cfg')||'null');return s?{...DEFAULT_SETTINGS,...s,rsiBullCap:s.rsiBullCap??60,rsiBearCap:s.rsiBearCap??40,slope:{...DEFAULT_SETTINGS.slope,...(s.slope||{})},timeframe:s.timeframe||'15m'}:{...DEFAULT_SETTINGS,timeframe:'15m'}}catch{return{...DEFAULT_SETTINGS,timeframe:'15m'}}}

export default function App(){
  const[dark,setDark]=useState(()=>{try{const s=localStorage.getItem('ema_dark');return s===null?true:s==='true'}catch{return true}})
  const T=dark?D:L
  const[pushOn,setPushOn]=useState(false)
  const[page,setPage]=useState('scanner')
  const[user,setUser]=useState(null),[authReady,setAuthReady]=useState(false),[showLogin,setShowLogin]=useState(false)
  const[cfg,setCfgRaw]=useState(INIT_CFG),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false)
  const[sigs,setSigs]=useState([]),[newIds,setNewIds]=useState(new Set())
  const[scanMode,setScanMode]=useState('auto')
  const[scanning,setScanning]=useState(false),[autoLoop,setAutoLoop]=useState(0)
  const[curPair,setCurPair]=useState(null),[prog,setProg]=useState({done:0,total:0,found:0})
  const[stats,setStats]=useState({bull:0,bear:0,sc:0,fi:0,err:0}),[lastSc,setLastSc]=useState(null)
  const[toasts,setToasts]=useState([]),[savedIds,setSavedIds]=useState(new Set())
  const[local,setLocal]=useState(()=>{try{return JSON.parse(localStorage.getItem('ema_v9_sigs')||'[]')}catch{return[]}})
  const[tab,setTab]=useState('all'),[dir,setDir]=useState('both'),[mcap,setMcap]=useState('all'),[vol,setVol]=useState('any'),[market,setMarket]=useState('spot')
  const[filterOpen,setFilterOpen]=useState(false)
  const[repeatGap,setRepeatGap]=useState(()=>{try{return parseInt(localStorage.getItem('repeatGap')||'300000')}catch{return 300000}}) // default 5min
  const[scanInterval,setScanInterval]=useState(()=>{try{return parseInt(localStorage.getItem('scanInterval')||'300000')}catch{return 300000}}) // default 5min
  const[watchlist,setWatchlist]=useState(()=>{try{return JSON.parse(localStorage.getItem('watchlist_v9')||'[]')}catch{return[]}})
  const[wInput,setWInput]=useState('')
  const dedupRef=useRef({}),scanRef=useRef(false),autoRef=useRef(false),loopRef=useRef(0),userRef=useRef(null)
  // ── WebSocket refs (v9.15) ───────────────────────────────
  const wsRef=useRef([])           // active WebSocket instances
  const candleCacheRef=useRef({})  // {symbol: candles[]} for WS updates
  const tickerCacheRef=useRef({})  // {symbol: ticker} for WS vol filter
  const [wsStatus,setWsStatus]=useState('off') // 'off'|'connecting'|'live'|'error'

  useEffect(()=>{
    // Check push status from localStorage first (instant), then verify with OneSignal
    const cached = localStorage.getItem('pushOn') === 'true'
    if(cached) setPushOn(true)
    setTimeout(()=>isOneSignalSubscribed().then(v=>{setPushOn(v);localStorage.setItem('pushOn',v)}),2000)
    const unsub=onAuthChange(async u=>{
      setUser(u);userRef.current=u;setAuthReady(true)
      if(u){setShowLogin(false);const r=await fetchSettings(u.uid);if(r){const m={...DEFAULT_SETTINGS,...r,slope:{...DEFAULT_SETTINGS.slope,...(r.slope||{})}};setCfgRaw(m);try{localStorage.setItem('ema_v9_cfg',JSON.stringify(m))}catch{}}else{await saveSettings(u.uid,INIT_CFG())}}
    })
    const mq=window.matchMedia('(prefers-color-scheme:dark)'),tc=e=>{};mq.addEventListener('change',tc)
    return()=>{unsub();mq.removeEventListener('change',tc)}
  },[])

  const cfgRef=useRef(cfg)
  useEffect(()=>{cfgRef.current=cfg},[cfg])
  const saveCfg=useCallback(async nc=>{const m={...DEFAULT_SETTINGS,...nc,slope:{...DEFAULT_SETTINGS.slope,...(nc.slope||{})}};setCfgRaw(m);try{localStorage.setItem('ema_v9_cfg',JSON.stringify(m))}catch{};setSaving(true);if(userRef.current)await saveSettings(userRef.current.uid,m);setSaving(false);setSaved(true);setTimeout(()=>setSaved(false),2000)},[])

  const handleSave=useCallback(async sig=>{
    const s={...sig,settings:JSON.stringify(cfg)}
    if(userRef.current){await saveSignal(userRef.current.uid,s)}
    else{const u=[s,...local].slice(0,200);setLocal(u);try{localStorage.setItem('ema_v9_sigs',JSON.stringify(u))}catch{}}
    setSavedIds(p=>new Set([...p,sig.id]))
  },[cfg,local])

  const getCustomPairs=()=>{try{return JSON.parse(localStorage.getItem('custom_pairs')||'[]').map(s=>({s,mcap:999,type:'custom'}))}catch{return[]}}

  // ── WebSocket helpers (v9.15) ─────────────────────────────
  const closeAllWS=useCallback(()=>{
    wsRef.current.forEach(ws=>{try{ws.close()}catch{}})
    wsRef.current=[]
    setWsStatus('off')
  },[])

  // Connect WebSocket streams for real-time 15m kline monitoring (auto mode)
  const connectWebSocket=useCallback((pairs,mkt,cfgSnap,dirStr,volStr)=>{
    closeAllWS()
    if(!pairs.length)return
    setWsStatus('connecting')
    const vMin=VOL_MIN[volStr]
    const baseUrl=mkt==='futures'
      ?'wss://fstream.binance.com/stream?streams='
      :'wss://stream.binance.com:9443/stream?streams='
    // Binance allows up to 1024 streams; split into chunks of 200 to stay safe
    const CHUNK=200
    let connectedCount=0
    const totalChunks=Math.ceil(pairs.length/CHUNK)
    for(let gi=0;gi<pairs.length;gi+=CHUNK){
      const grp=pairs.slice(gi,gi+CHUNK)
      const tf=cfgRef.current?.timeframe||'15m'
      const streams=grp.map(p=>`${p.s.toLowerCase()}@kline_${tf}`).join('/')
      const ws=new WebSocket(baseUrl+streams)
      ws.onopen=()=>{connectedCount++;if(connectedCount>=totalChunks)setWsStatus('live')}
      ws.onerror=()=>setWsStatus('error')
      ws.onclose=()=>{}
      ws.onmessage=(ev)=>{
        try{
          const msg=JSON.parse(ev.data)
          const k=msg?.data?.k
          if(!k)return // process every kline tick (no candle-close wait)
          const sym=k.s
          const pair=grp.find(p=>p.s===sym)
          if(!pair)return
          // Update candle cache — upsert live candle (no candle-close wait)
          const newCd={o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+k.v,t:k.t}
          const cached=candleCacheRef.current[sym]||[]
          const last=cached[cached.length-1]
          const updated=last&&last.t===newCd.t?[...cached.slice(0,-1),newCd]:[...cached.slice(-99),newCd]
          candleCacheRef.current[sym]=updated
          if(updated.length<85)return // need enough candles for EMA80
          const ticker=tickerCacheRef.current[sym]
          if(ticker&&vMin>0&&ticker.vol24h<vMin)return
          const price=+k.c
          const sigNow=Date.now()
          // Same detection proc as runScan — zero logic changes
          const proc=(r,d)=>{
            if(!r.ok)return
            if(cfgSnap.scoreFilterEnabled&&r.strength<(cfgSnap.scoreMin||6))return
            const key=`${sym}_${d}_${pair.type}`
            if(dedupRef.current[key]&&sigNow-dedupRef.current[key]<cfgSnap._repeatGap)return
            dedupRef.current[key]=sigNow
            const s={id:Date.now()+Math.random(),dir:d,pair:sym,market:pair.type||'spot',price,vol24h:ticker?.vol24h??null,change24h:ticker?.change24h??null,mcap:pair.mcap,e9:r.e9,e20:r.e20,e40:r.e40,e80:r.e80,rsi:r.rsi,checks:r.checks,strength:r.strength,h9:r.h9,h20:r.h20,h40:r.h40,h80:r.h80,time:new Date().toLocaleTimeString(),ts:sigNow,cds:updated.slice(-22)}
            setSigs(prev=>[s,...prev].slice(0,200))
            setNewIds(p=>{const n=new Set(p);n.add(s.id);return n})
            setTimeout(()=>setNewIds(p=>{const n=new Set(p);n.delete(s.id);return n}),3000)
            setProg(p=>({...p,found:p.found+1}))
            setToasts([s])
            if(cfgSnap.soundEnabled)playAlert(d)
            if(cfgSnap.tgOn&&cfgSnap.tgToken&&cfgSnap.tgChatId)sendTelegram(cfgSnap.tgToken,cfgSnap.tgChatId,buildTgMessage(s))
            if(userRef.current){saveSignal(userRef.current.uid,{...s,settings:JSON.stringify(cfgSnap)});saveScanResult(userRef.current.uid,s)}
          }
          if(dirStr==='bull'||dirStr==='both')proc(detectBull(updated,cfgSnap),'bull')
          if(dirStr==='bear'||dirStr==='both')proc(detectBear(updated,cfgSnap),'bear')
        }catch{}
      }
      wsRef.current.push(ws)
    }
  },[closeAllWS])

  const runScan=useCallback(async(loopNum=1)=>{
    if(scanRef.current)return
    scanRef.current=true;setScanning(true);setAutoLoop(loopNum)
    closeAllWS() // always close any existing WS before re-scanning
    const[mMin,mMax]=MCAP_RANGES[mcap],vMin=VOL_MIN[vol]
    const allPairs=[...PAIRS,...getCustomPairs()]
    const eligible=market==='watchlist'
      ? watchlist.map(s=>({s,mcap:999,type:'spot'}))
      : allPairs.filter(p=>{
          if(market==='spot'&&p.type==='futures')return false
          if(market==='futures'&&p.type!=='futures')return false
          if(market==='custom'&&p.type!=='custom')return false
          return p.mcap>=mMin&&p.mcap<=mMax
        })
    // dedupe spot+futures same symbol
    const seen=new Set(),uniq=[]
    eligible.forEach(p=>{const k=`${p.s}_${p.type}`;if(!seen.has(k)){seen.add(k);uniq.push(p)}})
    
    setProg({done:0,total:uniq.length,found:0})
    let bull=0,bear=0,sc=0,fi=0,err=0,now=Date.now()
    const cfgSnap={...cfg,_repeatGap:repeatGap}
    let doneCount=0

    // ── Per-pair fetch+detect (runs concurrently) ──────────
    const processPair=async(pair)=>{
      if(!scanRef.current)return
      sc++;setCurPair(pair.label||pair.s)

      let candles=null
      try{
        const url=market==='futures'
          ?`https://fapi.binance.com/fapi/v1/klines?symbol=${pair.s}&interval=${cfgSnap.timeframe||'15m'}&limit=100`
          :`https://api.binance.com/api/v3/klines?symbol=${pair.s}&interval=${cfgSnap.timeframe||'15m'}&limit=100`
        const res=await fetch(url,{signal:AbortSignal.timeout(8000)})
        if(res.ok){const data=await res.json();candles=data.map(k=>({o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5],t:k[0]}))}
      }catch{}
      doneCount++;setProg(p=>({...p,done:doneCount}))
      if(!candles){err++;return}
      candleCacheRef.current[pair.s]=candles // cache for WebSocket live updates

      let ticker=null
      try{
        const tu=market==='futures'
          ?`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${pair.s}`
          :`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair.s}`
        const tr=await fetch(tu,{signal:AbortSignal.timeout(5000)})
        if(tr.ok){const d=await tr.json();ticker={price:+d.lastPrice,vol24h:+(d.quoteVolume||d.volume)/1e6,change24h:+d.priceChangePercent}}
      }catch{}
      if(ticker)tickerCacheRef.current[pair.s]=ticker // cache for WS vol filter
      if(ticker&&vMin>0&&ticker.vol24h<vMin)return
      fi++
      const price=ticker?.price||candles[candles.length-1].c

      const proc=async(r,d)=>{
        if(!r.ok)return
        if(cfgSnap.scoreFilterEnabled&&r.strength<(cfgSnap.scoreMin||6))return
        const key=`${pair.s}_${d}_${pair.type}`;if(dedupRef.current[key]&&now-dedupRef.current[key]<cfgSnap._repeatGap)return
        dedupRef.current[key]=now
        d==='bull'?bull++:bear++
        const s={id:Date.now()+Math.random(),dir:d,pair:pair.s,tf:cfgSnap.timeframe||'15m',market:pair.type||'spot',price,vol24h:ticker?.vol24h??null,change24h:ticker?.change24h??null,mcap:pair.mcap,e9:r.e9,e20:r.e20,e40:r.e40,e80:r.e80,rsi:r.rsi,checks:r.checks,strength:r.strength,h9:r.h9,h20:r.h20,h40:r.h40,h80:r.h80,time:new Date().toLocaleTimeString(),ts:Date.now(),cds:candles.slice(-22)}
        setSigs(prev=>[s,...prev].slice(0,200))
        setNewIds(p=>{const n=new Set(p);n.add(s.id);return n})
        setTimeout(()=>setNewIds(p=>{const n=new Set(p);n.delete(s.id);return n}),3000)
        setProg(p=>({...p,found:p.found+1}))
        setToasts([s])
        if(cfgSnap.soundEnabled)playAlert(d)
        if(cfgSnap.tgOn&&cfgSnap.tgToken&&cfgSnap.tgChatId)sendTelegram(cfgSnap.tgToken,cfgSnap.tgChatId,buildTgMessage(s))
        if(userRef.current){
          saveSignal(userRef.current.uid,{...s,settings:JSON.stringify(cfgSnap)})
          saveScanResult(userRef.current.uid,s)
        }
      }
      if(dir==='bull'||dir==='both')await proc(detectBull(candles,cfgSnap),'bull')
      if(dir==='bear'||dir==='both')await proc(detectBear(candles,cfgSnap),'bear')
    }

    // ── Parallel fetch: 15 concurrent requests ──────────────
    // 15x faster than sequential — scans 150 pairs in ~10-15s
    const BATCH=15
    for(let i=0;i<uniq.length;i+=BATCH){
      if(!scanRef.current)break
      await Promise.all(uniq.slice(i,i+BATCH).map(p=>processPair(p)))
    }

    setStats(p=>({...p,bull,bear,sc,fi,err}))
    setLastSc(new Date().toLocaleTimeString());setCurPair(null)
    scanRef.current=false;setScanning(false)

    // ── Auto mode: WebSocket for live tick detection ──────────
    if(autoRef.current&&scanMode==='auto'){
      connectWebSocket(uniq,market,cfgSnap,dir,vol)
    }
    // ── Loop mode: restart immediately after scan ends ────────
    if(autoRef.current&&scanMode==='loop'){
      loopRef.current+=1
      setAutoLoop(loopRef.current)
      runScan(loopRef.current)
    }
  },[dir,mcap,vol,market,cfg,scanMode,watchlist,repeatGap,scanInterval,closeAllWS,connectWebSocket])

  const startAuto=()=>{
    if(scanMode==='loop'&&autoRef.current){autoRef.current=false;scanRef.current=false;setScanning(false);return}
    if(scanMode==='auto'){if(scanning){scanRef.current=false;setScanning(false);return}else{runScan(1);return}}
    autoRef.current=true;loopRef.current=1;runScan(1)
  }
  const stopScan=()=>{autoRef.current=false;scanRef.current=false;setScanning(false);closeAllWS()}

  const allPairs=[...PAIRS,...getCustomPairs()]
  const eligCount=market==='watchlist'?watchlist.length:allPairs.filter(p=>{
    const[mn,mx]=MCAP_RANGES[mcap]
    if(market==='spot'&&p.type==='futures')return false
    if(market==='futures'&&p.type!=='futures')return false
    if(market==='custom'&&p.type!=='custom')return false
    return p.mcap>=mn&&p.mcap<=mx
  }).length

  const disp=tab==='all'?sigs:sigs.filter(s=>s.dir===tab)

  if(!authReady)return <div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh',background:D.bg,color:D.acc,fontFamily:'JetBrains Mono,monospace',letterSpacing:3,fontSize:13}}>CONNECTING...</div>
  if(showLogin)return <LoginPage T={T} onSkip={()=>setShowLogin(false)}/>

  const CSS=`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Rajdhani:wght@500;600;700;800;900&display=swap');*{box-sizing:border-box;margin:0;padding:0}body{background:${T.bg};font-family:'JetBrains Mono',monospace}@keyframes slideIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:translateX(0)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes fadeOut{0%{opacity:1}70%{opacity:1}100%{opacity:0}}@keyframes dotBlink{0%,100%{opacity:1}50%{opacity:.2}}@keyframes sweep{0%{transform:translateX(-100%)}100%{transform:translateX(600%)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-thumb{background:${T.brd};border-radius:2px}input{color:${T.txt}!important}input::placeholder{color:${T.tm}!important}button:active{opacity:.75}a:hover{opacity:.8}@media(min-width:768px){.t-pair{font-size:20px!important}.t-dir{font-size:16px!important}.t-price{font-size:15px!important}.t-sub{font-size:13px!important}}`

  return <>
    <style>{CSS}</style>
    <div style={{position:'fixed',inset:0,zIndex:0,background:T.bg,backgroundImage:`linear-gradient(${T.gl} 1px,transparent 1px),linear-gradient(90deg,${T.gl} 1px,transparent 1px)`,backgroundSize:'48px 48px'}}/>
    {dark&&<div style={{position:'fixed',inset:0,zIndex:0,background:'radial-gradient(ellipse 70% 40% at 50% 0%,rgba(0,180,255,0.05),transparent)'}}/>}
    {toasts.slice(0,1).map(t=><Toast key={t.id} sig={t} T={T} onDone={()=>setToasts([])}/>)}
    <div style={{position:'relative',zIndex:1,color:T.txt,minHeight:'100vh',display:'flex',flexDirection:'column',maxWidth:1200,margin:'0 auto'}}>

      {/* HEADER */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 18px',background:T.panel,borderBottom:`1px solid ${T.brd}`,position:'relative',overflow:'hidden',flexShrink:0}}>
        {dark&&<div style={{position:'absolute',top:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${T.acc},transparent)`,animation:'sweep 6s linear infinite'}}/>}
        <div style={{fontFamily:'Rajdhani,sans-serif',lineHeight:1}}>
          <div style={{fontSize:20,fontWeight:900,letterSpacing:2}}>
            <span style={{color:T.acc}}>EMA-</span><span style={{color:T.bull}}>SIGNAL</span><span style={{color:T.txt}}>-HUNTER</span>
            <span style={{marginLeft:8,fontSize:10,color:T.bull,verticalAlign:'middle',border:`1px solid ${T.bull}44`,padding:'2px 7px',background:`${T.bull}0c`,fontFamily:'JetBrains Mono,monospace',borderRadius:4,letterSpacing:1}}>v9.17</span>
          </div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          {scanning&&<div style={{display:'flex',alignItems:'center',gap:5,padding:'4px 10px',border:`1px solid ${T.warn}44`,background:`${T.warn}0c`,borderRadius:6}}><div style={{width:6,height:6,borderRadius:'50%',background:T.warn,animation:'pulse 1s infinite'}}/><span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.warn,fontWeight:700}}>{autoLoop>1?`LOOP #${autoLoop}`:''} {prog.done}/{prog.total}</span></div>}
          {!scanning&&wsStatus!=='off'&&<div style={{display:'flex',alignItems:'center',gap:5,padding:'4px 10px',border:`1px solid ${wsStatus==='live'?T.bull:wsStatus==='error'?T.bear:T.warn}44`,background:`${wsStatus==='live'?T.bull:wsStatus==='error'?T.bear:T.warn}0c`,borderRadius:6}}><div style={{width:6,height:6,borderRadius:'50%',background:wsStatus==='live'?T.bull:wsStatus==='error'?T.bear:T.warn,animation:'pulse 1s infinite'}}/><span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:wsStatus==='live'?T.bull:wsStatus==='error'?T.bear:T.warn,fontWeight:700}}>{wsStatus==='live'?'WS LIVE':wsStatus==='error'?'WS ERR':'WS...'}</span></div>}
          {user?<div onClick={()=>setPage('settings')} style={{cursor:'pointer'}}>{user.photoURL?<img src={user.photoURL} style={{width:30,height:30,borderRadius:'50%',border:`2px solid ${T.bull}44`}} alt=""/>:<div style={{width:30,height:30,borderRadius:'50%',background:`${T.bull}18`,border:`2px solid ${T.bull}44`,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'JetBrains Mono,monospace',fontSize:11,color:T.bull,fontWeight:900}}>{(user.email||'U')[0].toUpperCase()}</div>}</div>:<button onClick={()=>setShowLogin(true)} style={{padding:'5px 12px',border:`1px solid ${T.acc}44`,background:`${T.acc}0c`,color:T.acc,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',fontWeight:700,borderRadius:6}}>LOGIN</button>}
          <button onClick={()=>setDark(d=>{const n=!d;try{localStorage.setItem('ema_dark',n)}catch{};return n})} style={{background:'transparent',border:`1px solid ${T.brd}`,color:T.ts,fontSize:13,padding:'4px 8px',cursor:'pointer',borderRadius:6}}>{dark?'☀':'🌙'}</button>
        </div>
      </div>

      {/* TABS */}
      <div style={{display:'flex',background:T.panel,borderBottom:`1px solid ${T.brd}`,flexShrink:0}}>
        {[{id:'scanner',icon:'',label:'Scanner'},{id:'watchlist',icon:'',label:'Watchlist'},{id:'saved',icon:'',label:'Saved'},{id:'settings',icon:'',label:'Settings'}].map(({id,icon,label})=><button key={id} onClick={()=>setPage(id)} style={{flex:1,padding:'13px 2px',border:'none',borderBottom:`2px solid ${page===id?T.acc:'transparent'}`,background:'transparent',color:page===id?T.acc:T.tm,fontFamily:'Rajdhani,sans-serif',fontSize:12,fontWeight:page===id?800:500,cursor:'pointer',transition:'all .2s',display:'flex',alignItems:'center',justifyContent:'center',gap:4}}>
          <span style={{fontSize:13}}>{icon}</span><span>{label}</span>
          {id==='saved'&&(local.length>0||user)&&<span style={{background:T.acc,color:'#000',borderRadius:'50%',width:16,height:16,display:'flex',alignItems:'center',justifyContent:'center',fontSize:8,fontWeight:900,fontFamily:'JetBrains Mono,monospace'}}>{user?'':local.length}</span>}
          {id==='watchlist'&&watchlist.length>0&&<span style={{background:T.warn,color:'#000',borderRadius:'50%',width:16,height:16,display:'flex',alignItems:'center',justifyContent:'center',fontSize:8,fontWeight:900,fontFamily:'JetBrains Mono,monospace'}}>{watchlist.length}</span>}
        </button>)}
      </div>

      {/* CONTENT */}
      <div style={{flex:1,padding:'12px 16px',overflowY:'auto'}}>
        {page==='scanner'&&<>
          {/* Filter Accordion */}
          <div style={{marginBottom:10,border:`1px solid ${filterOpen?T.acc:T.brd}`,borderRadius:10,overflow:'hidden',transition:'all .2s'}}>
            {/* Accordion Header */}
            <div onClick={()=>setFilterOpen(o=>!o)} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 14px',background:T.panel,cursor:'pointer',userSelect:'none'}}>
              <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',flex:1}}>
                <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,letterSpacing:1}}>FILTERS</span>
                <span style={{fontSize:9,padding:'2px 8px',background:`${T.acc}18`,border:`1px solid ${T.acc}33`,color:T.acc,borderRadius:4,fontFamily:'JetBrains Mono,monospace',fontWeight:700}}>{market.toUpperCase()}</span>
                <span style={{fontSize:9,padding:'2px 8px',background:dir==='bull'?`${T.bull}18`:dir==='bear'?`${T.bear}18`:`${T.acc}18`,border:`1px solid ${dir==='bull'?T.bull:dir==='bear'?T.bear:T.acc}33`,color:dir==='bull'?T.bull:dir==='bear'?T.bear:T.acc,borderRadius:4,fontFamily:'JetBrains Mono,monospace',fontWeight:700}}>{dir==='bull'?'LONG':dir==='bear'?'SHORT':'BOTH'}</span>
                {mcap!=='all'&&<span style={{fontSize:9,padding:'2px 8px',background:`${T.warn}18`,border:`1px solid ${T.warn}33`,color:T.warn,borderRadius:4,fontFamily:'JetBrains Mono,monospace'}}>{mcap.toUpperCase()}</span>}
                {vol!=='any'&&<span style={{fontSize:9,padding:'2px 8px',background:`${T.warn}18`,border:`1px solid ${T.warn}33`,color:T.warn,borderRadius:4,fontFamily:'JetBrains Mono,monospace'}}>VOL {vol}</span>}
              </div>
              <span style={{color:T.tm,fontSize:12,transition:'transform .2s',transform:filterOpen?'rotate(180deg)':'rotate(0deg)',flexShrink:0}}>▼</span>
            </div>
            {/* Accordion Body */}
            {filterOpen&&<div style={{padding:'12px 14px',background:T.p2,borderTop:`1px solid ${T.brd}`,display:'flex',flexDirection:'column',gap:10}}>
              <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,minWidth:50}}>MARKET</span>
                <div style={{display:'flex',gap:0,borderRadius:7,overflow:'hidden',border:`1px solid ${T.brd}`}}>
                  {[['spot','Spot'],['futures','Futures'],['watchlist','Watchlist']].map(([m,l])=><button key={m} onClick={()=>setMarket(m)} style={{padding:'6px 12px',border:'none',background:market===m?`${T.acc}18`:T.panel,color:market===m?T.acc:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',fontWeight:market===m?700:400}}>{l}</button>)}
                </div>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,minWidth:50}}>DIR</span>
                <div style={{display:'flex',gap:0,borderRadius:7,overflow:'hidden',border:`1px solid ${T.brd}`}}>{[['bull','Long',T.bull],['both','Both',T.acc],['bear','Short',T.bear]].map(([d,l,c])=><button key={d} onClick={()=>setDir(d)} style={{padding:'6px 12px',border:'none',background:dir===d?`${c}18`:T.panel,color:dir===d?c:T.tm,fontFamily:'Rajdhani,sans-serif',fontWeight:700,fontSize:12,cursor:'pointer'}}>{l}</button>)}</div>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,minWidth:50}}>CAP</span>
                <div style={{display:'flex',gap:0,borderRadius:7,overflow:'hidden',border:`1px solid ${T.brd}`}}>{[['all','All'],['large','Large'],['mid','Mid'],['small','Small'],['micro','Micro']].map(([p,l])=><button key={p} onClick={()=>setMcap(p)} style={{padding:'6px 10px',border:'none',background:mcap===p?`${T.acc}18`:T.panel,color:mcap===p?T.acc:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',fontWeight:mcap===p?700:400}}>{l}</button>)}</div>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,minWidth:50}}>VOL</span>
                <div style={{display:'flex',gap:0,borderRadius:7,overflow:'hidden',border:`1px solid ${T.brd}`}}>{[['any','Any'],['10m','>10M'],['25m','>25M'],['50m','>50M'],['100m','>100M']].map(([k,l])=><button key={k} onClick={()=>setVol(k)} style={{padding:'6px 10px',border:'none',background:vol===k?`${T.warn}18`:T.panel,color:vol===k?T.warn:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:10,cursor:'pointer',fontWeight:vol===k?700:400}}>{l}</button>)}</div>
              </div>
            </div>}
          </div>

          {/* Quick toggles bar */}
          <div style={{display:'flex',gap:8,marginBottom:10,alignItems:'center',padding:'10px 14px',background:T.panel,border:`1px solid ${T.brd}`,borderRadius:10,flexWrap:'wrap'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer'}} onClick={()=>saveCfg({...cfg,soundEnabled:!cfg.soundEnabled})}>
              <Tog on={cfg.soundEnabled} onChange={v=>saveCfg({...cfg,soundEnabled:v})} T={T} color={T.warn}/>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:cfg.soundEnabled?T.warn:T.tm}}>🔊 Sound</span>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer'}} onClick={()=>saveCfg({...cfg,tgOn:!cfg.tgOn})}>
              <Tog on={cfg.tgOn} onChange={v=>saveCfg({...cfg,tgOn:v})} T={T} color={T.acc}/>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:cfg.tgOn?T.acc:T.tm}}>📱 Telegram</span>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer'}} onClick={async()=>{
              if(pushOn){setPushOn(false);localStorage.setItem('pushOn','false');alert('Push notifications disabled.');return}
              await enableOneSignalPush(setPushOn)
            }}>
              <div style={{width:10,height:10,borderRadius:'50%',background:pushOn?T.bull:T.brd,boxShadow:pushOn?`0 0 8px ${T.bull}`:'none',flexShrink:0,transition:'all .3s'}}/>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:pushOn?T.bull:T.tm,fontWeight:pushOn?700:400}}>🔔 {pushOn?'Push ON':'Push OFF'}</span>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer'}} onClick={()=>saveCfg({...cfg,scoreFilterEnabled:!cfg.scoreFilterEnabled})}>
              <Tog on={cfg.scoreFilterEnabled} onChange={v=>saveCfg({...cfg,scoreFilterEnabled:v})} T={T} color={T.gold}/>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:cfg.scoreFilterEnabled?T.gold:T.tm}}>⭐ Score {cfg.scoreMin||6}+</span>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:6,marginLeft:'auto'}}>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,minWidth:70}}>Scan Freq:</span>
                <div style={{display:'flex',gap:0,borderRadius:6,overflow:'hidden',border:`1px solid ${T.brd}`}}>
                  {[[0,'Instant'],[60000,'1m'],[300000,'5m'],[900000,'15m'],[3600000,'1h']].map(([ms,l])=><button key={ms} onClick={()=>{setScanInterval(ms);setRepeatGap(ms||60000);try{localStorage.setItem('scanInterval',ms);localStorage.setItem('repeatGap',ms||60000)}catch{}}} style={{padding:'4px 8px',border:'none',background:scanInterval===ms?`${T.bull}18`:T.panel,color:scanInterval===ms?T.bull:T.tm,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',fontWeight:scanInterval===ms?700:400}}>{l}</button>)}
                </div>
              </div>
            </div>
          </div>

          {/* Scan mode + controls */}
          <div style={{marginBottom:10}}>
            <div style={{display:'flex',gap:6,marginBottom:8,alignItems:'center'}}>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,flexShrink:0}}>MODE:</span>
              <div style={{display:'flex',gap:0,borderRadius:8,overflow:'hidden',border:`1px solid ${T.brd}`,flex:1}}>
                {[['manual','Manual','Single scan'],['auto','Auto','Loop until stopped']].map(([m,l,sub])=><button key={m} onClick={()=>{setScanMode(m);if(autoRef.current){autoRef.current=false;scanRef.current=false;setScanning(false)}}} style={{flex:1,padding:'8px 4px',border:'none',background:scanMode===m?`${T.acc}18`:T.panel,color:scanMode===m?T.acc:T.tm,fontFamily:'Rajdhani,sans-serif',fontSize:13,cursor:'pointer',fontWeight:scanMode===m?800:500,transition:'all .2s'}}>
                  <div>{l}</div>
                  <div style={{fontSize:9,fontFamily:'JetBrains Mono,monospace',opacity:.7,marginTop:2}}>{sub}</div>
                </button>)}
              </div>
            </div>
            <div style={{display:'flex',gap:6}}>
              <button onClick={()=>{if(wsStatus==='live'){stopScan()}else if(scanning){stopScan()}else{if(scanMode==='auto'){autoRef.current=true;loopRef.current=1}runScan(1)}}} style={{flex:1,padding:13,background:T.panel,border:`2px solid ${wsStatus==='live'?T.bull:scanning?T.warn:T.acc}`,color:wsStatus==='live'?T.bull:scanning?T.warn:T.acc,fontFamily:'Rajdhani,sans-serif',fontSize:14,fontWeight:800,letterSpacing:1,cursor:'pointer',boxShadow:wsStatus==='live'?`0 0 16px ${T.bull}44`:scanning?`0 0 16px ${T.warn}44`:`0 0 8px ${T.acc}22`,transition:'all .2s',borderRadius:8}}>
                {wsStatus==='live'?` STOP WS - ${prog.found} FOUND LIVE`
                  :scanning?(scanMode==='auto'?` STOP AUTO - ${prog.done}/${prog.total} - ${prog.found} FOUND`:` STOP  ${prog.done}/${prog.total} - ${prog.found} FOUND`)
                  :(scanMode==='auto'?` START AUTO + WS - ${eligCount} PAIRS`:` SCAN ${eligCount} PAIRS`)}
              </button>

              <button onClick={()=>setSigs([])} style={{padding:'13px 12px',background:T.panel,border:`1px solid ${T.brd}`,color:T.tm,fontSize:14,cursor:'pointer',borderRadius:8}}>✕</button>
            </div>
          </div>

          {/* Stats */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:6,marginBottom:10}}>
            {[{v:stats.bull,l:'Long ',c:T.bull},{v:stats.bear,l:'Short ',c:T.bear},{v:stats.sc,l:'Scanned',c:T.acc},{v:stats.fi,l:'Passed',c:T.warn},{v:stats.err,l:'Errors',c:T.tm}].map(({v,l,c})=><div key={l} style={{background:T.panel,border:`1px solid ${T.brd}`,padding:'8px 4px',textAlign:'center',borderRadius:8}}><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:22,fontWeight:800,color:c,lineHeight:1}}>{v}</div><div style={{fontSize:8,color:T.tm,marginTop:3,fontWeight:700,fontFamily:'JetBrains Mono,monospace'}}>{l}</div></div>)}
          </div>

          {scanning&&<div style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.warn,fontWeight:700}}>{autoLoop>1?`LOOP #${autoLoop} - `:''}{curPair||'...'}</span>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm}}>{prog.done}/{prog.total} - {prog.found} found</span>
            </div>
            <div style={{height:3,background:T.brd,overflow:'hidden',borderRadius:2}}><div style={{height:'100%',width:`${prog.total?(prog.done/prog.total)*100:0}%`,background:`linear-gradient(90deg,${T.acc},${T.bull})`,transition:'width .2s',borderRadius:2}}/></div>
          </div>}
          {!scanning&&wsStatus!=='off'&&<div style={{marginBottom:10,padding:'8px 12px',border:`1px solid ${wsStatus==='live'?T.bull+'44':T.warn+'44'}`,background:wsStatus==='live'?`${T.bull}06`:`${T.warn}06`,borderRadius:8,display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:8,height:8,borderRadius:'50%',background:wsStatus==='live'?T.bull:T.warn,animation:'pulse 1s infinite',flexShrink:0}}/>
            <div style={{flex:1}}>
              <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:wsStatus==='live'?T.bull:T.warn,fontWeight:700}}>{wsStatus==='live'?`WS LIVE — monitoring ${eligCount} pairs on every ${cfg.timeframe||'15m'} close`:wsStatus==='error'?'WS ERROR — try again':'WS CONNECTING...'}</span>
              {wsStatus==='live'&&<div style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.tm,marginTop:2}}>Signals auto-fire when {cfg.timeframe||'15m'} candle closes · {prog.found} found so far</div>}
            </div>
            <button onClick={stopScan} style={{padding:'4px 10px',border:`1px solid ${T.bear}44`,background:`${T.bear}08`,color:T.bear,fontFamily:'JetBrains Mono,monospace',fontSize:9,cursor:'pointer',fontWeight:700,borderRadius:5,flexShrink:0}}>✕ STOP</button>
          </div>}

          {/* Feed header */}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
            <div style={{display:'flex',gap:0,borderRadius:8,overflow:'hidden',border:`1px solid ${T.brd}`}}>{[['all','All'],['bull',' Long'],['bear',' Short']].map(([f,l])=><button key={f} onClick={()=>setTab(f)} style={{padding:'6px 12px',border:'none',background:tab===f?`${T.acc}12`:T.panel,color:tab===f?T.acc:T.tm,fontFamily:'Rajdhani,sans-serif',fontWeight:tab===f?800:500,fontSize:12,cursor:'pointer'}}>{l}</button>)}</div>
            {lastSc&&<span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:T.ts}}>Last: {lastSc}</span>}
          </div>

          {/* Signals */}
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {disp.length===0&&<div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:200,border:`2px dashed ${T.brd}`,gap:12,color:T.tm,background:T.panel,borderRadius:12}}>
              <div style={{fontSize:36,opacity:.15}}>{wsStatus==='live'?'📡':'📡'}</div>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:14,letterSpacing:3,color:wsStatus==='live'?T.bull:T.ts,fontWeight:800}}>{wsStatus==='live'?'WS LIVE — WAITING FOR CANDLE CLOSE':scanning?'SCANNING...':'AWAITING SCAN'}</div>
              {scanning?<div style={{width:'80%',textAlign:'center'}}>
                <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,color:T.warn,marginBottom:8,fontWeight:700}}>{curPair||'...'}</div>
                <div style={{height:3,background:T.brd,borderRadius:2,overflow:'hidden',marginBottom:6}}><div style={{height:'100%',width:`${prog.total?(prog.done/prog.total)*100:0}%`,background:`linear-gradient(90deg,${T.acc},${T.bull})`,transition:'width .2s',borderRadius:2}}/></div>
                <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,color:T.tm}}>{prog.done}/{prog.total} checked - {prog.found} found</div>
              </div>
              :wsStatus==='live'?<div style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,color:T.tm,textAlign:'center',padding:'0 20px',lineHeight:1.7}}>WebSocket connected · Signals fire automatically when {cfg.timeframe||'15m'} kline closes<br/><span style={{color:T.bull,fontWeight:700}}>No polling needed — real-time detection</span></div>
              :<div style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,color:T.tm}}>Tap SCAN or select a mode to start</div>}
            </div>}
            {disp.map((sig,i)=><SigCard key={sig.id} sig={sig} T={T} onSave={handleSave} saved={savedIds.has(sig.id)} isNew={newIds.has(sig.id)}/>)}
          </div>
        </>}
        {page==='watchlist'&&<WatchlistTab T={T} watchlist={watchlist} setWatchlist={setWatchlist} wInput={wInput} setWInput={setWInput} setMarket={setMarket} setPage={setPage}/>}
        {page==='saved'&&<SavedTab T={T} user={user} local={local} onDelLocal={id=>{const u=local.filter(s=>s.id!==id);setLocal(u);try{localStorage.setItem('ema_v9_sigs',JSON.stringify(u))}catch{}}} onDelAllLocal={()=>{setLocal([]);try{localStorage.removeItem('ema_v9_sigs')}catch{}}}/>}
        {page==='settings'&&<SettingsTab T={T} dark={dark} setDark={setDark} cfg={cfg} onSave={saveCfg} saving={saving} saved={saved} user={user} pushOn={pushOn} setPushOn={setPushOn} onLogout={async()=>{await logout();setUser(null);userRef.current=null}} onLogin={()=>setShowLogin(true)}/>}
      </div>
    </div>
  </>
}
