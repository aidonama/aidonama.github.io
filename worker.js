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
//
// Аналитика (см. ANALYTICS.md):
//   DB              — привязка базы Cloudflare D1 (Settings → Bindings → D1 database, имя переменной DB)
//   STATS_KEY       — секрет, пароль для страницы статистики stats.html
// Адреса: POST /track — сайт сообщает о заходе; GET /stats?key=… — сводка для stats.html.
// IP-адреса в базу не пишутся: только город/страна от Cloudflare, источник и тип устройства.

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

/* ============================ АНАЛИТИКА ============================ */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,            -- время захода, мс
    day TEXT NOT NULL,              -- дата по Алматы, YYYY-MM-DD
    vid TEXT NOT NULL,              -- случайный id браузера (не связан с личностью)
    is_new INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,           -- telegram, instagram, google, direct, ...
    ref_host TEXT,                  -- сайт, с которого пришли
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
    country TEXT, region TEXT, city TEXT,
    device TEXT, os TEXT, lang TEXT,
    installed INTEGER NOT NULL DEFAULT 0  -- открыто как установленное приложение
  )`,
  `CREATE INDEX IF NOT EXISTS visits_day ON visits(day)`,
  `CREATE INDEX IF NOT EXISTS visits_vid ON visits(vid)`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady = true;
}

const almatyDay = (ms = Date.now()) => new Date(ms + 5 * 3600e3).toISOString().slice(0, 10);

const SOURCES = [
  ['telegram', /(^|\.)(t\.me|telegram\.(org|me))$/, /Telegram/i],
  ['instagram', /(^|\.)instagram\.com$/, /Instagram/i],
  ['tiktok', /(^|\.)tiktok\.com$/, /musical_ly|BytedanceWebview|TikTok/i],
  ['whatsapp', /(^|\.)(whatsapp\.com|wa\.me)$/, /WhatsApp/i],
  ['facebook', /(^|\.)(facebook\.com|fb\.com)$/, /FBAN|FBAV/i],
  ['vk', /(^|\.)(vk\.com|vk\.ru)$/, null],
  ['youtube', /(^|\.)(youtube\.com|youtu\.be)$/, null],
  ['google', /(^|\.)google\.[a-z.]+$/, null],
  ['yandex', /(^|\.)(yandex\.[a-z.]+|ya\.ru)$/, null],
  ['github', /(^|\.)github\.com$/, null],
];

function detectSource(utm, refHost, ua) {
  if (utm) return utm.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40) || 'other';
  for (const [name, host, agent] of SOURCES) {
    if (refHost && host.test(refHost)) return name;
    if (agent && agent.test(ua)) return name;
  }
  if (refHost) return 'other';
  return 'direct';
}

function detectDevice(ua) {
  const os = /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'other';
  const device = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? 'tablet'
    : /Mobi|iPhone|Android/i.test(ua) ? 'mobile' : 'desktop';
  return { os, device };
}

const trackHits = new Map();
function tooManyTracks(ip) {
  const now = Date.now();
  const xs = (trackHits.get(ip) || []).filter(t => now - t < 60000);
  xs.push(now);
  trackHits.set(ip, xs);
  if (trackHits.size > 5000) trackHits.clear();
  return xs.length > 30;
}

async function track(req, env) {
  let b;
  try { b = JSON.parse(await req.text()); } catch { return { error: 'bad json' }; }
  const vid = clip(b.vid, 64).replace(/[^a-zA-Z0-9-]/g, '');
  if (!vid) return { error: 'no vid' };
  let refHost = '';
  try {
    const r = new URL(String(b.ref || ''));
    if (r.hostname !== new URL(req.headers.get('Origin') || 'https://x').hostname) refHost = r.hostname.replace(/^www\./, '');
  } catch {}
  const ua = req.headers.get('User-Agent') || '';
  const cf = req.cf || {};
  const { os, device } = detectDevice(ua);
  const now = Date.now();
  await ensureSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO visits (ts, day, vid, is_new, source, ref_host, utm_source, utm_medium, utm_campaign, country, region, city, device, os, lang, installed)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
  ).bind(
    now, almatyDay(now), vid, b.new ? 1 : 0,
    detectSource(clip(b.utm_source, 60), refHost, ua), clip(refHost, 120) || null,
    clip(b.utm_source, 60) || null, clip(b.utm_medium, 60) || null, clip(b.utm_campaign, 80) || null,
    clip(cf.country, 8) || null, clip(cf.region, 80) || null, clip(cf.city, 80) || null,
    device, os, clip(b.lang, 10) || null, b.installed ? 1 : 0,
  ).run();
  return { ok: true };
}

async function stats(env, days) {
  await ensureSchema(env.DB);
  const today = almatyDay();
  const from = almatyDay(Date.now() - (days - 1) * 86400e3);
  const week = almatyDay(Date.now() - 6 * 86400e3);
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const top = (col) => q(`SELECT COALESCE(${col}, '—') AS k, COUNT(*) AS visits, COUNT(DISTINCT vid) AS people
    FROM visits WHERE day >= ?1 GROUP BY k ORDER BY visits DESC LIMIT 15`, from);
  const [all, t, w, p, byDay, source, city, country, device, os, campaign, ref] = await env.DB.batch([
    q(`SELECT COUNT(*) AS visits, COUNT(DISTINCT vid) AS people, MIN(day) AS since FROM visits`),
    q(`SELECT COUNT(*) AS visits, COUNT(DISTINCT vid) AS people, SUM(is_new) AS new_people FROM visits WHERE day = ?1`, today),
    q(`SELECT COUNT(*) AS visits, COUNT(DISTINCT vid) AS people, SUM(is_new) AS new_people FROM visits WHERE day >= ?1`, week),
    q(`SELECT COUNT(*) AS visits, COUNT(DISTINCT vid) AS people, SUM(is_new) AS new_people, SUM(installed) AS installed FROM visits WHERE day >= ?1`, from),
    q(`SELECT day, COUNT(*) AS visits, COUNT(DISTINCT vid) AS people, SUM(is_new) AS new_people FROM visits WHERE day >= ?1 GROUP BY day ORDER BY day`, from),
    top('source'), top('city'), top('country'), top('device'), top('os'), top('utm_campaign'), top('ref_host'),
  ]);
  const one = r => r.results[0] || {};
  return {
    ok: true, today, from, days,
    total: one(all), today_: one(t), week: one(w), period: one(p),
    byDay: byDay.results,
    top: { source: source.results, city: city.results, country: country.results, device: device.results, os: os.results, campaign: campaign.results, ref: ref.results },
  };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) || (!!env.EXTRA_ORIGIN && origin === env.EXTRA_ORIGIN);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Stats-Key',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname.replace(/\/+$/, '');

    // Аналитика: заход на сайт.
    if (path === '/track') {
      if (req.method !== 'POST') return json({ error: 'method' }, 405);
      if (!allowed) return json({ error: 'origin' }, 403);
      if (!env.DB) return json({ error: 'no database' }, 503);
      if (tooManyTracks(req.headers.get('CF-Connecting-IP') || 'local')) return json({ error: 'rate' }, 429);
      try { return json(await track(req, env)); } catch (e) { return json({ error: 'db', details: String(e.message || e) }, 500); }
    }
    // Аналитика: сводка для stats.html (нужен пароль STATS_KEY).
    if (path === '/stats') {
      if (!env.DB) return json({ error: 'no database' }, 503);
      if (!env.STATS_KEY) return json({ error: 'no STATS_KEY' }, 503);
      if (req.headers.get('X-Stats-Key') !== env.STATS_KEY) return json({ error: 'key' }, 401);
      const days = Math.min(365, Math.max(1, parseInt(new URL(req.url).searchParams.get('days') || '30', 10) || 30));
      try { return json(await stats(env, days)); } catch (e) { return json({ error: 'db', details: String(e.message || e) }, 500); }
    }

    // Проверка настройки: откройте адрес воркера в браузере.
    if (req.method === 'GET') return json({ ok: true, service: 'Tandau AI', gemini: !!env.GEMINI_API_KEY, workersAI: !!env.AI, database: !!env.DB, statsKey: !!env.STATS_KEY });
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
