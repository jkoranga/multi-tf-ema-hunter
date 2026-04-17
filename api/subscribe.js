// api/subscribe.js — saves push subscription using Firebase REST API (no admin SDK needed)

const FIREBASE_PROJECT = 'ema-signal-hunter'
const FIREBASE_API_KEY = 'AIzaSyBrC5nTCrKB3t5_LVQFl5jF6BqBYqA4ZcU'

async function firestoreSet(collection, docId, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}/${docId}?key=${FIREBASE_API_KEY}`
  const fields = {}
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') fields[k] = { stringValue: v }
    else if (typeof v === 'object') fields[k] = { stringValue: JSON.stringify(v) }
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  })
  return res.ok
}

async function firestoreDelete(collection, docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}/${docId}?key=${FIREBASE_API_KEY}`
  const res = await fetch(url, { method: 'DELETE' })
  return res.ok
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method === 'POST') {
    const { subscription, userId } = req.body
    if (!subscription) return res.status(400).json({ error: 'Missing subscription' })
    const id = userId || subscription.endpoint.split('/').pop().slice(-20)
    const ok = await firestoreSet('pushSubscriptions', id, {
      subscription: subscription,
      userId: userId || '',
      createdAt: new Date().toISOString()
    })
    return res.status(ok ? 200 : 500).json({ ok, id })
  }

  if (req.method === 'DELETE') {
    const { userId } = req.body
    if (!userId) return res.status(400).json({ error: 'Missing userId' })
    const ok = await firestoreDelete('pushSubscriptions', userId)
    return res.status(200).json({ ok })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
