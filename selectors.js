// CSS-селекторы для DOM dashboard'а https://rocket.do/deals-list
//
// Структура строки (из реального HTML):
//   <tr class="repay-table__data-row">
//     <td>...иконка + Статус + Время...</td>     ← cell #1: .td-cell-main = статус, .td-cell-info = время
//     <td>...USDT-сумма / локальная сумма...</td> ← cell #2: .td-cell-main = USDT, .td-cell-info = "5 000 ars"
//     <td>...карта...</td>
//     <td>...устройство...</td>
//     <td>(пусто)</td>
//     <td><button>Подтвердить поступление</button></td>  ← cell #6
//
// Сайт использует Vue 3 + scoped style (data-v-... атрибуты), но классы стабильные.

export const SELECTORS = {
  rowSelector:        'tr.repay-table__data-row',

  // Внутри строки — относительные селекторы
  rowStatusText:      'td:nth-child(1) .td-cell-main',     // "Сделка в обработке" / "Сделка отклонена" / "Завершенная сделка"
  rowTimeText:        'td:nth-child(1) .td-cell-info',     // "28 апреля 2026 г. в 03:18"
  rowAmountUsdt:      'td:nth-child(2) .td-cell-main',     // "3.32 USDT"
  rowAmountLocal:     'td:nth-child(2) .td-cell-info',     // "5 000 ars"
  rowCardNumber:      'td:nth-child(3) .td-cell-main',     // "0000154600000000177456"

  // "Подтвердить поступление" — полный вариант. Иногда бывает просто "Подтвердить".
  rowConfirmBtn:      'button:has-text("Подтвердить")',

  // Конкретные селекторы из HTML rocket.do:
  // <div class="repay-checkbox"><input class="repay-checkbox__input"><label>...</label></div>
  dialogCheckbox:      '.repay-checkbox',                    // кликабельный контейнер
  dialogCheckboxInput: 'input.repay-checkbox__input',         // сам input
  dialogCheckboxLabel: 'label:has-text("Я получил всю сумму")',  // запасной (для проверки появления диалога)
  dialogConfirmBtn:    'button:has-text("Да, подтвердить")',
  dialogCancelBtn:     'button:has-text("Отмена")',

  loginSuccessIndicator: 'a[href*="/deals-list"], a[href*="/profile"]',

  // Login форма (страница до /deals-list когда сессия истекла).
  // На rocket.do две формы: trader (email+password) и agent (token). Используем agent.
  loginTokenInput:    'input[placeholder="Секретный токен"], input[placeholder="Secret token"]',
  loginTokenSubmit:   'button.repay-button:has-text("Войти"), button.repay-button:has-text("Login")',
  // 2FA форма после submit токена (6 отдельных input по 1 цифре)
  tfaInputs:          'input.tfa-input__input',
  tfaSubmit:          'button.repay-button:has-text("Войти"), button.repay-button:has-text("Login")',
};

/**
 * Парсит "5 000 ars" / "5000.50 ars" / "5 500 ars" / "5000.5" → 5000 / 5000 / 5500 / 5000.
 * Дробную часть (1-2 цифры после . или ,) отбрасывает.
 */
export function parseLocalAmount(text) {
  if (!text) return null;
  // Убираем все пробельные символы (обычные, NBSP  , табы и т.д.)
  const cleaned = String(text).replace(/\s+/g, '').replace(/ /g, '');
  const m = cleaned.match(/(\d[\d.,]*)/);
  if (!m) return null;
  const raw = m[1];
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  const lastSep = Math.max(lastDot, lastComma);
  let intPart = raw;
  if (lastSep >= 0) {
    const afterSep = raw.substring(lastSep + 1);
    if (afterSep.length >= 1 && afterSep.length <= 2 && /^\d+$/.test(afterSep)) {
      intPart = raw.substring(0, lastSep);
    }
  }
  const digits = intPart.replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

const RU_MONTHS = {
  'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
  'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
};

/**
 * Парсит "28 апреля 2026 г. в 03:18" → timestamp в МСК.
 */
export function parseRussianDate(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})\s+([А-Яа-яё]+)\s+(\d{4})\D+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, day, monthName, year, hour, minute] = m;
  const month = RU_MONTHS[monthName.toLowerCase()];
  if (month === undefined) return null;
  // Сайт показывает время в МСК (UTC+3). Используем UTC и сдвигаем.
  const ts = Date.UTC(+year, month, +day, +hour - 3, +minute, 0);
  return Number.isFinite(ts) ? ts : null;
}
