// Отдельный поток для Python (Pyodide): если программа ученика зависнет,
// страница просто остановит этот поток. Используется из code-runner.js.
let py = null;
let ready = null;

const HARNESS = `
import sys, io, traceback, builtins

def _am_run(code, inp, echo):
    out = io.StringIO()
    stdin = io.StringIO(inp)
    saved = sys.stdin, sys.stdout, sys.stderr
    old_input = builtins.input

    def _input(prompt=''):
        # Подсказку input("...") показываем при обычном запуске, но не при проверке тестами.
        if echo and prompt:
            out.write(str(prompt))
        line = stdin.readline()
        if not line:
            raise EOFError('EOF when reading a line')
        return line[:-1] if line.endswith('\\n') else line

    err = ''
    sys.stdin, sys.stdout, sys.stderr = stdin, out, out
    builtins.input = _input
    try:
        exec(compile(code, 'main.py', 'exec'), {'__name__': '__main__', '__builtins__': builtins})
    except SystemExit as e:
        if e.code is not None and not isinstance(e.code, int):
            out.write(str(e.code) + '\\n')
    except BaseException as e:
        tb = e.__traceback__.tb_next if e.__traceback__ else None
        err = ''.join(traceback.format_exception(type(e), e, tb))
    finally:
        sys.stdin, sys.stdout, sys.stderr = saved
        builtins.input = old_input
    return [out.getvalue()[:100000], err[:5000]]
`;

onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    ready = (async () => {
      importScripts(msg.indexURL + 'pyodide.js');
      py = await loadPyodide({ indexURL: msg.indexURL });
      py.runPython(HARNESS);
    })();
    ready.then(() => postMessage({ type: 'ready' }), (err) => postMessage({ type: 'loadError', message: String(err && err.message || err) }));
    return;
  }
  if (msg.type === 'run') {
    await ready;
    const res = py.globals.get('_am_run')(msg.code, msg.input || '', !!msg.echo);
    const [output, error] = res.toJs();
    res.destroy();
    postMessage({ type: 'result', id: msg.id, output, error });
  }
};
