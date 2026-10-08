// Тексты интерфейса. Сейчас заполнен русский; казахский (kk) добавляется
// сюда же — ключи без перевода показываются по-русски.
const I18N = {
  ru: {
    app_name: 'AI Marker',
    teacher_login: 'Вход для учителя',
    my_exams: 'Мои экзамены',
    logout: 'Выйти',
    enter_code: 'Код экзамена',
    go: 'Перейти',
    student_intro: 'Студент? Введите код, который дал учитель.',
    login: 'Войти',
    register: 'Зарегистрироваться',
    no_account: 'Нет аккаунта?',
    have_account: 'Уже есть аккаунт?',
    email: 'Email',
    name: 'Имя',
    password: 'Пароль (минимум 8 символов)',
    new_exam: 'Новый экзамен',
    exam_title: 'Название',
    type_quiz: 'Быстрый тест',
    type_quiz_hint: 'вопросы с вариантами ответа',
    type_text: 'Текстовые вопросы',
    type_text_hint: 'студент пишет ответ сам',
    create: 'Создать',
    status_draft: 'Черновик',
    status_published: 'Идёт',
    status_closed: 'Завершён',
    participants: 'Участники',
    no_exams: 'Пока нет экзаменов.',
    open: 'Открыть',
    monitor: 'Мониторинг',
    questions: 'Вопросы',
    question: 'Вопрос',
    add_question: '+ Добавить вопрос',
    add_option: '+ Вариант',
    option: 'Вариант',
    correct: 'верный',
    remove: 'Удалить',
    save: 'Сохранить',
    saved: 'Сохранено',
    confirm_publish: 'Подтвердить и получить код',
    confirm_publish_q: 'После подтверждения вопросы нельзя будет изменить. Продолжить?',
    exam_ready: 'Экзамен готов',
    code: 'Код',
    link: 'Ссылка',
    copy: 'Копировать',
    copied: 'Скопировано',
    close_exam: 'Завершить экзамен',
    close_exam_q: 'Завершить экзамен? Студенты больше не смогут отвечать.',
    delete_exam: 'Удалить экзамен',
    delete_exam_q: 'Удалить экзамен со всеми ответами?',
    back: '← Назад',
    col_student: 'Студент',
    col_status: 'Статус',
    col_left: 'Уходил со вкладки',
    col_away: 'Время вне вкладки',
    col_pastes: 'Большие вставки',
    col_answered: 'Ответил',
    col_score: 'Баллы',
    st_online: 'на странице',
    st_away: 'ушёл со вкладки',
    st_offline: 'не в сети',
    st_submitted: 'сдал',
    events: 'События',
    no_participants: 'Пока никто не присоединился.',
    ev_join: 'присоединился',
    ev_leave: 'ушёл со страницы',
    ev_leave_close: 'закрыл страницу',
    ev_return: 'вернулся через',
    ev_paste: 'вставил текст',
    ev_submit: 'сдал работу',
    chars: 'симв.',
    large: 'большая вставка',
    only_flagged: 'Только важные (уходы и большие вставки)',
    your_name: 'Ваше имя и фамилия',
    start: 'Начать',
    submit: 'Сдать работу',
    submit_q: 'Сдать работу? Изменить ответы будет нельзя.',
    submitted_msg: 'Работа сдана. Можно закрыть страницу.',
    autosaved: 'Ответы сохраняются автоматически',
    answer_placeholder: 'Ваш ответ…',
    monitor_notice: 'Учитель видит, когда вы уходите со страницы и вставляете текст.',
    // коды ошибок сервера
    err_unauthorized: 'Нужно войти',
    err_invalid_email: 'Неверный email',
    err_name_required: 'Введите имя',
    err_password_too_short: 'Пароль слишком короткий',
    err_email_taken: 'Этот email уже зарегистрирован',
    err_invalid_credentials: 'Неверный email или пароль',
    err_title_required: 'Введите название',
    err_invalid_type: 'Выберите тип экзамена',
    err_question_text_required: 'У каждого вопроса должен быть текст',
    err_quiz_needs_options: 'У каждого вопроса нужно минимум 2 заполненных варианта',
    err_quiz_needs_correct: 'Отметьте верный вариант в каждом вопросе',
    err_no_questions: 'Добавьте хотя бы один вопрос',
    err_exam_locked: 'Экзамен уже подтверждён, менять нельзя',
    err_exam_not_found: 'Экзамен с таким кодом не найден',
    err_exam_not_open: 'Экзамен сейчас не принимает ответы',
    err_already_submitted: 'Работа уже сдана',
    err_not_found: 'Не найдено',
    err_server_error: 'Ошибка сервера, попробуйте ещё раз',
    err_network: 'Нет связи с сервером',
  },
  kk: {},
};

let LANG = 'ru';
try { LANG = localStorage.getItem('lang') || 'ru'; } catch {}

function t(key) {
  return (I18N[LANG] && I18N[LANG][key]) || I18N.ru[key] || key;
}

// Заполняет элементы с data-i18n / data-i18n-placeholder.
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

async function api(method, url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error(t('err_network')), { code: 'network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(t('err_' + (data.error || 'server_error'))), { code: data.error, status: res.status });
  return data;
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

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин ${s % 60} с`;
}

document.addEventListener('DOMContentLoaded', () => applyI18n());
