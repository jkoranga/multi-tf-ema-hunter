// api/vapid-public-key.js — returns VAPID public key to frontend
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY })
}
