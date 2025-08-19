// api/selftest.js
import twilio from 'twilio';
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER, ADMIN_WHATSAPP } = process.env;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const norm = v => v?.startsWith('whatsapp:') ? v : `whatsapp:${v}`;

export default async function handler(req, res) {
  try {
    const from = norm(TWILIO_WHATSAPP_NUMBER);
    const to = norm(ADMIN_WHATSAPP);
    const msg = await client.messages.create({ from, to, body: '✅ Selftest: Twilio → WhatsApp OK (Lucas).' });
    res.status(200).json({ ok: true, sid: msg.sid, from, to });
  } catch (e) {
    console.error('Selftest error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}
