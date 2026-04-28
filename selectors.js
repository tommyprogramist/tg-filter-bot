// CSS-селекторы для DOM dashboard'а https://rocket.do/deals-list
//
// Структура строки (из реального HTML, см. README):
//   <tr class="repay-table__data-row">
//     <td>...иконка + Статус + Время...</td>     ← cell #1: .td-cell-main = статус, .td-cell-info = время
//     <td>...USDT-сумма / локальная сумма...</td> ← cell #2: .td-cell-main = USDT, .td-cell-info = "5 000 ars"
//     <td>...карта...</td>
//     <td>...устройство...</td>
//     <td>(пусто)</td>
//     <td><button>Подтвердить поступление</button></td>  ← cell #6: кнопка confirm
//
// Сайт использует Vue 3 + scoped style (data-v-... атрибуты), но классы стабильные.

export const SELECTORS = {
  // Список заявок (rocket.do)
  rowSelector:        'tr.repay-table__data-row',

  // Внутри строки — относительные селекторы
  rowStatusText:      'td:nth-child(1) .td-cell-main',     // "Сделка отклонена" / "Завершенная сделка"
  rowTimeText:        'td:nth-child(1) .td-cell-info',     // "28 апреля 2026 г. в 03:18"
  rowAmountUsdt:      'td:nth-child(2) .td-cell-main',     // "3.32 USDT"
  rowAmountLocal:     'td:nth-child(2) .td-cell-info',     // "5 000 ars" — это совпадает с SMS

  // Кнопка подтверждения внутри строки. Ищем по тексту: button containing "Подтвердить поступление"
  rowConfirmBtn:      'button:has-text("Подтвердить поступление")',

  // Диалог подтверждения "Вы уверены, что получили N ars на реквизит ..."
  // Нужно нажать галочку "Я получил всю сумму сделки", потом "Да, подтвердить"
  dialogCheckboxLabel: 'label:has-text("Я получил всю сумму"), :text("Я получил всю сумму сделки")',
  dialogConfirmBtn:    'button:has-text("Да, подтвердить")',
  dialogCancelBtn:     'button:has-text("Отмена")',

  // Индикатор что мы залогинены (видно меню)
  loginSuccessIndicator: 'a[href*="/deals-list"], a[href*="/profile"]',

  // Login форма (страница до /deals-list когда сессия истекла)
  loginTokenInput:    'input[placeholder="Секретный токен"]',
  loginTokenSubmit:   'button.repay-button.repay-button--primary:has-text("Войти")',
  // 2FA форма после submit токена (6 отдельных input по 1 цифре)
  tfaInputs:          'input.tfa-input__input',
  tfaSubmit:          'button.repay-button.repay-button--primary:has-text("Войти")',
};

/**
 * Парсит "5 000 ars" / "5000 ars" / "5 500 ars" → 5000 / 5500.
 * Игнорирует пробелы (включая &nbsp;) и валюту.
 */
export function parseLocalAmount(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[ \s]/g, '');
  const m = cleaned.match(/(\d[\d.,]*)/);
  if (!m) return null;
  const digits = m[1].replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

const RU_MONTHS = {
  'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
  'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
};

/**
 * Парсит "28 апреля 2026 г. в 03:18" → timestamp в МСК.
 * Возвращает null если не получается.
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
