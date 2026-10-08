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
async function rpc(fn, args = {}) {
  if (!db) throw appError('not_configured');
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const code = I18N.ru['err_' + error.message] ? error.message : (error.message || '').includes('fetch') ? 'network' : 'server_error';
    throw appError(code);
  }
  return data;
}

// Вызов функции Supabase (supabase/functions/<name>). Ошибки — те же коды.
async function callFunction(name, body) {
  if (!db) throw appError('not_configured');
  const { data, error } = await db.functions.invoke(name, { body });
  if (error) {
    let code = 'ai_failed';
    try { code = (await error.context.json()).error || code; } catch {}
    if (error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError') code = 'ai_not_configured';
    throw appError(I18N.ru['err_' + code] ? code : 'ai_failed');
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
  return new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин ${s % 60} с`;
}

// Ссылка на страницу внутри сайта; работает и в подпапке GitHub Pages.
function pageUrl(path) {
  return new URL(path, location.href).href;
}

function examLink(code) {
  return pageUrl('exam.html?code=' + encodeURIComponent(code));
}

document.addEventListener('DOMContentLoaded', () => applyI18n());
