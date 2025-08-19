// api/selftest.js
import twilio from 'twilio';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  ADMIN_WHATSAPP
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

export default async function handler(req, res) {
  try {
    const msg = await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,           // ex: "whatsapp:+5512991322782"
      to: ADMIN_WHATSAPP,                      // ex: "whatsapp:+5512988485819"
      body: "✅ Selftest: Twilio → WhatsApp OK (Lucas)."
    });
    res.status(200).json({ ok: true, sid: msg.sid });
  } catch (e) {
    console.error('Selftest error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}
