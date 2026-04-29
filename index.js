// Bot-оператор для авто-подтверждения сделок на https://rocket.do/deals-list
// Цикл: poll очередь на сервере → найти на сайте сделку с такой суммой и временем
// → нажать «Подтвердить поступление» → отчитаться серверу.

import crypto from 'node:crypto';
import { chromium } from 'playwright-chromium';
import { SELECTORS, parseLocalAmount, parseRussianDate } from './selectors.js';

// ===== TOTP (Google Authenticator-совместимый генератор) =====
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const output = [];
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >> (bits - 8)) & 0xFF);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTotpCode(secret, time = Math.floor(Date.now() / 1000)) {
  const counter = Math.floor(time / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const key = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0F;
  const code = ((hmac[offset] & 0x7F) << 24) |
               (hmac[offset + 1] << 16) |
               (hmac[offset + 2] << 8) |
               hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

const SERVER_URL    = process.env.SERVER_URL    || 'http://localhost:3000';
const BOT_API_KEY   = process.env.BOT_API_KEY   || '';
const REQUESTS_URL  = process.env.ROCKET_REQUESTS_URL || 'https://rocket.do/deals-list';
// LOGIN_TOKEN/TOTP_SECRET оставлены как fallback для одиночного режима (без БД-кредов)
const LOGIN_TOKEN   = process.env.LOGIN_TOKEN   || '';
const TOTP_SECRET   = process.env.ROCKET_TOTP_SECRET || '';
const HEADLESS      = process.env.HEADLESS !== 'false';
const MOCK_SITE     = process.env.MOCK_SITE === 'true';
const ACCOUNT_IDLE_MS = 30 * 60 * 1000;  // закрываем idle-контексты через 30 мин
const ACCOUNT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const TFA_POLL_TIMEOUT_MS = 10 * 60 * 1000;  // 10 минут на ввод 2FA пользователем
const TFA_POLL_INTERVAL_MS = 2000;
const SITE_SCAN_INTERVAL_MS = 60 * 1000;  // фоновый скан списка сделок каждую минуту

let lastSiteScanAt = 0;
const SEEN_DEALS = new Map();  // key "accountId|time|amount" → { status, parsedAmount }

// Multi-tenant: один browser, по контексту на account_id
const accountContexts = new Map();  // accountId → { context, page, lastUsedAt, lastReloadAt }
const MATCH_WINDOW_MS = 10 * 60 * 1000;  // 10 минут
const POLL_IDLE_MS    = 2000;
const RETRY_ATTEMPTS  = 6;
const RETRY_DELAY_MS  = 500;
const RELOAD_MIN_INTERVAL_MS = 60 * 1000;  // не чаще раза в 1 минуту обновляем страницу

let lastReloadAt = 0;

if (!BOT_API_KEY) {
  console.error('FATAL: BOT_API_KEY env not set');
  process.exit(1);
}

// Multi-tenant: storage_state хранится в БД per-account (users.rocket_storage_state).
// Загружается в getAccountContext() при создании контекста.

function botFetch(path, init = {}) {
  return fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: {
      'X-Bot-Key': BOT_API_KEY,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function fetchNext() {
  const r = await botFetch('/bot/queue/next');
  if (r.status === 204) return null;
  if (!r.ok) {
    console.error('queue/next failed:', r.status, await r.text().catch(() => ''));
    return null;
  }
  return r.json();
}

async function reportDone(id, success, error = null) {
  await botFetch(`/bot/queue/${id}/done`, {
    method: 'POST',
    body: JSON.stringify({ success, error }),
  }).catch(e => console.error('reportDone failed:', e.message));
}

// Шлёт уведомление в Telegram через сервер
async function notify(type, payload = {}) {
  return botFetch('/bot/notify', {
    method: 'POST',
    body: JSON.stringify({ type, ...payload }),
  }).catch(e => console.error('notify failed:', e.message));
}

// Делает скриншот страницы и шлёт в Telegram через сервер
async function captureScreenshot(page, caption = '', accountId = null) {
  try {
    // JPEG quality 70 — заметно меньше PNG (~50-150 КБ vs 300-700 КБ для 1920×1080)
    const buf = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 70 });
    const base64 = buf.toString('base64');
    console.log(`screenshot taken: ${buf.length} bytes`);
    const r = await botFetch('/bot/screenshot', {
      method: 'POST',
      body: JSON.stringify({ accountId, caption, base64 }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      console.log(`screenshot sent → server OK: ${JSON.stringify(data)}`);
    } else {
      const text = await r.text().catch(() => '');
      console.error(`screenshot server returned ${r.status}: ${text.slice(0, 300)}`);
    }
  } catch (e) {
    console.error('captureScreenshot failed:', e.message);
  }
}

function startHeartbeat() {
  setInterval(() => {
    botFetch('/bot/heartbeat', { method: 'POST', body: JSON.stringify({}) })
      .catch(e => console.error('heartbeat failed:', e.message));
  }, 10_000);
}

/**
 * Получает креды юзера с сервера по account_id.
 * Возвращает { token, totp_secret, storage_state_base64 } или null если нет.
 */
async function fetchAccountCreds(accountId) {
  try {
    const r = await botFetch(`/bot/account/${accountId}/state`);
    if (!r.ok) {
      console.error(`fetchAccountCreds(${accountId}) → ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error('fetchAccountCreds error:', e.message);
    return null;
  }
}

/**
 * Сохраняет storage_state контекста обратно в БД сервера.
 */
async function saveAccountStorage(accountId, context) {
  try {
    const state = await context.storageState();
    const b64 = Buffer.from(JSON.stringify(state)).toString('base64');
    await botFetch(`/bot/account/${accountId}/state`, {
      method: 'PUT',
      body: JSON.stringify({ storage_state_base64: b64 }),
    });
    console.log(`[${accountId}] storage saved (${b64.length} chars)`);
  } catch (e) {
    console.error(`saveAccountStorage(${accountId}) error:`, e.message);
  }
}

/**
 * Возвращает (или создаёт) browser-context для аккаунта.
 * Сам логинится если нужно.
 */
async function getAccountContext(browser, accountId) {
  const existing = accountContexts.get(accountId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  // Берём креды юзера
  const creds = await fetchAccountCreds(accountId);
  // Fallback: если есть LOGIN_TOKEN в ENV и БД-кредов нет, используем ENV
  // (для обратной совместимости пока юзеры не заполнили rocket-креды)
  const token = creds?.token || LOGIN_TOKEN;
  const totp = creds?.totp_secret || TOTP_SECRET;
  const storageB64 = creds?.storage_state_base64 || '';

  if (!token) {
    throw new Error(`account ${accountId}: no rocket_token (заполни в Профиле сайта)`);
  }

  // Парсим сохранённый state
  let storageState;
  if (storageB64) {
    try {
      storageState = JSON.parse(Buffer.from(storageB64, 'base64').toString('utf-8'));
    } catch (e) {
      console.warn(`[${accountId}] failed to parse storage state, will re-login`);
    }
  }

  console.log(`[${accountId}] creating new browser context`);
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();

  try {
    await page.goto(REQUESTS_URL, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.error(`[${accountId}] initial goto failed:`, e.message);
  }

  // Проверяем залогинены ли (по индикатору). Если нет — делаем логин с кредами юзера.
  const indicatorVisible = await page.locator(SELECTORS.loginSuccessIndicator)
    .first().isVisible({ timeout: 2000 }).catch(() => false);

  if (!indicatorVisible) {
    console.log(`[${accountId}] not logged in, performing login`);
    const ok = await performLoginWith(page, token, totp, accountId);
    if (!ok) {
      await context.close().catch(() => {});
      throw new Error(`[${accountId}] login failed`);
    }
    await saveAccountStorage(accountId, context);
  } else {
    console.log(`[${accountId}] already logged in (storage_state valid)`);
  }

  const entry = { context, page, lastUsedAt: Date.now(), lastReloadAt: Date.now(), accountId };
  accountContexts.set(accountId, entry);
  return entry;
}

/**
 * Закрывает контексты которые не использовались дольше ACCOUNT_IDLE_MS.
 */
async function cleanupIdleContexts() {
  const now = Date.now();
  for (const [accountId, entry] of accountContexts) {
    if (now - entry.lastUsedAt > ACCOUNT_IDLE_MS) {
      console.log(`[${accountId}] closing idle context (${Math.round((now - entry.lastUsedAt)/60000)} min idle)`);
      try { await saveAccountStorage(accountId, entry.context); } catch {}
      try { await entry.context.close(); } catch {}
      accountContexts.delete(accountId);
    }
  }
}

async function ensureLoggedIn(page) {
  // Если на странице есть индикатор успешного логина — мы уже залогинены
  try {
    if (await page.locator(SELECTORS.loginSuccessIndicator).first().isVisible({ timeout: 2000 })) {
      console.log('already logged in');
      return true;
    }
  } catch {}
  // Не залогинены — пробуем интерактивный логин с 2FA через Telegram
  if (!LOGIN_TOKEN) {
    console.warn('not logged in and LOGIN_TOKEN env not set');
    return false;
  }
  return await performLogin(page);
}

/**
 * Чистит 6 ячеек, вводит code через keyboard.press (auto-advance работает корректно),
 * проверяет что в DOM реально 6 правильных цифр (фолбэк на .fill() если не сошлось),
 * и кликает submit. Возвращает true если ввод+клик сработали (НЕ означает успех логина).
 */
async function fillAndSubmitTfa(page, tfaInputs, code, accountId) {
  // Чистим (на случай если что-то осталось от предыдущей попытки)
  for (let i = 0; i < 6; i++) {
    try { await tfaInputs.nth(i).fill(''); } catch {}
  }
  // Кликаем первую ячейку и печатаем все цифры — auto-advance переводит фокус сам
  try {
    await tfaInputs.first().click({ timeout: 3000 });
  } catch (e) {
    console.warn(`[${accountId}] tfa: click first input failed: ${e.message}`);
    return false;
  }
  for (const ch of code) {
    await page.keyboard.press(ch, { delay: 30 });
  }
  // Верификация: что в DOM на самом деле
  const filledValues = await tfaInputs.evaluateAll(els => els.map(e => e.value || ''));
  const joined = filledValues.join('');
  if (joined !== code) {
    console.warn(`[${accountId}] tfa: keyboard.press mismatch (got "${joined.replace(/./g, '*')}" len=${joined.length}, want len=${code.length}), retrying via .fill()`);
    for (let i = 0; i < 6; i++) {
      try { await tfaInputs.nth(i).fill(''); } catch {}
    }
    for (let i = 0; i < 6; i++) {
      await tfaInputs.nth(i).fill(code[i]);
    }
    const recheck = await tfaInputs.evaluateAll(els => els.map(e => e.value || '')).then(v => v.join(''));
    if (recheck !== code) {
      console.error(`[${accountId}] tfa: even .fill() fallback didn't match (got len=${recheck.length})`);
      return false;
    }
  }
  // Submit
  const tfaSubmitBtn = page.locator(SELECTORS.tfaSubmit + ':not(.disabled):not([disabled])').last();
  try {
    await tfaSubmitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await tfaSubmitBtn.click();
  } catch {
    await tfaInputs.nth(5).press('Enter').catch(() => {});
  }
  return true;
}

/**
 * Логин с явными кредами (token + опциональный totpSecret).
 * Используется при многотенантной работе — каждый аккаунт со своими кредами.
 */
async function performLoginWith(page, token, totpSecret, accountId = '?') {
  console.log(`[${accountId}] login: filling token`);
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    const tokenInput = page.locator(SELECTORS.loginTokenInput).first();
    await tokenInput.waitFor({ state: 'visible', timeout: 10_000 });
    await tokenInput.fill(token);

    const tokenForm = tokenInput.locator('xpath=ancestor::*[.//button][1]');
    const submitBtn = (await tokenForm.count() > 0)
      ? tokenForm.locator(SELECTORS.loginTokenSubmit).first()
      : page.locator(SELECTORS.loginTokenSubmit).last();
    await submitBtn.click();

    const tfaInputs = page.locator(SELECTORS.tfaInputs);
    await tfaInputs.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    const cnt = await tfaInputs.count();

    if (cnt < 6) {
      // Возможно сразу залогинились без 2FA
      if (await page.locator(SELECTORS.loginSuccessIndicator).first().isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`[${accountId}] login: success without 2FA`);
        return true;
      }
      console.error(`[${accountId}] login: expected 6 tfa inputs, got ${cnt}`);
      return false;
    }

    // ===== 2FA в режиме реального времени =====
    // Стратегия: до 3 попыток. Перед каждой ждём начала свежего 30-сек окна
    // (даёт ~28+ сек на ввод и сабмит — гарантия что код не истечёт). Генерим код
    // СРАЗУ перед вводом, не заранее. Если сайт код отверг — ждём следующее окно
    // и пробуем со свежим кодом.

    if (!totpSecret) {
      // Fallback на Telegram (для аккаунтов без TOTP-секрета)
      console.log(`[${accountId}] login: requesting 2FA code via Telegram`);
      await botFetch('/bot/2fa-request', { method: 'POST', body: JSON.stringify({}) });
      const code = await pollForTfaCode();
      if (!code) {
        console.error(`[${accountId}] login: 2FA code timeout`);
        return false;
      }
      const ok = await fillAndSubmitTfa(page, tfaInputs, code, accountId);
      if (!ok) return false;
      await page.locator(SELECTORS.loginSuccessIndicator).first().waitFor({ timeout: 15_000 });
      console.log(`[${accountId}] login: success`);
      return true;
    }

    // TOTP-режим с ретраями
    const MAX_TFA_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_TFA_ATTEMPTS; attempt++) {
      // Ждём начала свежего окна. Если до конца текущего < 25 сек — ждём (даём себе
      // максимум времени). Если только что начали — стартуем сразу.
      const now = Math.floor(Date.now() / 1000);
      const remaining = 30 - (now % 30);
      if (remaining < 25) {
        console.log(`[${accountId}] login: TOTP attempt ${attempt}/${MAX_TFA_ATTEMPTS} — waiting ${remaining}s for fresh window`);
        await new Promise(r => setTimeout(r, (remaining + 0.3) * 1000));
      }

      // Генерим код прямо сейчас, на свежем окне
      const code = generateTotpCode(totpSecret);
      const genTs = Date.now();
      console.log(`[${accountId}] login: TOTP attempt ${attempt}/${MAX_TFA_ATTEMPTS} (code=${code[0]}****${code[5]}, fresh 30s window)`);

      const filled = await fillAndSubmitTfa(page, tfaInputs, code, accountId);
      if (!filled) {
        console.warn(`[${accountId}] login: attempt ${attempt} fill failed`);
        continue;
      }
      console.log(`[${accountId}] login: attempt ${attempt} — submitted, waiting for indicator (${Math.round((Date.now()-genTs)/1000)}s since gen)`);

      // Короткое ожидание индикатора успеха. Если сайт примет код — увидим dashboard.
      // Если не примет — увидим ошибку или останемся на 2FA-форме.
      const success = await page.locator(SELECTORS.loginSuccessIndicator).first()
        .waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      if (success) {
        console.log(`[${accountId}] login: success on attempt ${attempt}`);
        return true;
      }

      // Не залогинило. Проверяем — мы всё ещё на 2FA-форме?
      const stillOnTfa = await tfaInputs.first().isVisible({ timeout: 1000 }).catch(() => false);
      if (!stillOnTfa) {
        console.error(`[${accountId}] login: not on tfa form but no success indicator either, giving up`);
        return false;
      }
      console.warn(`[${accountId}] login: attempt ${attempt} rejected by server, will retry on fresh window`);
    }
    console.error(`[${accountId}] login: all ${MAX_TFA_ATTEMPTS} TOTP attempts rejected`);
    return false;
  } catch (e) {
    console.error(`[${accountId}] performLoginWith error:`, e.message);
    return false;
  }
}

async function performLogin(page) {
  console.log('attempting interactive login (token + 2FA via Telegram)');
  try {
    // Подождать что страница вообще что-то отрендерила (SPA нужно время)
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    console.log(`page URL: ${page.url()}`);
    console.log(`page title: ${await page.title().catch(() => '?')}`);
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    console.log(`body preview (300 chars): "${bodyText.slice(0, 300).replace(/\s+/g, ' ').trim()}"`);
    // Подсчитать input'ы на странице
    const inputCount = await page.locator('input').count().catch(() => 0);
    console.log(`total <input> elements on page: ${inputCount}`);
    if (inputCount > 0) {
      for (let i = 0; i < Math.min(inputCount, 5); i++) {
        const inp = page.locator('input').nth(i);
        const placeholder = await inp.getAttribute('placeholder').catch(() => '');
        const type = await inp.getAttribute('type').catch(() => '');
        const name = await inp.getAttribute('name').catch(() => '');
        console.log(`  input[${i}]: type="${type}" name="${name}" placeholder="${placeholder}"`);
      }
    }

    // Найти поле ввода токена
    const tokenInput = page.locator(SELECTORS.loginTokenInput).first();
    await tokenInput.waitFor({ state: 'visible', timeout: 10_000 });
    await tokenInput.fill(LOGIN_TOKEN);
    console.log('token entered');

    // Submit — кнопка ВНУТРИ того же контейнера где token-input.
    // Vue-приложения часто не используют <form>, так что ищем общий ancestor.
    const tokenForm = tokenInput.locator('xpath=ancestor::*[.//button][1]');
    const tokenFormCount = await tokenForm.count();
    let submitBtn;
    if (tokenFormCount > 0) {
      submitBtn = tokenForm.locator(SELECTORS.loginTokenSubmit).first();
      console.log(`found token-form ancestor, using its button`);
    } else {
      submitBtn = page.locator(SELECTORS.loginTokenSubmit).last();
      console.log(`no token-form ancestor, using last "Login" button on page`);
    }
    await submitBtn.click();
    console.log('token submitted, waiting for 2FA form');

    // Диагностика после клика — что произошло на странице
    await page.waitForTimeout(2500);
    console.log(`after click — URL: ${page.url()}`);
    const bodyAfter = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    console.log(`after click — body (300 chars): "${bodyAfter.slice(0, 300).replace(/\s+/g, ' ').trim()}"`);
    const tfaCountAfter = await page.locator(SELECTORS.tfaInputs).count().catch(() => 0);
    console.log(`after click — tfa inputs count: ${tfaCountAfter}`);
    // Проверим нет ли error-сообщения
    const errMsg = await page.locator('.error, .repay-error, [class*="error"]').first().innerText({ timeout: 1000 }).catch(() => '');
    if (errMsg) console.log(`ERROR on page: "${errMsg.slice(0, 200)}"`);

    // Ждём появления 2FA формы (6 input'ов)
    const tfaInputs = page.locator(SELECTORS.tfaInputs);
    await tfaInputs.first().waitFor({ state: 'visible', timeout: 15_000 });
    const cnt = await tfaInputs.count();
    if (cnt < 6) {
      // Возможно сразу залогинились (без 2FA). Проверим.
      if (await page.locator(SELECTORS.loginSuccessIndicator).first().isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('logged in without 2FA');
        return true;
      }
      console.error(`expected 6 tfa inputs, got ${cnt}`);
      return false;
    }
    console.log('2FA form detected');

    let code;
    if (TOTP_SECRET) {
      // Генерим код сами через TOTP. Если до конца окна (30 сек) осталось <3с —
      // ждём следующего, чтобы код не успел истечь между набором и сабмитом.
      const now = Math.floor(Date.now() / 1000);
      const remaining = 30 - (now % 30);
      if (remaining < 3) {
        console.log(`TOTP: ${remaining}s left in window, waiting for next`);
        await new Promise(r => setTimeout(r, (remaining + 1) * 1000));
      }
      code = generateTotpCode(TOTP_SECRET);
      console.log(`TOTP: auto-generated code (${30 - (Math.floor(Date.now()/1000) % 30)}s valid)`);
    } else {
      console.log('TOTP_SECRET not set, requesting code from user via Telegram');
      await botFetch('/bot/2fa-request', { method: 'POST', body: JSON.stringify({}) });
      code = await pollForTfaCode();
      if (!code) {
        console.error('2FA code timeout — user did not respond');
        return false;
      }
      console.log(`got 2FA code from user`);
    }

    // Заполняем 6 input'ов по одной цифре
    for (let i = 0; i < 6; i++) {
      const digit = code[i];
      if (!digit) break;
      await tfaInputs.nth(i).fill(digit);
    }
    console.log('2FA digits entered');

    // Кнопка "Войти" 2FA — найдём ту что НЕ disabled (та, что для 2FA, не для токена)
    const tfaSubmitBtn = page.locator(SELECTORS.tfaSubmit + ':not(.disabled):not([disabled])').last();
    try {
      await tfaSubmitBtn.waitFor({ state: 'visible', timeout: 5000 });
      await tfaSubmitBtn.click();
      console.log('2FA submit clicked');
    } catch {
      // Fallback: жмём Enter на последнем input
      await tfaInputs.nth(5).press('Enter');
    }

    // Ждём успешного логина
    await page.locator(SELECTORS.loginSuccessIndicator).first().waitFor({ timeout: 15_000 });
    console.log('login successful');
    return true;
  } catch (e) {
    console.error('performLogin failed:', e.message);
    return false;
  }
}

async function pollForTfaCode() {
  const start = Date.now();
  while (Date.now() - start < TFA_POLL_TIMEOUT_MS) {
    try {
      const r = await botFetch('/bot/2fa-code');
      if (r.status === 200) {
        const data = await r.json();
        if (data && data.code) return String(data.code);
      }
      if (r.status === 408) {
        console.warn('server reported 2FA timeout');
        return null;
      }
    } catch (e) {
      console.error('pollForTfaCode error:', e.message);
    }
    await new Promise(r => setTimeout(r, TFA_POLL_INTERVAL_MS));
  }
  return null;
}

// Активные статусы — это всё что НЕ в этом списке. Кнопка "Подтвердить" есть
// даже у завершённых/отклонённых сделок (rocket.do так устроен), поэтому фильтр
// именно negative по статусу.
const INACTIVE_STATUS_SUBSTRINGS = [
  'отклон',     // "Сделка отклонена"
  'заверш',     // "Завершенная сделка"
  'отмен',      // "Сделка отменена"
  'истёк',      // "Истёк"
  'истек',
  'expired',
  'completed',
  'rejected',
  'cancelled',
];

function isStatusActive(statusText) {
  if (!statusText) return true;  // нет статуса — считаем активной
  const lower = statusText.toLowerCase();
  return !INACTIVE_STATUS_SUBSTRINGS.some(s => lower.includes(s));
}

async function findMatchingRows(page, amount, cardNumber = null) {
  // amount из job может прийти строкой (BIGINT в pg) — приводим к числу
  const targetAmount = Number(amount);
  // Карту нормализуем — только цифры
  const targetCard = cardNumber ? String(cardNumber).replace(/\D/g, '') : null;
  const rows = page.locator(SELECTORS.rowSelector);
  const count = await rows.count();
  const matches = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const statusText = await row.locator(SELECTORS.rowStatusText).innerText().catch(() => '');
    if (!isStatusActive(statusText)) continue;

    const localText = await row.locator(SELECTORS.rowAmountLocal).innerText().catch(() => '');
    const rowAmount = parseLocalAmount(localText);
    if (rowAmount !== targetAmount) continue;

    // Если задан целевой реквизит — проверяем совпадение
    if (targetCard) {
      const cardText = await row.locator(SELECTORS.rowCardNumber).innerText().catch(() => '');
      const rowCard = String(cardText).replace(/\D/g, '');
      if (rowCard !== targetCard) {
        console.log(`  amount=${rowAmount} match but card mismatch: row="${rowCard}" target="${targetCard}"`);
        continue;
      }
    }

    const timeText = await row.locator(SELECTORS.rowTimeText).innerText().catch(() => '');
    const rowTimeMs = parseRussianDate(timeText);
    matches.push({ index: i, row, rowTimeMs, localText, timeText, statusText });
  }
  return matches;
}

function pickClosest(matches, requestedAtMs) {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Несколько с одинаковой суммой — выбираем ближайший по времени
  let best = null, bestDelta = Infinity;
  for (const m of matches) {
    if (m.rowTimeMs == null) continue;
    const d = Math.abs(m.rowTimeMs - requestedAtMs);
    if (d < bestDelta) { best = m; bestDelta = d; }
  }
  if (!best) return matches[0];  // ни одно время не парсилось — берём первое
  if (bestDelta > MATCH_WINDOW_MS) return null;
  return best;
}

/**
 * Перезагружает страницу со списком сделок.
 * ctxEntry — { context, page, lastReloadAt } для конкретного аккаунта.
 * Если force=true — обновляет немедленно. Иначе соблюдает RELOAD_MIN_INTERVAL_MS.
 */
async function reloadWithRateLimit(ctxEntry, force = false) {
  const page = ctxEntry.page;
  const now = Date.now();
  const sinceReload = now - (ctxEntry.lastReloadAt || 0);
  if (!force && sinceReload < RELOAD_MIN_INTERVAL_MS && ctxEntry.lastReloadAt > 0) {
    const waitMs = RELOAD_MIN_INTERVAL_MS - sinceReload;
    console.log(`rate-limit: waiting ${Math.round(waitMs/1000)}s before next reload`);
    await page.waitForTimeout(waitMs);
  }
  try {
    await page.goto(REQUESTS_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SELECTORS.rowSelector, { timeout: 10_000 }).catch(() => {});
    ctxEntry.lastReloadAt = Date.now();
    console.log(`page reloaded${force ? ' (forced)' : ''}`);
    return true;
  } catch (e) {
    console.error('reload failed:', e.message);
    return false;
  }
}

/**
 * Фоновый скан страницы — раз в SITE_SCAN_INTERVAL_MS перезагружаем (с rate-limit)
 * и уведомляем о новых сделках + изменениях статуса (например ушла в отмену).
 */
async function scanForNewDeals(page, accountIdOrCtx) {
  // Поддержка обоих сигнатур: либо передали ctxEntry, либо page+accountId
  let ctxEntry, accountId;
  if (accountIdOrCtx && typeof accountIdOrCtx === 'object' && accountIdOrCtx.page) {
    ctxEntry = accountIdOrCtx;
    accountId = ctxEntry.accountId || 'default';
  } else {
    accountId = accountIdOrCtx || 'default';
    // Найдём ctxEntry по странице (для legacy single-tenant вызова)
    ctxEntry = { page, lastReloadAt: 0 };
    for (const [aid, e] of accountContexts) {
      if (e.page === page) { ctxEntry = e; accountId = aid; break; }
    }
  }
  console.log(`[${accountId}] background scan: checking deals`);
  await reloadWithRateLimit(ctxEntry);

  const scanPage = ctxEntry.page;
  const rows = scanPage.locator(SELECTORS.rowSelector);
  const count = await rows.count().catch(() => 0);

  const currentKeys = new Set();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const status = await row.locator(SELECTORS.rowStatusText).innerText().catch(() => '');
    const amount = await row.locator(SELECTORS.rowAmountLocal).innerText().catch(() => '');
    const time = await row.locator(SELECTORS.rowTimeText).innerText().catch(() => '');
    if (!time || !amount) continue;
    const key = `${accountId}|${time}|${amount}`;
    currentKeys.add(key);
    const parsedAmount = parseLocalAmount(amount);
    const prev = SEEN_DEALS.get(key);

    if (!prev) {
      if (isStatusActive(status)) {
        console.log(`[${accountId}] new active deal: ${amount} ${status} ${time}`);
        notify('new_deal', {
          accountId,
          amount: parsedAmount,
          message: `${status} • ${time}`,
        });
      }
    } else if (prev.status !== status) {
      if (!isStatusActive(status) && isStatusActive(prev.status)) {
        console.log(`[${accountId}] deal status changed: ${amount} ${prev.status} → ${status}`);
        notify('declined', {
          accountId,
          amount: parsedAmount,
          message: `Было: "${prev.status}" → стало: "${status}" • ${time}`,
        });
      }
    }
    SEEN_DEALS.set(key, { status, parsedAmount });
  }

  // Ограничиваем размер карты — выбрасываем самые старые если > 500
  if (SEEN_DEALS.size > 500) {
    const keys = Array.from(SEEN_DEALS.keys());
    for (let i = 0; i < 200; i++) SEEN_DEALS.delete(keys[i]);
  }
}

/**
 * Закрывает открытый модал (если есть). Вызывается перед каждой новой попыткой
 * подтверждения чтобы не было перехвата кликов остатком прошлой сессии.
 */
async function dismissAnyModal(page) {
  try {
    const modal = page.locator('.repay-modal-wrapper, #modal > div').first();
    const visible = await modal.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) return;

    console.log('open modal detected, closing');
    // 1) Кнопка "Отмена" в самом модале
    const cancelBtn = page.locator('button:has-text("Отмена")').first();
    if (await cancelBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await cancelBtn.click({ force: true, timeout: 1500 }).catch(() => {});
      console.log('modal: clicked Отмена');
    } else {
      // 2) Escape
      await page.keyboard.press('Escape');
      console.log('modal: pressed Escape');
    }
    await page.waitForTimeout(500);
    // 3) Если всё ещё открыт — клик в пустую область
    if (await modal.isVisible({ timeout: 500 }).catch(() => false)) {
      await page.mouse.click(10, 10).catch(() => {});
      await page.waitForTimeout(300);
    }
  } catch (e) {
    console.warn('dismissAnyModal error:', e.message);
  }
}

async function searchOnPage(page, job, requestedAtMs) {
  const matches = await findMatchingRows(page, job.amount, job.card_number);
  if (matches.length === 0) return null;
  return pickClosest(matches, requestedAtMs);
}

async function tryConfirm(ctxEntry, job) {
  if (MOCK_SITE) {
    console.log(`[MOCK] would confirm amount=${job.amount} requested_at=${job.requested_at}`);
    await new Promise(r => setTimeout(r, 500));
    return { ok: true };
  }

  const page = ctxEntry.page;
  // Закрываем зависший модал от прошлой попытки (если есть)
  await dismissAnyModal(page);

  const requestedAtMs = new Date(job.requested_at).getTime();

  // 1. Сначала пробуем найти на ТЕКУЩЕЙ странице без reload (вдруг строка уже есть)
  let target = await searchOnPage(page, job, requestedAtMs).catch(() => null);

  // 2. Если не нашли — обновляем страницу СРАЗУ (force, без rate-limit) и ищем снова,
  //    с короткими retry'ями (заявка может появиться через секунду-две после пуша).
  if (!target) {
    await reloadWithRateLimit(ctxEntry, true);
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      target = await searchOnPage(page, job, requestedAtMs).catch(() => null);
      if (target) break;
      await page.waitForTimeout(RETRY_DELAY_MS);
    }
  }

  if (!target) {
    // Диагностика: выводим что бот реально видит на странице
    let totalRows = 0;
    try {
      const allRows = page.locator(SELECTORS.rowSelector);
      totalRows = await allRows.count();
      console.log(`DEBUG: ${totalRows} rows visible on page:`);
      for (let i = 0; i < Math.min(totalRows, 15); i++) {
        const row = allRows.nth(i);
        const status = await row.locator(SELECTORS.rowStatusText).innerText().catch(() => '?');
        const amt = await row.locator(SELECTORS.rowAmountLocal).innerText().catch(() => '?');
        const time = await row.locator(SELECTORS.rowTimeText).innerText().catch(() => '?');
        const device = await row.locator('td:nth-child(4) .td-cell-main').innerText().catch(() => '?');
        const parsed = parseLocalAmount(amt);
        const active = isStatusActive(status);
        console.log(`  row[${i}]: status="${status}" amount="${amt}"→${parsed} time="${time}" device="${device}" active=${active}`);
      }
    } catch (e) {
      console.error('debug dump failed:', e.message);
    }

    // Скриншот для визуальной отладки
    await captureScreenshot(
      page,
      `❌ amount=${job.amount}: не найдена строка (видно ${totalRows} строк всего)`,
      job.account_id
    );

    notify('failed', {
      accountId: job.account_id,
      amount: job.amount,
      reason: `Не нашёл строку с суммой ${job.amount} в окне ±10 мин`,
    });
    return { ok: false, reason: `no row with amount=${job.amount} after reload` };
  }

  // Уведомление: сделка найдена
  notify('found', {
    accountId: job.account_id,
    amount: job.amount,
    message: `Время на сайте: ${target.timeText}`,
  });

  console.log(`match: amount=${job.amount} time="${target.timeText}" delta=${target.rowTimeMs ? (target.rowTimeMs - requestedAtMs) : '?'}ms`);
  try {
    const btn = target.row.locator(SELECTORS.rowConfirmBtn).first();
    // Скроллим строку в видимую область (на случай если таблица имеет overflow)
    await target.row.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

    const btnCount = await btn.count();
    const visible = btnCount > 0 ? await btn.isVisible().catch(() => false) : false;
    console.log(`confirm button: count=${btnCount} visible=${visible}`);
    if (btnCount === 0) {
      return { ok: false, reason: 'confirm button not found in row' };
    }

    // Перед кликом — закрыть зависший модал если есть
    await dismissAnyModal(page);

    if (!visible) {
      console.warn('confirm button reported as not visible, trying force click');
      await btn.click({ force: true, timeout: 5000 });
    } else {
      // Force click чтобы обойти возможные оверлеи (типа модала-предка)
      await btn.click({ force: true, timeout: 5000 });
    }
    console.log('clicked "Подтвердить поступление"');

    // Появляется диалог: "Вы уверены, что получили N ars... Я получил всю сумму сделки [✓] | Да, подтвердить"
    const checkboxContainer = page.locator(SELECTORS.dialogCheckbox).first();
    try {
      await checkboxContainer.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      return { ok: false, reason: 'confirmation dialog did not appear' };
    }

    // Активация галочки. Пробуем несколько способов, после КАЖДОГО проверяем что
    // кнопка "Да, подтвердить" стала enabled. Если да — успех. Если нет — следующий метод.
    const isConfirmEnabled = async () => {
      const yesBtn = page.locator(SELECTORS.dialogConfirmBtn).first();
      return !(await yesBtn.isDisabled().catch(() => true));
    };

    let dialogReady = false;

    // 1. Нативный клик через JS — самый надёжный для Vue-компонентов
    try {
      await page.evaluate(() => {
        const cb = document.querySelector('input.repay-checkbox__input');
        if (cb) cb.click();
      });
      await page.waitForTimeout(300);
      if (await isConfirmEnabled()) { console.log('checkbox: native cb.click() worked'); dialogReady = true; }
    } catch {}

    // 2. Клик по контейнеру через Playwright (force)
    if (!dialogReady) {
      try {
        await checkboxContainer.click({ force: true, timeout: 1500 });
        await page.waitForTimeout(300);
        if (await isConfirmEnabled()) { console.log('checkbox: container click worked'); dialogReady = true; }
      } catch {}
    }

    // 3. Клик по самому input force
    if (!dialogReady) {
      try {
        const cb = page.locator(SELECTORS.dialogCheckboxInput).first();
        await cb.click({ force: true, timeout: 1500 });
        await page.waitForTimeout(300);
        if (await isConfirmEnabled()) { console.log('checkbox: input force click worked'); dialogReady = true; }
      } catch {}
    }

    // 4. Клик по label
    if (!dialogReady) {
      try {
        const lbl = page.locator(SELECTORS.dialogCheckboxLabel).first();
        await lbl.click({ force: true, timeout: 1500 });
        await page.waitForTimeout(300);
        if (await isConfirmEnabled()) { console.log('checkbox: label click worked'); dialogReady = true; }
      } catch {}
    }

    // 5. JS-фолбэк: явный set checked + dispatch
    if (!dialogReady) {
      try {
        await page.evaluate(() => {
          const cb = document.querySelector('input.repay-checkbox__input');
          if (!cb) return;
          cb.checked = true;
          cb.dispatchEvent(new Event('input', { bubbles: true }));
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(300);
        if (await isConfirmEnabled()) { console.log('checkbox: JS set+dispatch worked'); dialogReady = true; }
      } catch {}
    }

    if (!dialogReady) {
      console.warn('checkbox: ALL 5 methods failed to enable confirm button');
      await captureScreenshot(page, '❌ Галочка не активировала кнопку', job.account_id);
      await dismissAnyModal(page);
      return { ok: false, reason: 'checkbox click did not enable confirm button' };
    }

    // Кнопка "Да, подтвердить" уже enabled после успешной активации галочки
    const yesBtn = page.locator(SELECTORS.dialogConfirmBtn).first();
    await yesBtn.click({ timeout: 5000 });
    console.log('clicked "Да, подтвердить"');

    // Дождаться закрытия диалога / смены состояния строки
    await page.waitForTimeout(1500);
    notify('confirmed', { accountId: job.account_id, amount: job.amount });
    return { ok: true };
  } catch (e) {
    notify('failed', {
      accountId: job.account_id,
      amount: job.amount,
      reason: e.message,
    });
    await dismissAnyModal(page);  // закрываем зависший модал
    return { ok: false, reason: 'click failed: ' + e.message };
  }
}

async function main() {
  console.log(`Bot starting. SERVER=${SERVER_URL} REQUESTS=${REQUESTS_URL} HEADLESS=${HEADLESS} MOCK=${MOCK_SITE}`);
  startHeartbeat();

  let browser;
  if (!MOCK_SITE) {
    browser = await chromium.launch({ headless: HEADLESS });
    setInterval(() => cleanupIdleContexts().catch(e => console.error('cleanup error:', e.message)),
                ACCOUNT_CLEANUP_INTERVAL_MS);
  }

  while (true) {
    let job = null;
    try { job = await fetchNext(); }
    catch (e) { console.error('fetchNext error:', e.message); }
    if (!job) {
      // Idle: раз в SITE_SCAN_INTERVAL_MS — фоновый скан для всех загруженных аккаунтов
      try { await scanAllAccountsForNewDeals(); }
      catch (e) { console.error('scanAll error:', e.message); }
      await sleep(POLL_IDLE_MS);
      continue;
    }

    console.log(`picked job #${job.id} kind=${job.kind || 'confirm'} account=${job.account_id} source=${job.source} amount=${job.amount} card=${job.card_number || '—'}`);
    let result;
    try {
      if (job.kind === 'warmup') {
        // Warmup: просто создать/получить контекст (это вызовет login + сохранит storage_state).
        if (MOCK_SITE) {
          result = { ok: true, reason: 'mock: warmup skipped' };
        } else {
          const ctxEntry = await getAccountContext(browser, job.account_id);
          await saveAccountStorage(job.account_id, ctxEntry.context);
          result = { ok: true };
          console.log(`[${job.account_id}] warmup complete — session saved`);
        }
      } else {
        const ctxEntry = MOCK_SITE
          ? { context: null, page: null, lastReloadAt: 0 }
          : await getAccountContext(browser, job.account_id);
        result = await tryConfirm(ctxEntry, job);
        // После успешной обработки — сохраняем сессию в БД (могла обновиться)
        if (result.ok && !MOCK_SITE) {
          await saveAccountStorage(job.account_id, ctxEntry.context);
        }
      }
    } catch (e) {
      result = { ok: false, reason: e.message };
      console.error(`job #${job.id} crashed:`, e.message);
    }
    await reportDone(job.id, result.ok, result.ok ? null : result.reason);
    console.log(`job #${job.id} → ${result.ok ? 'DONE' : 'FAILED'}: ${result.reason || ''}`);
  }
}

// Фоновый скан всех загруженных контекстов на новые/изменённые сделки
async function scanAllAccountsForNewDeals() {
  if (Date.now() - lastSiteScanAt < SITE_SCAN_INTERVAL_MS) return;
  lastSiteScanAt = Date.now();
  for (const [accountId, entry] of accountContexts) {
    try {
      await scanForNewDeals(entry.page, accountId);
    } catch (e) {
      console.error(`[${accountId}] scan error:`, e.message);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(e => { console.error('fatal:', e); process.exit(1); });
