import { initializeApp } from 'firebase/app'
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged,
} from 'firebase/auth'
import {
  getFirestore, collection, addDoc, getDocs, deleteDoc,
  doc, updateDoc, setDoc, getDoc, query, where,
  orderBy, serverTimestamp, writeBatch, limit,
} from 'firebase/firestore'

const firebaseConfig = {
  apiKey:            "AIzaSyBrC5nTCrKB3t5_LVQFl5jF6BqBYqA4ZcU",
  authDomain:        "ema-signal-hunter.firebaseapp.com",
  projectId:         "ema-signal-hunter",
  storageBucket:     "ema-signal-hunter.firebasestorage.app",
  messagingSenderId: "857155069057",
  appId:             "1:857155069057:web:6cfafbc238b09e09fe1980",
}

const app  = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db   = getFirestore(app)

// ── Auth ───────────────────────────────────────────────────
export const loginWithGoogle   = ()    => signInWithPopup(auth, new GoogleAuthProvider())
export const loginWithEmail    = (e,p) => signInWithEmailAndPassword(auth, e, p)
export const registerWithEmail = (e,p) => createUserWithEmailAndPassword(auth, e, p)
export const logout            = ()    => signOut(auth)
export const onAuthChange      = (cb)  => onAuthStateChanged(auth, cb)

// ── Signals ────────────────────────────────────────────────
export const saveSignal = async (userId, signal) => {
  try {
    const ref = await addDoc(collection(db,'signals'), {
      userId,
      pair:      signal.pair,        dir:       signal.dir,
      price:     signal.price,       rsi:       signal.rsi,
      strength:  signal.strength,    e9:        signal.e9,
      e20:       signal.e20,         e40:       signal.e40,
      e80:       signal.e80,         vol24h:    signal.vol24h    || null,
      change24h: signal.change24h   || null,    mcap:      signal.mcap,
      checks:    JSON.stringify(signal.checks   || {}),
      settings:  JSON.stringify(signal.settings || {}),
      cdsData:   JSON.stringify((signal.cds     || []).slice(-14)),
      notes:     '', outcome: 'open',
      savedAt:   serverTimestamp(), signalTs: signal.ts,
    })
    return ref.id
  } catch(e) { console.error(e); return null }
}

export const fetchSignals = async (userId) => {
  try {
    const q = query(collection(db,'signals'), where('userId','==',userId), orderBy('savedAt','desc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => {
      const data = d.data()
      return {
        id: d.id, ...data,
        cds:    tryParse(data.cdsData,  []),
        checks: tryParse(data.checks,   {}),
      }
    })
  } catch(e) { console.error(e); return [] }
}

export const deleteSignal    = async (id)         => { try{await deleteDoc(doc(db,'signals',id));return true}catch{return false} }
export const updateSignal    = async (id, updates) => { try{await updateDoc(doc(db,'signals',id),updates);return true}catch{return false} }
export const deleteAllSignals = async (userId) => {
  try {
    const q=query(collection(db,'signals'),where('userId','==',userId))
    const snap=await getDocs(q)
    const batch=writeBatch(db)
    snap.docs.forEach(d=>batch.delete(d.ref))
    await batch.commit(); return true
  } catch { return false }
}

// ── Settings ───────────────────────────────────────────────
export const saveSettings = async (userId, settings) => {
  try {
    // Deep-serialize slope object to avoid Firestore issues
    const toSave = { ...settings, slope: JSON.stringify(settings.slope||{}), updatedAt: serverTimestamp() }
    await setDoc(doc(db,'settings',userId), toSave)
    return true
  } catch(e) { console.error(e); return false }
}

export const fetchSettings = async (userId) => {
  try {
    const snap = await getDoc(doc(db,'settings',userId))
    if (!snap.exists()) return null
    const { updatedAt, ...rest } = snap.data()
    // Restore slope from JSON string
    if (typeof rest.slope === 'string') rest.slope = tryParse(rest.slope, null)
    return rest
  } catch(e) { console.error(e); return null }
}

// ── Telegram ───────────────────────────────────────────────
export const sendTelegram = async (token, chatId, message) => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML', disable_web_page_preview: false }),
    })
    const data = await res.json()
    return data.ok
  } catch(e) { console.error('TG:', e); return false }
}

export const buildTgMessage = (sig) => {
  const dir  = sig.dir === 'bull' ? '🟢 LONG ▲' : '🔴 SHORT ▼'
  const score = sig.strength||1
  const stars = '⭐'.repeat(Math.min(score,5))
  return `${dir} <b>${sig.pair}</b>
💰 Price: <b>${sig.price}</b>
📊 RSI: <b>${sig.rsi?.toFixed(1)}</b>  Score: <b>${score}/10</b> ${stars}
📈 EMA9: ${sig.e9?.toFixed(4)}  EMA20: ${sig.e20?.toFixed(4)}
📉 EMA40: ${sig.e40?.toFixed(4)}  EMA80: ${sig.e80?.toFixed(4)}
🕐 ${new Date().toLocaleTimeString()}
🔗 <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${sig.pair}&interval=15">Open on TradingView</a>`
}

function tryParse(str, fallback) {
  try { return JSON.parse(str) } catch { return fallback }
}

// ── Scan History (max 25 results per user) ─────────────────
export const saveScanResult = async (userId, signal) => {
  try {
    const col = collection(db, 'scanHistory')
    await addDoc(col, {
      userId,
      pair: signal.pair, dir: signal.dir,
      price: signal.price, rsi: signal.rsi,
      strength: signal.strength, e9: signal.e9,
      e20: signal.e20, e40: signal.e40, e80: signal.e80,
      vol24h: signal.vol24h || null, change24h: signal.change24h || null,
      mcap: signal.mcap, market: signal.market || 'spot',
      cdsData: JSON.stringify((signal.cds || []).slice(-22)),
      savedAt: serverTimestamp(), signalTs: signal.ts,
    })
    // Trim to 25 most recent
    const q = query(col, where('userId','==',userId), orderBy('savedAt','asc'))
    const snap = await getDocs(q)
    if (snap.size > 25) {
      const batch = writeBatch(db)
      snap.docs.slice(0, snap.size - 25).forEach(d => batch.delete(d.ref))
      await batch.commit()
    }
  } catch(e) { console.error('saveScanResult:', e) }
}

export const fetchScanHistory = async (userId) => {
  try {
    const q = query(
      collection(db, 'scanHistory'),
      where('userId','==',userId),
      orderBy('savedAt','desc'),
      limit(25)
    )
    const snap = await getDocs(q)
    return snap.docs.map(d => {
      const data = d.data()
      return { id: d.id, ...data, cds: tryParse(data.cdsData, []) }
    })
  } catch(e) { console.error('fetchScanHistory:', e); return [] }
}

export const clearScanHistory = async (userId) => {
  try {
    const q = query(collection(db,'scanHistory'), where('userId','==',userId))
    const snap = await getDocs(q)
    const batch = writeBatch(db)
    snap.docs.forEach(d => batch.delete(d.ref))
    await batch.commit(); return true
  } catch { return false }
}
