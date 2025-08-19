// api/whatsapp.js — Vercel Serverless (Twilio WhatsApp ↔ OpenAI Assistants v2)
// Variáveis necessárias na Vercel:
// OPENAI_API_KEY, OPENAI_ASSISTANT_ID
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
// TWILIO_WHATSAPP_NUMBER  (ex: whatsapp:+5512991322782)
// ADMIN_WHATSAPP          (ex: whatsapp:+55SEU_NUMERO)  // opcional

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

// Garante o prefixo whatsapp:
const norm = v => (v?.startsWith('whatsapp:') ? v : `whatsapp:${v}`);

// Lê x-www-form-urlencoded do Twilio
function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let data = '';
    req.on('data', ch => { data += decoder.write(ch); });
    req.on('end', () => { data += decoder.end(); resolve(querystring.parse(data)); });
    req.on('error', reject);
  });
}

async function sendWhatsApp(to, body) {
  const from = norm(TWILIO_WHATSAPP_NUMBER);
  const toNorm = norm(to);
  console.log('Twilio send →', { from, to: toNorm, preview: (body || '').slice(0,160) });
  const msg = await twilioClient.messages.create({ from, to: toNorm, body });
  console.log('Twilio OK, SID:', msg.sid);
  return msg;
}

function assertEnv() {
  const miss = [];
  if (!OPENAI_API_KEY) miss.push('OPENAI_API_KEY');
  if (!OPENAI_ASSISTANT_ID) miss.push('OPENAI_ASSISTANT_ID');
  if (!TWILIO_ACCOUNT_SID) miss.push('TWILIO_ACCOUNT_SID');
  if (!TWILIO_AUTH_TOKEN) miss.push('TWILIO_AUTH_TOKEN');
  if (!TWILIO_WHATSAPP_NUMBER) miss.push('TWILIO_WHATSAPP_NUMBER');
  if (miss.length) throw new Error(`Variáveis ausentes: ${miss.join(', ')}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  let from = '';
  try {
    assertEnv();

    // 1) Ler payload do Twilio
    const form = await readFormBody(req);            // { From: 'whatsapp:+55...', Body: 'texto...' }
    from = form.From;
    const text = (form.Body || '').trim();
    console.log('Inbound WhatsApp ←', { from, text });

    if (!from || !text) {
      console.log('Sem "from" ou "text"; nada a fazer.');
      return res.status(200).send('OK');
    }

    // 2) Rodar o Assistants v2 (com deadline curto para ficar < ~12s)
    const thread = await openai.beta.threads.create(
      {}, { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    await openai.beta.threads.messages.create(
      thread.id,
      { role: 'user', content: text },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    const run = await openai.beta.threads.runs.create(
      thread.id,
      { assistant_id: OPENAI_ASSISTANT_ID },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    // Poll até 12s (Twilio costuma tolerar ~15s de webhook)
    const deadline = Date.now() + 12000;
    while (true) {
      const r = await openai.beta.threads.runs.retrieve(
        thread.id, run.id, { headers: { 'OpenAI-Beta': 'assistants=v2' } }
      );
      if (r.status === 'completed') break;
      if (['failed','expired','cancelled','incomplete'].includes(r.status)) {
        console.error('Run status:', r.status, r.last_error);
        throw new Error(`Run status: ${r.status}`);
      }
      if (Date.now() > deadline) { throw new Error('OpenAI deadline (12s)'); }
      await new Promise(r => setTimeout(r, 800));
    }

    const msgs = await openai.beta.threads.messages.list(
      thread.id,
      { order: 'desc', limit: 10, headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    const assistantMsg = msgs.data.find(m => m.role === 'assistant');
    const answer =
      assistantMsg
        ? assistantMsg.content.filter(c => c.type === 'text').map(c => c.text.value).join('\n').trim()
        : 'Desculpe, não consegui responder agora. Pode tentar novamente?';

    console.log('Assistant →', answer.slice(0, 300));

    // 3) Enviar resposta ao usuário e SÓ DEPOIS finalizar a request
    await sendWhatsApp(from, answer);

    // 4) (Opcional) Notificar admin se houver tag
    if (ADMIN_WHATSAPP && answer.includes('[NOTIFY_ADMIN]:')) {
      const note = answer.split('[NOTIFY_ADMIN]:')[1].trim().slice(0, 1000);
      await sendWhatsApp(ADMIN_WHATSAPP, `🔔 Notificação do Lucas:\n${note}`);
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('Erro /api/whatsapp:', {
      message: e.message, code: e.code, status: e.status, moreInfo: e.moreInfo
    });

    // Tenta resposta de fallback ao usuário
    try {
      if (from) await sendWhatsApp(from, 'Tive um problema técnico aqui 😕. Pode repetir a última mensagem?');
    } catch {}

    return res.status(200).send('OK');
  }
}
