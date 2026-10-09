// Достаёт текст из PDF, Word, PowerPoint и Excel прямо в браузере, чтобы его мог прочитать ИИ.
// Библиотеки грузятся только когда учитель выбрал такой файл.
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

const loadedScripts = {};
function loadScript(src) {
  if (!loadedScripts[src]) {
    loadedScripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete loadedScripts[src]; reject(appError('extract_failed')); };
      document.head.appendChild(s);
    });
  }
  return loadedScripts[src];
}

function fileExt(name) {
  return ((name || '').match(/\.([A-Za-z0-9]+)$/) || ['', ''])[1].toLowerCase();
}

// Можно ли достать текст из файла с таким именем.
function canExtractText(name) {
  return ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md'].includes(fileExt(name));
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? m;
  });
}

// Текст из Office XML: абзацы (tag) — с новой строки, текстовые куски (textTag) склеиваются.
function officeXmlText(xml, paragraphTag, textTag) {
  const paras = xml.split(new RegExp(`</${paragraphTag}>`));
  const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|<(?:w:tab|a:tab)\\s*/>|<(?:w:br|a:br)(?:\\s[^>]*)?/?>`, 'g');
  return paras.map((p) => {
    let line = '';
    for (const m of p.matchAll(re)) line += m[1] !== undefined ? unescapeXml(m[1]) : (m[0].includes('tab') ? '\t' : '\n');
    return line.trim();
  }).filter(Boolean).join('\n');
}

function byNumber(a, b) {
  return Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]);
}

async function openZip(file) {
  await loadScript(JSZIP_URL);
  try { return await JSZip.loadAsync(await file.arrayBuffer()); } catch { throw appError('extract_failed'); }
}

async function docxText(file) {
  const zip = await openZip(file);
  const parts = ['word/document.xml', ...Object.keys(zip.files).filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))];
  const texts = [];
  for (const name of parts) {
    if (zip.file(name)) texts.push(officeXmlText(await zip.file(name).async('string'), 'w:p', 'w:t'));
  }
  return texts.join('\n\n');
}

async function pptxText(file) {
  const zip = await openZip(file);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
  const out = [];
  for (const [i, name] of slides.entries()) {
    let text = officeXmlText(await zip.file(name).async('string'), 'a:p', 'a:t');
    const notesName = `ppt/notesSlides/notesSlide${name.match(/(\d+)\.xml$/)[1]}.xml`;
    if (zip.file(notesName)) {
      const notes = officeXmlText(await zip.file(notesName).async('string'), 'a:p', 'a:t').replace(/^\d+$/m, '').trim();
      if (notes) text += `\n(${t('extract_notes')}: ${notes})`;
    }
    if (text.trim()) out.push(`— ${t('extract_slide')} ${i + 1} —\n${text}`);
  }
  return out.join('\n\n');
}

async function xlsxText(file) {
  const zip = await openZip(file);
  const shared = [];
  if (zip.file('xl/sharedStrings.xml')) {
    const xml = await zip.file('xl/sharedStrings.xml').async('string');
    for (const si of xml.split('</si>').slice(0, -1)) {
      shared.push([...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unescapeXml(m[1])).join(''));
    }
  }
  const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber);
  const out = [];
  for (const name of sheets) {
    const xml = await zip.file(name).async('string');
    const rows = [];
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] || '';
        const v = (body.match(/<v>([^<]*)<\/v>/) || [])[1];
        if (/t="s"/.test(attrs) && v !== undefined) cells.push(shared[Number(v)] ?? '');
        else if (/t="inlineStr"/.test(attrs)) cells.push([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unescapeXml(m[1])).join(''));
        else cells.push(v !== undefined ? unescapeXml(v) : '');
      }
      if (cells.some((x) => x.trim())) rows.push(cells.join('\t'));
    }
    if (rows.length) out.push(rows.join('\n'));
  }
  return out.join('\n\n');
}

async function pdfText(file) {
  // Обработчик PDF грузим в саму страницу: отдельный worker с другого сайта браузеры часто не пускают.
  await loadScript(PDFJS_URL);
  await loadScript(PDFJS_WORKER_URL);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  let pdf;
  try { pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; } catch { throw appError('extract_failed'); }
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    // Куски текста собираем в строки по высоте на странице, внутри строки — слева направо.
    const lines = [];
    for (const item of content.items) {
      if (!item.str || !item.transform) continue;
      const [, , , , x, y] = item.transform;
      const h = Math.abs(item.height || item.transform[3]) || 10;
      let line = lines.find((l) => Math.abs(l.y - y) < h * 0.6);
      if (!line) lines.push(line = { y, items: [] });
      line.items.push({ x, w: item.width || 0, str: item.str });
    }
    lines.sort((a, b) => b.y - a.y);
    pages.push(lines.map((l) => {
      l.items.sort((a, b) => a.x - b.x);
      let text = '', end = null;
      for (const it of l.items) {
        if (end !== null && it.x - end > 1 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
        text += it.str; end = it.x + it.w;
      }
      return text.replace(/\s+/g, ' ').trim();
    }).filter(Boolean).join('\n'));
  }
  return pages.filter(Boolean).join('\n\n');
}

// Возвращает текст файла. Бросает appError: file_old_format, file_no_text, extract_failed.
async function extractText(file) {
  const ext = fileExt(file.name);
  if (['doc', 'ppt', 'xls'].includes(ext)) throw appError('file_old_format');
  let text;
  if (ext === 'txt' || ext === 'md') text = await file.text();
  else if (ext === 'pdf') text = await pdfText(file);
  else if (ext === 'docx') text = await docxText(file);
  else if (ext === 'pptx') text = await pptxText(file);
  else if (ext === 'xlsx') text = await xlsxText(file);
  else throw appError('file_no_text');
  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw appError('file_no_text');
  return text;
}
