// Общее для страниц учителя: проверка входа и шапка.
async function requireLogin() {
  ensureHeader();
  if (!db) throw appError('not_configured');
  const { data } = await db.auth.getSession();
  if (!data.session) {
    location.href = 'login.html';
    return new Promise(() => {});
  }
  const user = data.session.user;
  document.getElementById('me').textContent = (user.user_metadata && user.user_metadata.name) || user.email;
  refreshAiUsage();
  return user;
}

function teacherHeader() {
  return `<header><div class="wrap"><a class="brand" href="teacher.html">${t('app_name')} · ${t('my_exams')}</a>
    <span class="row"><span class="badge" id="ai-usage" hidden></span><span class="muted" id="me"></span><button class="secondary small" id="logout">${t('logout')}</button></span></div></header>`;
}

function ensureHeader() {
  if (document.getElementById('me')) return;
  document.body.insertAdjacentHTML('afterbegin', teacherHeader());
  document.getElementById('logout').addEventListener('click', async () => {
    if (db) await db.auth.signOut().catch(() => {});
    location.href = 'login.html';
  });
}

document.addEventListener('DOMContentLoaded', ensureHeader);

// Расходы на ИИ (OpenRouter) в шапке. Если функция grade не настроена — ничего не показываем.
function money(x) { return '$' + Number(x).toFixed(2); }
async function refreshAiUsage() {
  const box = document.getElementById('ai-usage');
  try {
    const u = await callFunction('grade', { action: 'usage' });
    if (u.provider !== 'openrouter' || u.error) { box.hidden = true; return; }
    const parts = [t('ai_spent') + ' ' + money(u.spent ?? 0)];
    if (u.spentToday) parts.push(t('ai_today') + ' ' + money(u.spentToday));
    if (u.balance != null) parts.push(t('ai_balance') + ' ' + money(u.balance));
    else if (u.freeTier) parts.push(t('ai_free_tier'));
    box.textContent = t('ai_label') + ': ' + parts.join(' · ');
    box.title = t('ai_usage_hint');
    box.hidden = false;
  } catch { box.hidden = true; }
}

// Ошибки загрузки страницы показываем в #err.
function showPageError(err) {
  const box = document.getElementById('err');
  if (box) box.textContent = err.message;
}
