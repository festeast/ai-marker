// Запускает программу ученика на Java внутри CheerpJ (Java в браузере).
// Собирается один раз в runner.jar (см. README.md рядом), на сайте лежит готовый jar.
//
// Аргументы: srcDir outDir className testCount timeoutMs
//   srcDir  — папка (в /str/), где страница положила <className>.java и входные данные in0.txt, in1.txt, …
//   outDir  — папка (в /files/), куда пишутся результаты:
//             compile.txt — ошибки компиляции (пусто, если всё собралось);
//             outN.txt — что программа вывела на тесте N; errN.txt — ошибка или «timeout».
// Компилятор javac берётся из tools.jar (лежит рядом, OpenJDK 8) и вызывается через reflection.
// Каждый тест запускается в своём загрузчике классов, чтобы статические поля не переходили между тестами.
import java.io.*;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.security.Permission;

public class Runner {
  static final int OUTPUT_LIMIT = 100000;

  static class ExitCalled extends SecurityException {
    ExitCalled() { super("System.exit"); }
  }

  // Вывод с ограничением размера: бесконечная печать не съест память.
  static class LimitedStream extends ByteArrayOutputStream {
    @Override public synchronized void write(int b) { if (count < OUTPUT_LIMIT) super.write(b); }
    @Override public synchronized void write(byte[] b, int off, int len) {
      int room = OUTPUT_LIMIT - count;
      if (room > 0) super.write(b, off, Math.min(len, room));
    }
  }

  public static void main(String[] args) throws Exception {
    File srcDir = new File(args[0]);
    File outDir = new File(args[1]);
    String className = args[2];
    int tests = Integer.parseInt(args[3]);
    long timeout = Long.parseLong(args[4]);
    File classes = new File(outDir, "classes");
    classes.mkdirs();

    StringWriter compileLog = new StringWriter();
    int rc = compile(new File(srcDir, className + ".java"), classes, new PrintWriter(compileLog));
    write(new File(outDir, "compile.txt"), rc == 0 ? "" : compileLog.toString().replace(srcDir.getPath() + File.separator, ""));
    if (rc != 0) return;

    PrintStream realOut = System.out, realErr = System.err;
    InputStream realIn = System.in;
    // System.exit в программе ученика не должен останавливать проверку.
    try {
      System.setSecurityManager(new SecurityManager() {
        @Override public void checkPermission(Permission p) {
          if (p.getName().startsWith("exitVM")) throw new ExitCalled();
        }
        @Override public void checkPermission(Permission p, Object context) { checkPermission(p); }
      });
    } catch (Throwable ignored) {
      // без SecurityManager тоже работаем
    }
    try {
      for (int i = 0; i < tests; i++) {
        String input = read(new File(srcDir, "in" + i + ".txt"));
        LimitedStream out = new LimitedStream();
        String error = runOne(classes, className, input, out, timeout);
        write(new File(outDir, "out" + i + ".txt"), new String(out.toByteArray(), StandardCharsets.UTF_8));
        write(new File(outDir, "err" + i + ".txt"), error);
      }
    } finally {
      try { System.setSecurityManager(null); } catch (Throwable ignored) {}
      System.setOut(realOut);
      System.setErr(realErr);
      System.setIn(realIn);
    }
  }

  static int compile(File src, File classes, PrintWriter log) throws Exception {
    Class<?> javac = Class.forName("com.sun.tools.javac.Main");
    Method m = javac.getMethod("compile", String[].class, PrintWriter.class);
    String[] opts = { "-encoding", "UTF-8", "-nowarn", "-g:source,lines", "-d", classes.getPath(), src.getPath() };
    int rc = (Integer) m.invoke(null, opts, log);
    log.flush();
    return rc;
  }

  static String runOne(File classes, String className, String input, LimitedStream out, long timeout) throws Exception {
    final URLClassLoader loader = new URLClassLoader(new URL[] { classes.toURI().toURL() }, Runner.class.getClassLoader());
    final Method main;
    try {
      main = loader.loadClass(className).getMethod("main", String[].class);
    } catch (NoSuchMethodException e) {
      return "В классе " + className + " нет метода public static void main(String[] args)";
    }
    PrintStream ps = new PrintStream(out, true, "UTF-8");
    System.setIn(new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8)));
    System.setOut(ps);
    System.setErr(ps);
    final String[] error = { "" };
    Thread t = new Thread(new Runnable() {
      public void run() {
        try {
          main.invoke(null, (Object) new String[0]);
        } catch (InvocationTargetException e) {
          Throwable c = e.getCause();
          if (!(c instanceof ExitCalled)) error[0] = describe(c, className);
        } catch (Throwable e) {
          error[0] = e.toString();
        }
      }
    });
    t.setContextClassLoader(loader);
    t.setDaemon(true);
    t.start();
    t.join(timeout);
    ps.flush();
    if (t.isAlive()) {
      try { t.stop(); } catch (Throwable ignored) {}
      return "timeout";
    }
    return error[0];
  }

  // Ошибка ученика: тип, сообщение и строки его кода (без строк самого Runner).
  static String describe(Throwable c, String className) {
    StringBuilder sb = new StringBuilder(c.toString());
    int frames = 0;
    for (StackTraceElement el : c.getStackTrace()) {
      String cls = el.getClassName();
      if (cls.startsWith("java.lang.reflect") || cls.startsWith("sun.reflect") || cls.startsWith("jdk.internal.reflect")
          || cls.equals(Runner.class.getName()) || cls.startsWith("Runner$") || ++frames > 8) break;
      sb.append("\n    at ").append(el);
    }
    return sb.toString();
  }

  static String read(File f) throws IOException {
    if (!f.exists()) return "";
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    InputStream in = new FileInputStream(f);
    try {
      byte[] buf = new byte[8192];
      int n;
      while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
    } finally { in.close(); }
    return new String(b.toByteArray(), StandardCharsets.UTF_8);
  }

  static void write(File f, String s) throws IOException {
    OutputStream o = new FileOutputStream(f);
    try { o.write(s.getBytes(StandardCharsets.UTF_8)); } finally { o.close(); }
  }
}
