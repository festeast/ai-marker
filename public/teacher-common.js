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
  return user;
}

function teacherHeader() {
  return `<header><div class="wrap"><a class="brand" href="teacher.html">${t('app_name')} · ${t('my_exams')}</a>
    <span class="row"><span class="muted" id="me"></span><button class="secondary small" id="logout">${t('logout')}</button></span></div></header>`;
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

// Ошибки загрузки страницы показываем в #err.
function showPageError(err) {
  const box = document.getElementById('err');
  if (box) box.textContent = err.message;
}
