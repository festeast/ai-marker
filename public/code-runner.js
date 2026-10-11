// Запуск кода учеников прямо в браузере, без сервера.
//   Python — Pyodide (Python на WebAssembly) в отдельном потоке, см. py-worker.js;
//   Java   — CheerpJ (Java 8 на WebAssembly) + javac из OpenJDK, см. java/README.md.
// Первый запуск скачивает среду (Python ≈ 12 МБ, Java ≈ 30 МБ), дальше браузер берёт её из кэша.
//
// CodeRunner.run(lang, code, inputs, onStatus) → { compileError, results: [{ output, error, timeout }] }
//   inputs — входные данные (stdin) для каждого запуска; onStatus(key) сообщает, что сейчас происходит.
// Подключается после i18n.js.
const CodeRunner = (() => {
  const PYODIDE_URL = window.CODE_RUNNER_PYODIDE_URL || 'https://cdn.jsdelivr.net/npm/pyodide@0.29.5/';
  const CHEERPJ_URL = window.CODE_RUNNER_CHEERPJ_URL || 'https://cjrtnc.leaningtech.com/4.2/loader.js';
  const LOAD_TIMEOUT_MS = 180000;
  const RUN_TIMEOUT_MS = 5000; // на один запуск программы

  const PYTHON_STARTER = '';
  const JAVA_STARTER = 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        \n    }\n}\n';

  const fail = (code, detail) => {
    const err = new Error(t('err_' + code) + (detail ? ' (' + detail + ')' : ''));
    err.code = code;
    return err;
  };

  // Запуски идут строго по одному.
  let chain = Promise.resolve();
  function enqueue(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  // ---------- Python ----------
  let pyWorker = null, pyReady = null, pyLoaded = false, pySeq = 0;

  function killPython() {
    if (pyWorker) pyWorker.terminate();
    pyWorker = null; pyReady = null; pyLoaded = false;
  }

  function startPython() {
    if (pyReady) return pyReady;
    const worker = pyWorker = new Worker('py-worker.js');
    pyReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail('code_load_failed', 'timeout')), LOAD_TIMEOUT_MS);
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') { clearTimeout(timer); pyLoaded = true; resolve(); }
        if (e.data.type === 'loadError') { clearTimeout(timer); reject(fail('code_load_failed', e.data.message)); }
      };
      worker.onerror = (e) => { clearTimeout(timer); reject(fail('code_load_failed', e.message)); };
    });
    pyReady.catch(killPython);
    worker.postMessage({ type: 'init', indexURL: PYODIDE_URL });
    return pyReady;
  }

  async function runPythonOnce(code, input, echo) {
    await startPython();
    const worker = pyWorker;
    const id = ++pySeq;
    return new Promise((resolve) => {
      // Зависшую программу не прервать изнутри — останавливаем весь поток, в следующий раз он запустится заново.
      const timer = setTimeout(() => { killPython(); resolve({ output: '', error: '', timeout: true }); }, RUN_TIMEOUT_MS);
      worker.onmessage = (e) => {
        if (e.data.type !== 'result' || e.data.id !== id) return;
        clearTimeout(timer);
        resolve({ output: e.data.output, error: e.data.error, timeout: false });
      };
      worker.postMessage({ type: 'run', id, code, input, echo });
    });
  }

  async function runPython(code, inputs, onStatus, echo) {
    if (!pyLoaded) onStatus('code_loading_python');
    await startPython();
    onStatus('code_running');
    const results = [];
    for (const input of inputs) results.push(await runPythonOnce(code, input, echo));
    return { compileError: '', results };
  }

  // ---------- Java ----------
  let javaReady = null, javaLoaded = false, javaSeq = 0;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(fail('code_load_failed', src));
      document.head.append(s);
    });
  }

  function startJava() {
    if (javaReady) return javaReady;
    javaReady = (async () => {
      if (typeof cheerpjInit !== 'function') await loadScript(CHEERPJ_URL);
      await Promise.race([
        cheerpjInit({ version: 8, status: 'none' }),
        new Promise((_, reject) => setTimeout(() => reject(fail('code_load_failed', 'timeout')), LOAD_TIMEOUT_MS)),
      ]);
      javaLoaded = true;
    })();
    javaReady.catch(() => { javaReady = null; });
    return javaReady;
  }

  // Имя класса с main: публичный класс (файл должен называться так же), иначе первый класс.
  function javaClassName(code) {
    const m = code.match(/public\s+(?:final\s+|abstract\s+)*class\s+([A-Za-z_$][\w$]*)/) || code.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
    return m ? m[1] : 'Main';
  }

  async function readFile(path) {
    try { return await (await cjFileBlob(path)).text(); } catch { return ''; }
  }

  async function runJava(code, inputs, onStatus) {
    if (!javaLoaded) onStatus('code_loading_java');
    await startJava();
    onStatus('code_running');
    // Строку package убираем (номера строк в ошибках не сдвигаются).
    const source = code.replace(/^[ \t]*package\s+[\w.]+[ \t]*;/m, '');
    const cls = javaClassName(source);
    const run = 'run' + (++javaSeq) + '_' + Date.now();
    const srcDir = '/str/' + run, outDir = '/files/' + run;
    cheerpOSAddStringFile(`${srcDir}/${cls}.java`, source);
    inputs.forEach((input, i) => cheerpOSAddStringFile(`${srcDir}/in${i}.txt`, input));
    const base = '/app' + new URL('java/', location.href).pathname;
    const exit = await cheerpjRunMain('Runner', `${base}runner.jar:${base}tools.jar`,
      srcDir, outDir, cls, String(inputs.length), String(RUN_TIMEOUT_MS));
    try {
      inputs.forEach((_, i) => cheerpOSRemoveStringFile(`${srcDir}/in${i}.txt`));
      cheerpOSRemoveStringFile(`${srcDir}/${cls}.java`);
    } catch {}
    if (exit !== 0) throw fail('code_run_failed', 'exit ' + exit);
    const compileError = await readFile(outDir + '/compile.txt');
    if (compileError) return { compileError, results: [] };
    const results = [];
    for (let i = 0; i < inputs.length; i++) {
      const error = await readFile(`${outDir}/err${i}.txt`);
      results.push({ output: await readFile(`${outDir}/out${i}.txt`), error: error === 'timeout' ? '' : error, timeout: error === 'timeout' });
    }
    return { compileError: '', results };
  }

  // ---------- общее ----------

  // echo — показывать ли подсказки input() в Python (при обычном запуске да, при проверке тестами нет).
  function run(lang, code, inputs, onStatus = () => {}, { echo = false } = {}) {
    return enqueue(() => {
      if (lang === 'python') return runPython(code, inputs, onStatus, echo);
      if (lang === 'java') return runJava(code, inputs, onStatus);
      throw fail('invalid_code_lang');
    });
  }

  // Вывод совпадает с ожидаемым, если отличаются только пробелы в конце строк и пустые строки в конце.
  function normalize(s) {
    return String(s || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  }
  function matches(output, expected) {
    return normalize(output) === normalize(expected);
  }

  // Проверка тестами учителя: сколько тестов пройдено и описание первой ошибки.
  async function check(lang, code, tests, onStatus) {
    const res = await run(lang, code, tests.map((x) => x.input || ''), onStatus);
    if (res.compileError) return { passed: 0, total: tests.length, compileError: res.compileError, details: [] };
    const details = res.results.map((r, i) => ({ ...r, ok: !r.timeout && !r.error && matches(r.output, tests[i].output) }));
    return { passed: details.filter((d) => d.ok).length, total: tests.length, compileError: '', details };
  }

  // Удобства редактора кода: Tab вставляет отступ, Enter сохраняет отступ строки.
  function editor(area) {
    area.classList.add('code-editor');
    area.spellcheck = false;
    area.setAttribute('autocapitalize', 'off');
    area.setAttribute('autocomplete', 'off');
    area.setAttribute('autocorrect', 'off');
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '    ') || area.setRangeText('    ', area.selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
      } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const before = area.value.slice(0, area.selectionStart);
        const line = before.slice(before.lastIndexOf('\n') + 1);
        let indent = line.match(/^[ \t]*/)[0];
        if (/[:{]\s*$/.test(line)) indent += '    ';
        if (!indent) return;
        e.preventDefault();
        document.execCommand('insertText', false, '\n' + indent) || area.setRangeText('\n' + indent, area.selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
      }
    });
    return area;
  }

  // Результат одного запуска для показа на странице (нужен el из app.js).
  function resultView(res) {
    const box = el('pre', { class: 'code-output' });
    if (res.compileError) {
      box.append(el('span', { class: 'err' }, t('code_compile_error') + ':\n' + res.compileError));
      return box;
    }
    const r = res.results[0] || { output: '' };
    if (r.output) box.append(r.output.replace(/\n$/, ''));
    if (r.error) box.append(el('span', { class: 'err' }, (r.output ? '\n' : '') + t('code_runtime_error') + ':\n' + r.error.replace(/\n$/, '')));
    if (r.timeout) box.append(el('span', { class: 'note' }, (r.output ? '\n' : '') + t('code_timeout')));
    if (!r.output && !r.error && !r.timeout) box.append(el('span', { class: 'note' }, t('code_no_output')));
    return box;
  }

  // Предзагрузка среды, пока ученик читает задание.
  function preload(lang) {
    (lang === 'java' ? startJava() : startPython()).catch(() => {});
  }

  const langName = (lang) => (lang === 'java' ? 'Java' : 'Python');

  return { langName, run, check, matches, editor, preload, resultView, starter: (lang) => (lang === 'java' ? JAVA_STARTER : PYTHON_STARTER), LANGS: ['python', 'java'] };
})();
