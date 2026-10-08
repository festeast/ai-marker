// Общее для страниц учителя: проверка входа и шапка.
async function requireLogin() {
  try {
    const me = await api('GET', '/api/auth/me');
    document.getElementById('me').textContent = me.name;
    return me;
  } catch (err) {
    if (err.status === 401) location.href = '/login';
    throw err;
  }
}

function teacherHeader() {
  return `<header><div class="wrap"><a class="brand" href="/teacher">${t('app_name')} · ${t('my_exams')}</a>
    <span class="row"><span class="muted" id="me"></span><button class="secondary small" id="logout">${t('logout')}</button></span></div></header>`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.body.insertAdjacentHTML('afterbegin', teacherHeader());
  document.getElementById('logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.href = '/login';
  });
});

function examLink(code) {
  return `${location.origin}/e/${code}`;
}
