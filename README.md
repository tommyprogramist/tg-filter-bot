# Rocket Bot

Playwright-бот для авто-подтверждения «Сделок» на https://rocket.do/deals-list по сигналу от телефона-companion.

## Что делает

```
Телефон ловит SMS «5 000 ars» → POST /api/confirm-request на сервер
    ↓
Сервер кладёт в очередь confirm_queue со статусом pending
    ↓
Бот (этот процесс) каждые 2 сек GET /bot/queue/next
    ↓
Идёт на https://rocket.do/deals-list → ищет строку с суммой "5 000 ars"
и временем близким к requested_at (окно ±5 минут) → жмёт «Подтвердить поступление»
    ↓
POST /bot/queue/:id/done
```

## Первый запуск (захват сессии вручную)

На rocket.do авторизация через **токен + Google Authenticator (2FA)** — бот не может пройти автоматически. Поэтому первый раз запускаем в headed-режиме и логинимся руками:

```bash
cd /Users/kirill./tests/tg-filter-app/bot
npm install
npx playwright install chromium

# Запуск с видимым браузером:
SERVER_URL=https://your-app.up.railway.app \
BOT_API_KEY=<секрет> \
HEADLESS=false \
node index.js
```

В открывшемся Chromium:
1. Откроется https://rocket.do/deals-list — редиректнёт на логин
2. Введи токен `35865b9e-2d8e-483c-966c-0488e6efb7a9`
3. Подтверди 2FA через Google Authenticator
4. После успешного входа бот сам сохранит `./storage_state.json` (содержит cookies сессии)
5. Дальше бот начинает работать

После первого запуска `storage_state.json` хранит сессию (обычно живёт неделями), и можно запускать в headless:

```bash
SERVER_URL=... BOT_API_KEY=... node index.js
```

## ENV-переменные

| Переменная | По умолчанию | Что значит |
|-----------|--------------|------------|
| `SERVER_URL` | `http://localhost:3000` | URL нашего сервера (Railway) |
| `BOT_API_KEY` | (обязательно) | Общий секрет с сервером |
| `ROCKET_REQUESTS_URL` | `https://rocket.do/deals-list` | URL вкладки сделок |
| `HEADLESS` | `true` | `false` для headed-режима (для setup) |
| `STORAGE_PATH` | `./storage_state.json` | Куда сохранять сессию |
| `MOCK_SITE` | `false` | `true` — не ходит на сайт, только логает |

## Mock-режим (без сайта, для smoke-теста)

```bash
SERVER_URL=http://localhost:3000 BOT_API_KEY=secret MOCK_SITE=true node index.js
```

Бот будет poll'ить очередь, но вместо реальных кликов писать `[MOCK] would confirm amount=5000`. Удобно для проверки что сервер↔бот связь работает.

## Деплой на Railway

1. Создай в проекте Railway **второй сервис**, root path = `bot/`
2. Build → Dockerfile (есть в этой папке)
3. ENV-переменные:
   - `SERVER_URL` (URL основного сервиса)
   - `BOT_API_KEY` (тот же секрет что на основном сервере в env)
4. **Volume** для `storage_state.json` — иначе при рестарте сессия теряется и нужно опять руками логиниться. Railway → сервис → Volumes → новый volume на `/app` (или хотя бы на `./storage_state.json`)
5. Перед deploy — один раз локально захвати сессию (см. выше) и **закоммить storage_state.json в volume Railway** (например через CLI `railway run cp`)

## Селекторы

В `selectors.js` — реальные классы из DOM rocket.do:
- Строка: `tr.repay-table__data-row`
- Сумма (локальная): `td:nth-child(2) .td-cell-info` — формат «5 000 ars»
- Время: `td:nth-child(1) .td-cell-info` — формат «28 апреля 2026 г. в 03:18»
- Кнопка: `button.repay-button:has-text("Подтвердить")`

Если сайт rocket.do поменяет вёрстку — править `selectors.js`.
