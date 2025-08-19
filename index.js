import express from 'express';
import { OpenAI } from 'openai';
import twilio from 'twilio';

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio manda form-encoded

const {
  OPENAI_API_KEY,
  OPENAI_ASSISTANT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  ADMIN_WHATSAPP,
  PORT = 3000,
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Envia mensagem WhatsApp
async function sendWhatsApp(to, body) {
  return twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    body,
  });
}

// Responde rápido ao Twilio e processa depois (evita timeout)
app.post('/twilio/whatsapp', async (req, res) => {
  const from = req.body.From;          // ex: whatsapp:+5512...
  const text = (req.body.Body || '').trim();
  res.status(200).send('');            // responde já; seguimos no background

  if (!from || !text) return;

  try {
    // Cria uma thread nova (simples) a cada mensagem
    const thread = await openai.beta.threads.create({
      assistant_id: OPENAI_ASSISTANT_ID,
    });

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

    // Aguarda o processamento terminar
    let status = run.status;
    const started = Date.now();
    while (!['completed','failed','cancelled','expired','incomplete'].includes(status)) {
      if (Date.now() - started > 45000) throw new Error('OpenAI timeout');
      await new Promise(r => setTimeout(r, 1200));
      const check = await openai.beta.threads.runs.retrieve(
        thread.id,
        run.id,
        { headers: { 'OpenAI-Beta': 'assistants=v2' } }
      );
      status = check.status;
    }
    if (status !== 'completed') throw new Error(`Run status: ${status}`);

    // Pega a última resposta do assistente
    const msgs = await openai.beta.threads.messages.list(thread.id, {
      order: 'desc',
      limit: 10,
      headers: { 'OpenAI-Beta': 'assistants=v2' },
    });

    const assistantMsg = msgs.data.find(m => m.role === 'assistant');
    const answer = assistantMsg
      ? assistantMsg.content.filter(c=>c.type==='text').map(c=>c.text.value).join('\n').trim()
      : 'Desculpe, não consegui responder agora. Pode tentar novamente?';

    await sendWhatsApp(from, answer);

    // Opcional: se a resposta contiver uma tag de notificação para você
    if (ADMIN_WHATSAPP && answer.includes('[NOTIFY_ADMIN]:')) {
      const note = answer.split('[NOTIFY_ADMIN]:')[1].trim().slice(0,1200);
      await sendWhatsApp(ADMIN_WHATSAPP, `🔔 Notificação do Lucas:\n${note}`);
    }
  } catch (e) {
    console.error('Erro ao processar:', e);
    try { await sendWhatsApp(from, 'Tive um problema técnico aqui 😕. Pode repetir a última mensagem?'); } catch {}
  }
});

app.get('/', (_req, res) => res.send('Lucas webhook OK'));
app.listen(PORT, () => console.log(`Webhook rodando na porta ${PORT}`));
