// api/whatsapp.js — Vercel Serverless (sem Express)
import { OpenAI } from 'openai';
import twilio from 'twilio';
import { StringDecoder } from 'string_decoder';
import querystring from 'querystring';

const {
  OPENAI_API_KEY,
  OPENAI_ASSISTANT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  ADMIN_WHATSAPP,
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Lê corpo x-www-form-urlencoded vindo do Twilio
async function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let data = '';
    req.on('data', chunk => { data += decoder.write(chunk); });
    req.on('end', () => {
      data += decoder.end();
      try {
        resolve(querystring.parse(data));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Envia mensagem no WhatsApp via Twilio
async function sendWhatsApp(to, body) {
  return twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER, // ex: "whatsapp:+5512991322782"
    to,
    body,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  try {
    const form = await readFormBody(req);   // { From: 'whatsapp:+55...', Body: 'texto...' }
    const from = form.From;
    const text = (form.Body || '').trim();

    // Responde rápido para não estourar timeout do Twilio
    res.status(200).send('');  // Twilio aceita vazio

    if (!from || !text) return;

    // Cria thread e envia a mensagem do usuário
    const thread = await openai.beta.threads.create({ assistant_id: OPENAI_ASSISTANT_ID });
    await openai.beta.threads.messages.create(
      thread.id,
      { role: 'user', content: text },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    // Roda o assistente
    const run = await openai.beta.threads.runs.create(
      thread.id, { assistant_id: OPENAI_ASSISTANT_ID },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    // Aguarda conclusão (polling simples)
    const t0 = Date.now();
    while (true) {
      const r = await openai.beta.threads.runs.retrieve(
        thread.id, run.id, { headers: { 'OpenAI-Beta': 'assistants=v2' } }
      );
      if (r.status === 'completed') break;
      if (['failed','expired','cancelled','incomplete'].includes(r.status)) {
        throw new Error(`Run status: ${r.status}`);
      }
      if (Date.now() - t0 > 45000) throw new Error('OpenAI timeout');
      await new Promise(r => setTimeout(r, 1200));
    }

    // Pega a resposta do assistente
    const msgs = await openai.beta.threads.messages.list(thread.id, {
      order: 'desc', limit: 10, headers: { 'OpenAI-Beta': 'assistants=v2' },
    });
    const assistantMsg = msgs.data.find(m => m.role === 'assistant');
    const answer = assistantMsg
      ? assistantMsg.content.filter(c => c.type === 'text').map(c => c.text.value).join('\n').trim()
      : 'Desculpe, não consegui responder agora. Pode tentar novamente?';

    // Envia ao usuário no WhatsApp
    await sendWhatsApp(from, answer);

    // Opcional: notificar você se houver tag
    if (ADMIN_WHATSAPP && answer.includes('[NOTIFY_ADMIN]:')) {
      const note = answer.split('[NOTIFY_ADMIN]:')[1].trim().slice(0, 1200);
      await sendWhatsApp(ADMIN_WHATSAPP, `🔔 Notificação do Lucas:\n${note}`);
    }
  } catch (e) {
    console.error('Erro na função /api/whatsapp:', e);
    try {
      const fallback = 'Tive um problema técnico aqui 😕. Pode repetir a última mensagem?';
      // Se conseguirmos recuperar o "from" do erro, respondemos; se não, apenas log.
      if (e.from) await sendWhatsApp(e.from, fallback);
    } catch {}
  }
}
