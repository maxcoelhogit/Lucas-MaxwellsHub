// api/whatsapp.js — Vercel Serverless (Twilio WhatsApp ↔ OpenAI Assistants v2)
// Requisitos de ENV na Vercel:
// OPENAI_API_KEY, OPENAI_ASSISTANT_ID
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER (ex: whatsapp:+5512991322782)
// ADMIN_WHATSAPP (ex: whatsapp:+55SEU_NUMERO)  ← opcional

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

// Garante o prefixo "whatsapp:" (evita erro 21659)
const norm = v => (v?.startsWith('whatsapp:') ? v : `whatsapp:${v}`);

// Lê corpo x-www-form-urlencoded enviado pelo Twilio
function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let data = '';
    req.on('data', chunk => { data += decoder.write(chunk); });
    req.on('end', () => {
      data += decoder.end();
      try { resolve(querystring.parse(data)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Envia mensagem via Twilio (com log)
async function sendWhatsApp(to, body) {
  const from = norm(TWILIO_WHATSAPP_NUMBER);
  const toNorm = norm(to);
  console.log('Twilio send →', { from, to: toNorm, preview: body?.slice(0, 160) });
  return twilioClient.messages.create({ from, to: toNorm, body });
}

// Validação mínima de variáveis
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
  if (req.method !== 'POST') {
    // Útil para sanity check no navegador
    return res.status(200).send('OK');
  }

  try {
    assertEnv();

    // 1) Lê o POST do Twilio
    const form = await readFormBody(req); // { From: 'whatsapp:+55...', Body: 'texto...' }
    const from = form.From;
    const text = (form.Body || '').trim();
    console.log('Inbound WhatsApp ←', { from, text });

    // Responde IMEDIATAMENTE ao Twilio para não estourar timeout
    res.status(200).send('');

    if (!from || !text) {
      console.log('Sem "from" ou "text"; nada a fazer.');
      return;
    }

    // 2) Cria Thread no Assistants v2
    const thread = await openai.beta.threads.create(
      { assistant_id: OPENAI_ASSISTANT_ID },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    // 3) Anexa a mensagem do usuário
    await openai.beta.threads.messages.create(
      thread.id,
      { role: 'user', content: text },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    // 4) Roda o assistente
    const run = await openai.beta.threads.runs.create(
      thread.id,
      { assistant_id: OPENAI_ASSISTANT_ID },
      { headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );

    // 5) Polling até concluir (máx ~45s)
    const t0 = Date.now();
    while (true) {
      const r = await openai.beta.threads.runs.retrieve(
        thread.id,
        run.id,
        { headers: { 'OpenAI-Beta': 'assistants=v2' } }
      );
      if (r.status === 'completed') break;
      if (['failed', 'expired', 'cancelled', 'incomplete'].includes(r.status)) {
        console.error('Run status:', r.status, r.last_error);
        throw new Error(`Run status: ${r.status}`);
      }
      if (Date.now() - t0 > 45000) throw new Error('OpenAI timeout');
      await new Promise(r => setTimeout(r, 1200));
    }

    // 6) Pega a última resposta do assistente
    const msgs = await openai.beta.threads.messages.list(
      thread.id,
      { order: 'desc', limit: 10, headers: { 'OpenAI-Beta': 'assistants=v2' } }
    );
    const assistantMsg = msgs.data.find(m => m.role === 'assistant');
    const answer = assistantMsg
      ? assistantMsg.content
          .filter(c => c.type === 'text')
          .map(c => c.text.value)
          .join('\n')
          .trim()
      : 'Desculpe, não consegui responder agora. Pode tentar novamente?';

    console.log('Assistant →', answer.slice(0, 300));

    // 7) Envia a resposta ao usuário no WhatsApp
    await sendWhatsApp(from, answer);

    // 8) (Opcional) Notificar admin se a resposta contiver a tag
    if (ADMIN_WHATSAPP && answer.includes('[NOTIFY_ADMIN]:')) {
      const note = answer.split('[NOTIFY_ADMIN]:')[1].trim().slice(0, 1200);
      await sendWhatsApp(ADMIN_WHATSAPP, `🔔 Notificação do Lucas:\n${note}`);
    }
  } catch (e) {
    console.error('Erro /api/whatsapp:', e);
    try {
      // Tentativa de resposta amigável se soubermos o "from"
      const form = req.body ? req.body : null;
      const fromFallback = form?.From || '';
      if (fromFallback) {
        await sendWhatsApp(fromFallback, 'Tive um problema técnico aqui 😕. Pode repetir a última mensagem?');
      }
    } catch {}
    // Já respondemos 200 acima; nada a retornar aqui.
  }
}
