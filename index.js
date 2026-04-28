// Bot-оператор для авто-подтверждения сделок на https://rocket.do/deals-list
// Цикл: poll очередь на сервере → найти на сайте сделку с такой суммой и временем
// → нажать «Подтвердить поступление» → отчитаться серверу.

import { existsSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-chromium';
import { SELECTORS, parseLocalAmount, parseRussianDate } from './selectors.js';

const SERVER_URL    = process.env.SERVER_URL    || 'http://localhost:3000';
const BOT_API_KEY   = process.env.BOT_API_KEY   || '';
const REQUESTS_URL  = process.env.ROCKET_REQUESTS_URL || 'https://rocket.do/deals-list';
const LOGIN_TOKEN   = process.env.LOGIN_TOKEN   || '';
const HEADLESS      = process.env.HEADLESS !== 'false';
const STORAGE_PATH  = process.env.STORAGE_PATH || './storage_state.json';
const MOCK_SITE     = process.env.MOCK_SITE === 'true';
const TFA_POLL_TIMEOUT_MS = 5 * 60 * 1000;  // 5 минут на ввод 2FA пользователем
const TFA_POLL_INTERVAL_MS = 2000;
const SITE_SCAN_INTERVAL_MS = 60 * 1000;  // фоновый скан списка сделок каждую минуту

let lastSiteScanAt = 0;
const SEEN_DEALS = new Map();  // key "time|amount" → { status, parsedAmount }
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

// На Railway сессия передаётся через ENV. При старте декодируем и пишем в файл.
const SSB = process.env.STORAGE_STATE_BASE64 || '';
console.log(`STORAGE_STATE_BASE64 env length: ${SSB.length} chars` +
            (SSB.length > 0 ? `, starts with "${SSB.slice(0, 8)}..."` : ' (empty/unset)'));
console.log(`storage_state.json file exists: ${existsSync(STORAGE_PATH)}`);

if (SSB && !existsSync(STORAGE_PATH)) {
  try {
    const decoded = Buffer.from(SSB, 'base64').toString('utf-8');
    writeFileSync(STORAGE_PATH, decoded);
    console.log(`storage_state restored from STORAGE_STATE_BASE64 (${decoded.length} chars decoded)`);
  } catch (e) {
    console.error('failed to decode STORAGE_STATE_BASE64:', e.message);
  }
}

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

function startHeartbeat() {
  setInterval(() => {
    botFetch('/bot/heartbeat', { method: 'POST', body: JSON.stringify({}) })
      .catch(e => console.error('heartbeat failed:', e.message));
  }, 10_000);
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
    console.log('2FA form detected, requesting code from user via Telegram');

    // Запрашиваем код у пользователя через сервер
    await botFetch('/bot/2fa-request', { method: 'POST', body: JSON.stringify({}) });
    const code = await pollForTfaCode();
    if (!code) {
      console.error('2FA code timeout — user did not respond');
      return false;
    }
    console.log(`got 2FA code from user`);

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

async function findMatchingRows(page, amount) {
  const rows = page.locator(SELECTORS.rowSelector);
  const count = await rows.count();
  const matches = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const statusText = await row.locator(SELECTORS.rowStatusText).innerText().catch(() => '');
    // Пропускаем только завершённые/отклонённые
    if (!isStatusActive(statusText)) continue;

    const localText = await row.locator(SELECTORS.rowAmountLocal).innerText().catch(() => '');
    const rowAmount = parseLocalAmount(localText);
    if (rowAmount === amount) {
      const timeText = await row.locator(SELECTORS.rowTimeText).innerText().catch(() => '');
      const rowTimeMs = parseRussianDate(timeText);
      matches.push({ index: i, row, rowTimeMs, localText, timeText, statusText });
    }
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
 * Перезагружает страницу со списком сделок, если с прошлого reload прошло >= 2 минут.
 * Если нет — ждёт оставшееся время. Гарантирует что после вызова страница свежая.
 */
async function reloadWithRateLimit(page) {
  const now = Date.now();
  const sinceReload = now - lastReloadAt;
  if (sinceReload < RELOAD_MIN_INTERVAL_MS && lastReloadAt > 0) {
    const waitMs = RELOAD_MIN_INTERVAL_MS - sinceReload;
    console.log(`rate-limit: waiting ${Math.round(waitMs/1000)}s before next reload`);
    await page.waitForTimeout(waitMs);
  }
  try {
    await page.goto(REQUESTS_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SELECTORS.rowSelector, { timeout: 10_000 }).catch(() => {});
    lastReloadAt = Date.now();
    console.log('page reloaded');
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
async function scanForNewDeals(page) {
  if (Date.now() - lastSiteScanAt < SITE_SCAN_INTERVAL_MS) return;
  console.log('background scan: checking for new/changed deals');
  await reloadWithRateLimit(page);
  lastSiteScanAt = Date.now();

  const rows = page.locator(SELECTORS.rowSelector);
  const count = await rows.count().catch(() => 0);

  const currentKeys = new Set();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const status = await row.locator(SELECTORS.rowStatusText).innerText().catch(() => '');
    const amount = await row.locator(SELECTORS.rowAmountLocal).innerText().catch(() => '');
    const time = await row.locator(SELECTORS.rowTimeText).innerText().catch(() => '');
    if (!time || !amount) continue;
    const key = `${time}|${amount}`;
    currentKeys.add(key);
    const parsedAmount = parseLocalAmount(amount);
    const prev = SEEN_DEALS.get(key);

    if (!prev) {
      // Новая сделка — уведомляем только если активная (отклонённые/завершённые
      // могли уже быть на странице на момент первого запуска бота)
      if (isStatusActive(status)) {
        console.log(`new active deal detected: ${amount} ${status} ${time}`);
        notify('new_deal', {
          amount: parsedAmount,
          message: `${status} • ${time}`,
        });
      }
    } else if (prev.status !== status) {
      // Статус изменился
      if (!isStatusActive(status) && isStatusActive(prev.status)) {
        console.log(`deal status changed (active→inactive): ${amount} ${prev.status} → ${status}`);
        notify('declined', {
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

async function searchOnPage(page, job, requestedAtMs) {
  const matches = await findMatchingRows(page, job.amount);
  if (matches.length === 0) return null;
  return pickClosest(matches, requestedAtMs);
}

async function tryConfirm(page, job) {
  if (MOCK_SITE) {
    console.log(`[MOCK] would confirm amount=${job.amount} requested_at=${job.requested_at}`);
    await new Promise(r => setTimeout(r, 500));
    return { ok: true };
  }

  const requestedAtMs = new Date(job.requested_at).getTime();

  // 1. Сначала пробуем найти на ТЕКУЩЕЙ странице без reload (вдруг строка уже есть)
  let target = await searchOnPage(page, job, requestedAtMs).catch(() => null);

  // 2. Если не нашли — обновляем страницу (с учётом rate-limit) и ищем снова,
  //    с короткими retry'ями (заявка может появиться через секунду-две после пуша).
  if (!target) {
    await reloadWithRateLimit(page);
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      target = await searchOnPage(page, job, requestedAtMs).catch(() => null);
      if (target) break;
      await page.waitForTimeout(RETRY_DELAY_MS);
    }
  }

  if (!target) {
    // Диагностика: выводим что бот реально видит на странице
    try {
      const allRows = page.locator(SELECTORS.rowSelector);
      const total = await allRows.count();
      console.log(`DEBUG: ${total} rows visible on page:`);
      for (let i = 0; i < Math.min(total, 15); i++) {
        const row = allRows.nth(i);
        const status = await row.locator(SELECTORS.rowStatusText).innerText().catch(() => '?');
        const amt = await row.locator(SELECTORS.rowAmountLocal).innerText().catch(() => '?');
        const time = await row.locator(SELECTORS.rowTimeText).innerText().catch(() => '?');
        const parsed = parseLocalAmount(amt);
        const active = isStatusActive(status);
        console.log(`  row[${i}]: status="${status}" amount="${amt}"→${parsed} time="${time}" active=${active}`);
      }
    } catch (e) {
      console.error('debug dump failed:', e.message);
    }

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
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) {
      return { ok: false, reason: 'confirm button not visible (already confirmed?)' };
    }
    await btn.click();
    console.log('clicked "Подтвердить поступление"');

    // Появляется диалог: "Вы уверены, что получили N ars... Я получил всю сумму сделки [✓] | Да, подтвердить"
    const checkboxLabel = page.locator(SELECTORS.dialogCheckboxLabel).first();
    try {
      await checkboxLabel.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      return { ok: false, reason: 'confirmation dialog did not appear' };
    }

    // Клик по тексту/label — это активирует галочку (стандартное поведение)
    try {
      await checkboxLabel.click();
      console.log('checkbox clicked');
    } catch (e) {
      // Если label сам не кликабелен — пробуем найти input checkbox рядом
      const cb = page.locator('input[type="checkbox"]').last();
      await cb.check({ force: true }).catch(() => {});
    }

    // Кнопка "Да, подтвердить" — ждём пока станет активной
    const yesBtn = page.locator(SELECTORS.dialogConfirmBtn).first();
    await yesBtn.waitFor({ state: 'visible', timeout: 3000 });
    // Подождать пока кнопка перестанет быть disabled
    for (let i = 0; i < 10; i++) {
      const disabled = await yesBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await page.waitForTimeout(200);
    }
    await yesBtn.click();
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
    return { ok: false, reason: 'click failed: ' + e.message };
  }
}

async function main() {
  console.log(`Bot starting. SERVER=${SERVER_URL} REQUESTS=${REQUESTS_URL} HEADLESS=${HEADLESS} MOCK=${MOCK_SITE}`);
  startHeartbeat();

  let browser, context, page;
  if (!MOCK_SITE) {
    browser = await chromium.launch({ headless: HEADLESS });
    const ctxOpts = existsSync(STORAGE_PATH) ? { storageState: STORAGE_PATH } : {};
    context = await browser.newContext(ctxOpts);
    page = await context.newPage();

    try {
      await page.goto(REQUESTS_URL, { waitUntil: 'domcontentloaded' });
      lastReloadAt = Date.now();
    } catch (e) {
      console.error('initial goto failed:', e.message);
    }

    const logged = await ensureLoggedIn(page);
    if (!logged) {
      console.error('FATAL: could not login (token or 2FA failed). Bot exits, container will restart and try again.');
      process.exit(1);
    }
    try {
      await context.storageState({ path: STORAGE_PATH });
      console.log('storage state saved to', STORAGE_PATH);
    } catch (e) { console.warn('save storage failed:', e.message); }
  }

  while (true) {
    let job = null;
    try { job = await fetchNext(); }
    catch (e) { console.error('fetchNext error:', e.message); }
    if (!job) {
      // В idle — раз в 5 минут сканируем страницу на новые/изменённые сделки
      try { await scanForNewDeals(page); }
      catch (e) { console.error('scanForNewDeals error:', e.message); }
      await sleep(POLL_IDLE_MS);
      continue;
    }

    console.log(`picked job #${job.id} source=${job.source} amount=${job.amount}`);
    let result;
    try {
      result = await tryConfirm(page, job);
    } catch (e) {
      result = { ok: false, reason: e.message };
      try { await page?.reload(); } catch {}
    }
    await reportDone(job.id, result.ok, result.ok ? null : result.reason);
    console.log(`job #${job.id} → ${result.ok ? 'DONE' : 'FAILED'}: ${result.reason || ''}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(e => { console.error('fatal:', e); process.exit(1); });
