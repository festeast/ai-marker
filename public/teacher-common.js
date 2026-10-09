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
  showAdminLink();
  return user;
}

function teacherHeader() {
  const page = location.pathname.split('/').pop();
  const link = (href, key) => `<a href="${href}"${page === href ? ' class="active"' : ''}>${t(key)}</a>`;
  return `<header><div class="wrap"><a class="brand" href="index.html">${t('app_name')}</a>
    <nav class="nav">${link('teacher.html', 'my_exams')}${link('library.html', 'library')}${link('profile.html', 'profile')}</nav>
    <span class="row"><span class="badge" id="ai-usage" hidden></span><span class="muted" id="me"></span><button class="secondary small" id="logout">${t('logout')}</button></span></div></header>`;
}

// Ссылка «Админ» в шапке — только администраторам (таблица admins в базе).
async function showAdminLink() {
  try {
    if (!(await rpc('is_admin'))) return;
  } catch { return; }
  const nav = document.querySelector('header .nav');
  if (!nav || nav.querySelector('[href="admin.html"]')) return;
  const a = el('a', { href: 'admin.html' }, t('admin'));
  if (location.pathname.endsWith('/admin.html')) a.className = 'active';
  nav.appendChild(a);
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

// Процент → оценка по 5-балльной шкале (критериальное оценивание: 85 / 65 / 40 %).
function gradeFor(pct) {
  if (pct === null || pct === undefined) return null;
  return pct >= 85 ? 5 : pct >= 65 ? 4 : pct >= 40 ? 3 : 2;
}
function pctClass(pct) {
  return pct === null || pct === undefined ? 'muted' : pct >= 65 ? 'pct-good' : pct >= 40 ? 'pct-mid' : 'pct-bad';
}
function fmtPct(pct) {
  return pct === null || pct === undefined ? '—' : Math.round(Number(pct)) + '%';
}

// Блок «Класс и материалы для ИИ» экзамена. Сохраняется сразу при изменении.
async function renderExamMeta(box, exam) {
  const [classes, materials] = await Promise.all([rpc('list_classes'), rpc('list_materials')]);
  const selected = new Set(exam.materialIds || []);
  const msg = el('span', { class: 'muted' });
  const listId = 'classes-' + exam.id;
  const cls = el('input', { type: 'text', list: listId, maxlength: 50, placeholder: t('class_placeholder'), style: 'max-width:240px' });
  cls.value = exam.className || '';

  async function save() {
    msg.className = 'muted'; msg.textContent = '';
    try {
      const res = await rpc('update_exam_meta', { p_exam_id: exam.id, p_class_name: cls.value, p_material_ids: [...selected] });
      exam.className = res.className; exam.materialIds = res.materialIds;
      msg.className = 'ok'; msg.textContent = t('saved');
      setTimeout(() => { if (msg.textContent === t('saved')) msg.textContent = ''; }, 2000);
    } catch (err) { msg.className = 'error'; msg.textContent = err.message; }
  }
  cls.addEventListener('change', save);

  const checks = materials.length
    ? el('div', { class: 'check-list' }, materials.map((m) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = selected.has(m.id);
        cb.addEventListener('change', () => { if (cb.checked) selected.add(m.id); else selected.delete(m.id); save(); });
        return el('label', {}, cb, el('span', {}, m.title, m.topic ? el('span', { class: 'muted' }, ' · ' + m.topic) : null,
          !m.content ? el('span', { class: 'muted' }, ' · ' + t('material_file_only')) : null));
      }))
    : el('p', { class: 'muted' }, t('library_empty_hint'), ' ', el('a', { href: 'library.html' }, t('library')));

  box.replaceChildren(
    el('label', {}, t('class_name')), el('div', { class: 'row' }, cls, msg),
    el('datalist', { id: listId }, classes.map((c) => el('option', { value: c }))),
    el('label', {}, t('exam_materials')), el('p', { class: 'muted', style: 'margin:0 0 6px' }, t('exam_materials_hint')), checks);
}
