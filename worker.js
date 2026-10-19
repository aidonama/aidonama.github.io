// Tandau AI — сервер-посредник на Cloudflare Workers.
// Сайт (GitHub Pages) отправляет сюда вопрос школьника, а этот код спрашивает ИИ
// и возвращает ответ. Ключ Gemini хранится здесь в секрете и не попадает в браузер.
//
// Порядок: 1) Google Gemini (нужен секрет GEMINI_API_KEY)
//          2) запасной ИИ Cloudflare Workers AI (нужна привязка AI, ключ не нужен)
// Если оба недоступны, сайт сам переключится на ответы из своей базы.
//
// Настройки (Settings → Variables), все необязательные, кроме ключа:
//   GEMINI_API_KEY  — секрет, ключ из aistudio.google.com
//   GEMINI_MODEL    — модели через запятую, по умолчанию "gemini-2.5-flash,gemini-2.5-flash-lite"
//   CF_MODEL        — модель Workers AI, по умолчанию "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
//   EXTRA_ORIGIN    — ещё один адрес сайта, которому можно обращаться (например, свой домен)

const ALLOWED_ORIGINS = [
  'https://aidonama.github.io',
  'http://localhost:8123',
  'http://127.0.0.1:8123',
];

const LIMITS = { question: 1000, message: 2000, history: 10, context: 7000, perMinute: 12 };

function systemPrompt(lang) {
  const kk = lang === 'kk';
  return [
    'Ты — Қыран, беркут-проводник в приложении Tandau (Таңдау). Ты помогаешь школьникам 9–11 классов Казахстана выбрать профессию, предметы ЕНТ и вуз и подготовиться к ЕНТ.',
    kk
      ? 'Отвечай на казахском языке, если школьник пишет по-казахски или не ясно, на каком языке он пишет; если вопрос на русском — отвечай по-русски.'
      : 'Отвечай на языке вопроса; по умолчанию — по-русски.',
    'Пиши дружелюбно, просто и конкретно, как старший товарищ: короткие предложения, без сложных терминов. До 160 слов. Когда помогает — короткий список через "- ". Можно выделять важное **жирным**. Не пиши заголовки и таблицы.',
    'Иногда можно одной фразой использовать образ беркута и пути (например, «с высоты видно…»), но не в каждом ответе и не вместо пользы.',
    'Не выдумывай проходные баллы, количество грантов, цены и точные цифры приёма: они меняются каждый год — отправляй на testcenter.kz и сайт вуза. Если не уверен в сочетании профильных предметов ЕНТ, посоветуй проверить актуальный перечень НЦТ.',
    'Не ставь психологических диагнозов. Если школьник пишет о сильном стрессе, страхе или о том, что ему плохо, поддержи и посоветуй поговорить со взрослым, которому он доверяет, или со школьным психологом; в опасной ситуации — телефон доверия 111 (Казахстан, бесплатно).',
    'Говори только о учёбе, профессиях, вузах, ЕНТ, поступлении и связанных с этим вещах. На посторонние просьбы вежливо отвечай, что ты помощник Tandau, и предложи вернуться к выбору профессии.',
    'Ниже — справка приложения и данные школьника. Используй их, только если это помогает ответу, и не пересказывай их целиком.',
  ].join('\n');
}

const recent = new Map(); // ip -> [timestamps], живёт в памяти одного экземпляра
function tooMany(ip) {
  const now = Date.now();
  const xs = (recent.get(ip) || []).filter(t => now - t < 60000);
  xs.push(now);
  recent.set(ip, xs);
  if (recent.size > 5000) recent.clear();
  return xs.length > LIMITS.perMinute;
}

const clip = (s, n) => String(s ?? '').slice(0, n);

function cleanMessages(raw) {
  const list = Array.isArray(raw) ? raw.slice(-LIMITS.history) : [];
  const out = [];
  for (const m of list) {
    const role = m && m.role === 'user' ? 'user' : 'model';
    const text = clip(m && m.text, LIMITS.message).trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.text += '\n' + text;
    else out.push({ role, text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function askGemini(env, system, msgs) {
  const models = (env.GEMINI_MODEL || 'gemini-2.5-flash,gemini-2.5-flash-lite').split(',').map(s => s.trim()).filter(Boolean);
  const body = (thinking) => JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: msgs.map(m => ({ role: m.role, parts: [{ text: m.text }] })),
    generationConfig: { temperature: 0.6, maxOutputTokens: 900, ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
  });
  let lastErr = 'no model';
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const call = (thinking) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: body(thinking),
    });
    let res = await call(true);
    if (res.status === 400) res = await call(false); // у некоторых моделей нет настройки thinking
    if (!res.ok) { lastErr = `${model}: HTTP ${res.status}`; continue; }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (text) return { text, engine: 'gemini', model };
    lastErr = `${model}: empty answer (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`;
  }
  throw new Error(lastErr);
}

async function askWorkersAI(env, system, msgs) {
  const model = env.CF_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const r = await env.AI.run(model, {
    messages: [{ role: 'system', content: system }, ...msgs.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))],
    max_tokens: 700,
    temperature: 0.6,
  });
  const text = String(r?.response ?? r?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('workers-ai: empty answer');
  return { text, engine: 'workers-ai', model };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) || (!!env.EXTRA_ORIGIN && origin === env.EXTRA_ORIGIN);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // Проверка настройки: откройте адрес воркера в браузере.
    if (req.method === 'GET') return json({ ok: true, service: 'Tandau AI', gemini: !!env.GEMINI_API_KEY, workersAI: !!env.AI });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    if (!allowed) return json({ error: 'origin' }, 403);
    if (tooMany(req.headers.get('CF-Connecting-IP') || 'local')) return json({ error: 'rate', text: 'Слишком много вопросов подряд. Подожди минуту.' }, 429);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const lang = body.lang === 'kk' ? 'kk' : 'ru';
    const msgs = cleanMessages(body.messages);
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json({ error: 'no question' }, 400);
    msgs[msgs.length - 1].text = clip(msgs[msgs.length - 1].text, LIMITS.question);
    const system = systemPrompt(lang) + '\n\n' + clip(body.context, LIMITS.context);

    const errors = [];
    if (env.GEMINI_API_KEY) {
      try { return json(await askGemini(env, system, msgs)); } catch (e) { errors.push(String(e.message || e)); }
    }
    if (env.AI) {
      try { return json(await askWorkersAI(env, system, msgs)); } catch (e) { errors.push(String(e.message || e)); }
    }
    return json({ error: 'unavailable', details: errors }, 503);
  },
};
