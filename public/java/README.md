# Java в браузере

Код учеников на Java компилируется и запускается прямо в браузере через
[CheerpJ](https://cheerpj.com/) (Java 8 на WebAssembly). Сервер для этого не нужен.

- `tools.jar` — компилятор `javac` из OpenJDK 8 без изменений (лицензия GPL v2 с Classpath Exception,
  исходники — https://openjdk.org/). Взят из npm-пакета `dataslope-tools-jar@1.0.0`.
- `Runner.java` — маленькая программа, которая компилирует код ученика, запускает его на входных данных
  тестов и записывает вывод в файлы. `runner.jar` — она же, уже собранная.
- Сама Java-машина CheerpJ загружается с `cjrtnc.leaningtech.com` (бесплатная лицензия Community).

Пересобрать `runner.jar` после правки `Runner.java` (нужен JDK 9 или новее):

```sh
mkdir -p /tmp/runner && javac --release 8 -nowarn -d /tmp/runner public/java/Runner.java
(cd /tmp/runner && jar --create --file "$OLDPWD/public/java/runner.jar" *.class)
```
