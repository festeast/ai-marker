// Общий код всех страниц: подключение к Supabase и мелкие помощники.
// Подключается после supabase-js, config.js и i18n.js.
const CONFIG = window.AI_MARKER_CONFIG || {};
const CONFIGURED = CONFIG.supabaseUrl && !CONFIG.supabaseUrl.includes('YOUR-PROJECT');
const db = CONFIGURED ? supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey) : null;

function appError(code) {
  return Object.assign(new Error(t('err_' + code)), { code });
}

// Вызов функции из supabase/schema.sql. Ошибки функции приходят кодом
// (например, 'no_questions') и переводятся через i18n.
// timeoutMs — сколько ждать ответа; если связь зависла, запрос обрывается с ошибкой network.
async function rpc(fn, args = {}, timeoutMs) {
  if (!db) throw appError('not_configured');
  let query = db.rpc(fn, args);
  if (timeoutMs) query = query.abortSignal(AbortSignal.timeout(timeoutMs));
  const { data, error } = await query;
  if (error) {
    const msg = error.message || '';
    if (I18N.ru['err_' + msg]) throw appError(msg);
    if (/fetch|abort|timeout|network|load failed/i.test(msg)) throw appError('network');
    // Функции нет в базе: schema.sql не выполнен заново после обновления сайта.
    if (error.code === 'PGRST202' || msg.includes('Could not find the function')) throw appError('schema_outdated');
    // Неизвестная ошибка: показываем и текст от сервера, чтобы было понятно, что случилось.
    const err = appError('server_error');
    if (msg) err.message += ' (' + msg + ')';
    throw err;
  }
  return data;
}

// Вызов функции Supabase (supabase/functions/<name>). Ошибки — те же коды.
async function callFunction(name, body) {
  if (!db) throw appError('not_configured');
  const { data, error } = await db.functions.invoke(name, { body });
  if (error) {
    let code = 'ai_failed', detail = '';
    const status = error.context?.status;
    try {
      const body = await error.context.json();
      code = body.error || code;
      detail = body.detail || body.message || body.msg || '';
    } catch {}
    if (error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError' || status === 404) code = 'ai_no_function';
    // Шлюз Supabase с включённым Verify JWT отвечает 401 без нашего кода ошибки.
    else if (status === 401 && code === 'ai_failed') code = 'ai_jwt';
    const err = appError(I18N.ru['err_' + code] ? code : 'ai_failed');
    if (detail) err.message += ' (' + detail + ')';
    throw err;
  }
  return data;
}

// Ошибки входа Supabase Auth → наши коды.
function authErrorCode(error) {
  const map = {
    invalid_credentials: 'invalid_credentials',
    user_already_exists: 'email_taken',
    email_exists: 'email_taken',
    email_not_confirmed: 'email_not_confirmed',
    weak_password: 'password_too_short',
    validation_failed: 'invalid_email',
    email_address_invalid: 'invalid_email',
  };
  if (map[error.code]) return map[error.code];
  if (/invalid login/i.test(error.message)) return 'invalid_credentials';
  if (/already registered/i.test(error.message)) return 'email_taken';
  if (/not confirmed/i.test(error.message)) return 'email_not_confirmed';
  return 'server_error';
}

// Отправка события, которая переживает закрытие вкладки.
function rpcKeepalive(fn, args) {
  if (!CONFIGURED) return;
  fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: CONFIG.supabaseAnonKey,
    },
    body: JSON.stringify(args),
  }).catch(() => {});
}

// Заполняет элементы с data-i18n / data-i18n-placeholder.
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  if (root === document) { document.documentElement.lang = LANG; addLangSwitch(); }
}

// Выбор языка в шапке (русский, казахский, английский, турецкий). Выбор запоминается в браузере.
function addLangSwitch() {
  const bar = document.querySelector('header .wrap');
  if (!bar || bar.querySelector('.lang-switch')) return;
  const box = el('select', { class: 'lang-switch', 'aria-label': t('lang_switch'), title: t('lang_switch') },
    Object.keys(I18N).map((code) => el('option', { value: code }, t('lang_' + code))));
  box.value = LANG;
  box.addEventListener('change', () => setLang(box.value));
  const right = bar.querySelector(':scope > .row');
  if (right) right.prepend(box); else bar.append(box);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function fmtTime(value) {
  return new Date(value).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} ${t('sec_short')}`;
  return `${Math.floor(s / 60)} ${t('min_short')} ${s % 60} ${t('sec_short')}`;
}

// Ссылка на страницу внутри сайта; работает и в подпапке GitHub Pages.
function pageUrl(path) {
  return new URL(path, location.href).href;
}

function examLink(code) {
  return pageUrl('exam.html?code=' + encodeURIComponent(code));
}

document.addEventListener('DOMContentLoaded', () => applyI18n());
