# Аналитика Tandau: как включить

Сайт сам сообщает воркеру о каждом заходе, воркер записывает его в бесплатную базу **Cloudflare D1**, а страница **stats.html** показывает сводку: сколько людей, откуда пришли, города, устройства.

Что записывается: случайный id браузера, дата, источник (Telegram, Instagram, Google…), город и страна (их определяет Cloudflare), тип устройства, язык. **IP, имена и ответы тестов не записываются.**

Время: около 10 минут. Деньги: 0 ₸ (бесплатный план D1 — 5 млн чтений и 100 тыс. записей в день).

## 1. Создать базу
1. https://dash.cloudflare.com → слева **Storage & Databases → D1 SQL Database** → **Create**.
2. Имя: `tandau-db` → **Create**. Таблицы создавать не нужно — воркер сделает их сам.

## 2. Подключить базу к воркеру
1. **Workers & Pages** → открой воркер `tandauu-ai`.
2. **Bindings** (или Settings → Bindings) → **Add binding → D1 database**.
3. Variable name: `DB` (именно так, большими буквами), база: `tandau-db` → **Save / Deploy**.

## 3. Пароль для статистики
1. В том же воркере: **Settings → Variables and Secrets → Add**.
2. Type: **Secret**, Name: `STATS_KEY`, Value: придумай пароль → **Deploy**.

## 4. Обновить код воркера
1. В воркере нажми **Edit code**.
2. Удали старый код, вставь весь новый `worker.js` из этого репозитория → **Deploy**.
3. Проверка: открой https://tandauu-ai.aidonama05.workers.dev — должно быть `"database":true,"statsKey":true`.

## 5. Смотреть статистику
Открой https://aidonama.github.io/stats.html и введи пароль `STATS_KEY`.

## Как узнать, сколько пришло из Telegram, Instagram и т.д.
Внутри Telegram и многих приложений браузер не сообщает, откуда пришёл человек, поэтому такие заходы попадают в «прямой заход». Чтобы видеть точно, давай ссылки с меткой:

| Где | Ссылка |
|---|---|
| Telegram-канал | `https://aidonama.github.io/?utm_source=telegram` |
| Instagram (био) | `https://aidonama.github.io/?utm_source=instagram` |
| TikTok | `https://aidonama.github.io/?utm_source=tiktok` |
| WhatsApp, рассылка по классам | `https://aidonama.github.io/?utm_source=whatsapp` |
| Конкретный пост/акция | добавь `&utm_campaign=название`, например `?utm_source=telegram&utm_campaign=ent_tips` |

Короткий вариант тоже работает: `?from=telegram`.

## Как считается
- **Люди** — разные браузеры. Один человек с телефона и ноутбука = 2.
- **Заходы** — сеансы. Обновление страницы в том же сеансе не считается повторно.
- **Новые** — браузер открыл сайт впервые.
- **Установили** — заход из установленного на телефон приложения (PWA).
- Даты считаются по времени Алматы.
