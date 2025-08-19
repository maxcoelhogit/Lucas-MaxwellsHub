// api/whatsapp.js — versão com logs
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

async function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let data = '';
    req.on('data', chunk => { data += decoder.write(chunk); });
    req.on('end', () => { data += decoder.end(); resolve(querystring.parse(data)); });
    req.on('error', reject);
  });
}

async function sendWhatsApp(to, body) {
  console.log('Twilio send →', { to, bodyPreview: body.slice(0, 120) });
  return twilioClient.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to, body });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  let from = '';
  try {
    const form = await readFormBody(req);
    from = form.From;
    const text = (form.Body || '').trim();
    console.log('Inbound WhatsApp ←', { from, text });

    // Responder já ao Twilio para evitar timeout
    res.status(200).send('');

    if (!from || !text) return;

    // 1) Cria thread
    const thread = await openai.beta.threads.create(
      { assistant_id: OPENAI_ASSISTANT_ID },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    // 2) Mensagem do usuário
    await openai.beta.threads.messages.create(
      thread.id,
      { role: 'user', content: text },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    // 3) Run
    const run = await openai.beta.threads.runs.create(
      thread.id,
      { assistant_id: OPENAI_ASSISTANT_ID },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    // 4) Polling
    const t0 = Date.now();
    while (true) {
      const r = await openai.beta.threads.runs.retrieve(
        thread.id, run.id, { headers: { 'OpenAI-Beta': 'assistants=v2' } }
      );
      if (r.status === 'completed') break;
      if (['failed','expired','cancelled','incomplete'].includes(r.status)) {
        console.error('Run status:', r.status, r.last_error);
        throw new Error(`Run status: ${r.status}`);
      }
      if (Date.now() - t0 > 45000) throw new Error('OpenAI timeout');
      await new Promise(r => setTimeout(r, 1200));
    }

    // 5) Mensagem do assistente
    const msgs = await openai.beta.threads.messages.list(
      thread.id,
      { order: 'desc', limit: 10, headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    const assistantMsg = msgs.data.find(m => m.role === 'assistant');
    const answer = assistantMsg
      ? assistantMsg.content.filter(c => c.type === 'text').map(c => c.text.value).join('\n').trim()
      : 'Desculpe, não consegui responder agora. Pode tentar novamente?';

    console.log('Assistant →', answer.slice(0, 200));

    // 6) Envia resposta ao usuário
    await sendWhatsApp(from, answer);

    // 7) Notificação opcional
    if (ADMIN_WHATSAPP && answer.includes('[NOTIFY_ADMIN]:')) {
      const note = answer.split('[NOTIFY_ADMIN]:')[1].trim().slice(0, 1200);
      await sendWhatsApp(ADMIN_WHATSAPP, `🔔 Notificação do Lucas:\n${note}`);
    }
  } catch (e) {
    console.error('Erro /api/whatsapp:', e);
    try { if (from) await sendWhatsApp(from, 'Tive um problema técnico aqui 😕. Pode repetir a última mensagem?'); } catch {}
  }
}
