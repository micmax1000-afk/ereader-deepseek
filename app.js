// ==================================================================
//  1. ELEMENTI UI
// ==================================================================
const $ = id => document.getElementById(id);
const fileInput = $('fileInput'), titleEl = $('title'), statusEl = $('status');
const viewer = $('viewer'), prevBtn = $('prev'), nextBtn = $('next');
const playBtn = $('playBtn'), pauseBtn = $('pauseBtn'), stopBtn = $('stopBtn');
const voiceSel = $('voiceSelect'), rateInput = $('rate'), rateVal = $('rateVal');
const tocBtn = $('tocBtn'), tocPanel = $('toc-panel'), tocContent = $('toc-content');
const tocClose = $('tocClose'), tocOverlay = $('toc-overlay'), themeBtn = $('themeBtn');
const bookmarkBtn = $('bookmarkBtn'), exportBtn = $('exportBtn');

let currentRenderer = null;
let currentFileKey = null;
let darkTheme = false;

const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const fileKeyOf = f => `doc-${f.name}-${f.size}-${f.lastModified || 0}`;

// ==================================================================
//  2. MOTORE TTS
// ==================================================================
class TTSReader {
  constructor() {
    this.queue = []; this.index = 0;
    this.isPlaying = false; this.isPaused = false;
    this.voice = null; this.rate = 1;
    this.onSentenceStart = null;
    this.onBoundary = null;
    this.onFinish = null;
  }
  static split(t) {
    const parts = t.match(/[^.!?…;]+[.!?…;]+[\s"']*|[^.!?…;]+$/g) || [t];
    return parts.map(s => s.trim()).filter(Boolean);
  }
  load(text) { this.stop(); this.queue = TTSReader.split(text); this.index = 0; }
  play() {
    if (!this.queue.length) return;
    if (this.isPaused) { speechSynthesis.resume(); this.isPaused = false; return; }
    if (this.isPlaying) return;
    this.isPlaying = true; this._speakNext();
  }
  _speakNext() {
    if (!this.isPlaying) return;
    if (this.index >= this.queue.length) {
      this.isPlaying = false; const n = this.index; this.index = 0;
      if (this.onFinish) this.onFinish(n);
      return;
    }
    const text = this.queue[this.index];
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice ? this.voice.lang : 'it-IT';
    u.rate = this.rate;
    u.onstart = () => {
      if (this.onSentenceStart) this.onSentenceStart(text, this.index, this.queue.length);
    };
    u.onboundary = (ev) => {
      if (this.onBoundary) this.onBoundary(text, ev.charIndex, ev.charLength || 1, this.index, this.queue.length);
    };
    u.onend = () => { if (!this.isPlaying) return; this.index++; this._speakNext(); };
    u.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('TTS error:', e.error);
      if (!this.isPlaying) return;
      this.index++; this._speakNext();
    };
    speechSynthesis.speak(u);
  }
  pause() { if (!this.isPlaying) return; speechSynthesis.pause(); this.isPaused = true; }
  stop() { this.isPlaying = false; this.isPaused = false; this.index = 0; speechSynthesis.cancel(); }
}
const tts = new TTSReader();

// ==================================================================
//  3. RENDERER — EPUB
// ==================================================================
class EpubRenderer {
  constructor(fileKey) { this.fileKey = fileKey; this.book = null; this.rendition = null; this.toc = null; this.currentHighlight = null; }

  async load(file, container) {
    container.className = ''; container.innerHTML = '';
    this.book = ePub(file);
    this.rendition = this.book.renderTo(container, { width: '100%', height: '100%', spread: 'none' });

    this.rendition.themes.register('light', { 'body': { 'background': '#fff', 'color': '#000' } });
    this.rendition.themes.register('dark', { 'body': { 'background': '#1a1a1a', 'color': '#eee' }, 'a': { 'color': '#66b2ff' } });
    this.rendition.themes.select(darkTheme ? 'dark' : 'light');

    const savedCfi = localStorage.getItem(this.fileKey + '-cfi');
    if (savedCfi) await this.rendition.display(savedCfi);
    else await this.rendition.display();

    this.rendition.on('relocated', loc => {
      const cfi = loc?.start?.cfi;
      if (cfi) localStorage.setItem(this.fileKey + '-cfi', cfi);
    });

    const meta = await this.book.loaded.metadata;
    this.toc = (await this.book.loaded.navigation).toc;
    return { title: meta.title || file.name, creator: meta.creator };
  }

  getText() {
    const c = this.rendition.getContents();
    if (!c || !c.length) return '';
    const doc = c[0].document;
    return doc && doc.body ? doc.body.innerText.replace(/\s+/g, ' ').trim() : '';
  }
  async next() { try { await this.rendition.next(); return true; } catch(e) { return false; } }
  async prev() { try { await this.rendition.prev(); return true; } catch(e) { return false; } }
  isLast() { try { return this.rendition.currentLocation()?.atEnd === true; } catch(e) { return false; } }
  currentInfo() {
    try {
      const p = this.rendition.currentLocation()?.start?.displayed?.page;
      return p ? `Pagina ${p}` : '';
    } catch(e) { return ''; }
  }
  setTheme(dark) { this.rendition && this.rendition.themes.select(dark ? 'dark' : 'light'); }
  goTo(href) { this.rendition.display(href); }

  highlightSentence(cfiRange) {
    if (this.currentHighlight) {
      this.rendition.annotations.remove(this.currentHighlight, 'highlight');
    }
    this.currentHighlight = cfiRange;
    this.rendition.annotations.highlight(cfiRange, { id: 'tts-highlight' }, null, 'tts-highlight', {
      fill: '#ffeb3b', 'fill-opacity': '0.4'
    });
  }

  getCurrentCfi() {
    return this.rendition.currentLocation()?.start?.cfi;
  }

  destroy() {
    try { this.rendition?.destroy(); } catch(e) {}
    try { this.book?.destroy?.(); } catch(e) {}
  }
}

// ==================================================================
//  4. RENDERER — PDF (con OCR)
// ==================================================================
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

class PdfRenderer {
  constructor(fileKey) { this.fileKey = fileKey; this.pdf = null; this.pageNum = 1; this.container = null; this._text = ''; }

  async load(file, container) {
    this.container = container;
    container.className = ''; container.innerHTML = '';
    container.style.background = '#333';
    const buf = await file.arrayBuffer();
    this.pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    const saved = parseInt(localStorage.getItem(this.fileKey + '-page') || '1');
    this.pageNum = Math.min(Math.max(1, saved), this.pdf.numPages);
    await this._renderPage();
    return { title: file.name.replace(/\.pdf$/i, ''), creator: `PDF · ${this.pdf.numPages} pagine` };
  }

  async _renderPage() {
    const page = await this.pdf.getPage(this.pageNum);
    const vp = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.cssText = 'max-width:100%;height:auto;display:block;margin:0 auto;background:#fff';
    this.container.innerHTML = '';
    this.container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const tc = await page.getTextContent();
    let text = tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();

    if (text.length < 50) {
      statusEl.textContent = '🔍 Pagina scansionata — avvio OCR (può richiedere qualche secondo)...';
      try {
        const worker = await Tesseract.createWorker('ita');
        const { data } = await worker.recognize(canvas);
        await worker.terminate();
        text = (data.text || '').replace(/\s+/g, ' ').trim();
        statusEl.textContent = '✅ OCR completato.';
      } catch (e) {
        console.warn('OCR fallito:', e);
        statusEl.textContent = '⚠️ OCR non riuscito.';
      }
    }
    this._text = text;
    localStorage.setItem(this.fileKey + '-page', this.pageNum);
  }

  getText() { return this._text; }
  async next() { if (this.pageNum < this.pdf.numPages) { this.pageNum++; await this._renderPage(); return true; } return false; }
  async prev() { if (this.pageNum > 1) { this.pageNum--; await this._renderPage(); return true; } return false; }
  isLast() { return this.pdf && this.pageNum >= this.pdf.numPages; }
  currentInfo() { return this.pdf ? `Pagina ${this.pageNum} / ${this.pdf.numPages}` : ''; }
  setTheme() {}
  getCurrentCfi() { return `page-${this.pageNum}`; }
  destroy() { try { this.pdf?.destroy(); } catch(e) {} }
}

// ==================================================================
//  5. RENDERER — HTML-like (DOCX, MD, TXT, HTML)
// ==================================================================
class HtmlRenderer {
  constructor(fileKey) { this.fileKey = fileKey; this.container = null; this._text = ''; }

  loadHtml(html, container) {
    this.container = container;
    container.className = 'scrollable' + (darkTheme ? ' dark' : '');
    container.innerHTML = html;
    this._text = (container.innerText || container.textContent || '').replace(/\s+/g, ' ').trim();

    const saved = parseInt(localStorage.getItem(this.fileKey + '-scroll') || '0');
    if (saved > 0) setTimeout(() => container.scrollTop = saved, 50);

    let t;
    container.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(() => localStorage.setItem(this.fileKey + '-scroll', container.scrollTop), 250);
    });
  }

  getText() { return this._text; }
  async next() { return false; }
  async prev() { return false; }
  isLast() { return true; }
  currentInfo() { return ''; }
  setTheme(dark) { if (this.container) this.container.classList.toggle('dark', dark); }
  scrollToRatio(r) {
    if (!this.container) return;
    const c = this.container;
    c.scrollTo({ top: r * (c.scrollHeight - c.clientHeight), behavior: 'smooth' });
  }
  getCurrentCfi() { return null; }
  destroy() { if (this.container) this.container.innerHTML = ''; }
}

// ==================================================================
//  6. RENDERER — Foliate (MOBI, AZW3, FB2, CBZ)
// ==================================================================
class FoliateRenderer {
  constructor(fileKey) { this.fileKey = fileKey; this.view = null; this.container = null; }

  async load(file, container) {
    this.container = container;
    container.innerHTML = '';

    // Import dinamico di foliate-js (modulo ES)
    const { makeBook, View } = await import('https://cdn.jsdelivr.net/npm/foliate-js@latest/dist/index.js');

    this.view = new View();
    container.appendChild(this.view);

    const book = await makeBook(file);
    await this.view.open(book);

    const savedCfi = localStorage.getItem(this.fileKey + '-cfi');
    if (savedCfi) {
      try { await this.view.goTo(savedCfi); } catch(e) { console.warn('CFI non valido', e); }
    }

    this.view.addEventListener('relocate', (e) => {
      const cfi = e.detail?.cfi;
      if (cfi) localStorage.setItem(this.fileKey + '-cfi', cfi);
    });

    const metadata = await book.getMetadata();
    return {
      title: metadata.title || file.name,
      creator: (metadata.creator || []).join(', ')
    };
  }

  getText() {
    const iframe = this.container.querySelector('iframe');
    if (iframe && iframe.contentDocument) {
      return iframe.contentDocument.body.innerText.replace(/\s+/g, ' ').trim();
    }
    return '';
  }
  async next() { await this.view.next(); return true; }
  async prev() { await this.view.prev(); return true; }
  isLast() { return false; }
  currentInfo() { return ''; }
  setTheme() {}
  getCurrentCfi() { return null; }
  destroy() { if (this.view) this.view.remove(); }
}

// ==================================================================
//  7. DISPATCHER — sceglie il renderer giusto
// ==================================================================
function enableControls(on) {
  prevBtn.disabled = !on; nextBtn.disabled = !on;
  playBtn.disabled = !on; voiceSel.disabled = !on; rateInput.disabled = !on;
  bookmarkBtn.disabled = !on; exportBtn.disabled = !on;
  tocBtn.disabled = !(on && currentRenderer && currentRenderer.toc);
  tocBtn.classList.toggle('disabled', tocBtn.disabled);
}

function populateToc(items, container) {
  container.innerHTML = '';
  const walk = (list, depth = 0) => {
    list.forEach(it => {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = it.label.trim();
      if (depth > 0) a.classList.add('sub');
      a.onclick = (e) => {
        e.preventDefault();
        if (currentRenderer?.goTo) currentRenderer.goTo(it.href);
        tocPanel.classList.remove('open'); tocOverlay.classList.remove('open');
      };
      container.appendChild(a);
      if (it.subitems && it.subitems.length) walk(it.subitems, depth + 1);
    });
  };
  walk(items);
}

async function loadFile(file) {
  if (!file) return;
  tts.stop(); setPlaying(false);
  if (currentRenderer) currentRenderer.destroy();
  currentRenderer = null;
  viewer.className = ''; viewer.innerHTML = '';
  viewer.style.background = ''; viewer.style.padding = ''; viewer.style.overflow = '';
  tocContent.innerHTML = '';
  titleEl.textContent = '';
  currentFileKey = fileKeyOf(file);

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  statusEl.textContent = `⏳ Caricamento ${file.name}...`;

  try {
    if (ext === 'epub') {
      currentRenderer = new EpubRenderer(currentFileKey);
      const meta = await currentRenderer.load(file, viewer);
      titleEl.textContent = meta.title + (meta.creator ? ` — ${meta.creator}` : '');
      if (currentRenderer.toc && currentRenderer.toc.length) populateToc(currentRenderer.toc, tocContent);
    } else if (ext === 'pdf') {
      currentRenderer = new PdfRenderer(currentFileKey);
      const meta = await currentRenderer.load(file, viewer);
      titleEl.textContent = meta.title;
    } else if (ext === 'docx') {
      const buf = await file.arrayBuffer();
      const r = await mammoth.convertToHtml({ arrayBuffer: buf });
      currentRenderer = new HtmlRenderer(currentFileKey);
      currentRenderer.loadHtml(r.value, viewer);
      titleEl.textContent = file.name;
    } else if (ext === 'md' || ext === 'markdown') {
      const text = await file.text();
      currentRenderer = new HtmlRenderer(currentFileKey);
      currentRenderer.loadHtml(marked.parse(text), viewer);
      titleEl.textContent = file.name;
    } else if (ext === 'txt') {
      const text = await file.text();
      currentRenderer = new HtmlRenderer(currentFileKey);
      currentRenderer.loadHtml(`<pre>${escapeHtml(text)}</pre>`, viewer);
      titleEl.textContent = file.name;
    } else if (ext === 'html' || ext === 'htm') {
      const text = await file.text();
      currentRenderer = new HtmlRenderer(currentFileKey);
      currentRenderer.loadHtml(text, viewer);
      titleEl.textContent = file.name;
    } else if (['mobi', 'azw3', 'fb2', 'cbz'].includes(ext)) {
      currentRenderer = new FoliateRenderer(currentFileKey);
      const meta = await currentRenderer.load(file, viewer);
      titleEl.textContent = meta.title + (meta.creator ? ` — ${meta.creator}` : '');
    } else {
      throw new Error(`Formato ".${ext}" non supportato`);
    }

    enableControls(true);
    statusEl.textContent = `✅ ${file.name} caricato. Premi "🔊 Leggi".`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = '❌ Errore: ' + err.message;
    enableControls(false);
    currentRenderer = null;
  }
}

// ==================================================================
//  8. SUPPORTO TTS + UI
// ==================================================================
function loadPageIntoTTs() {
  if (!currentRenderer) return false;
  const text = currentRenderer.getText();
  if (!text) { statusEl.textContent = '⚠️ Nessun testo estraibile.'; return false; }
  tts.load(text); return true;
}

function setPlaying(p) {
  playBtn.classList.toggle('active', p);
  pauseBtn.disabled = !p; stopBtn.disabled = !p;
}

// Voci
function populateVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  voiceSel.innerHTML = '';
  const it = voices.filter(v => v.lang.toLowerCase().startsWith('it'));
  const other = voices.filter(v => !v.lang.toLowerCase().startsWith('it'));
  [...it, ...other].forEach(v => {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})${v.localService ? ' • offline' : ''}`;
    voiceSel.appendChild(o);
  });
  if (it.length) { voiceSel.value = it[0].name; tts.voice = it[0]; }
}
speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();
voiceSel.onchange = () => { tts.voice = speechSynthesis.getVoices().find(v => v.name === voiceSel.value) || null; };
rateInput.oninput = () => { tts.rate = parseFloat(rateInput.value); rateVal.textContent = tts.rate.toFixed(1) + 'x'; };

// Callback TTS
tts.onSentenceStart = (text, idx, total) => {
  statusEl.innerHTML = `🗣️ [${idx+1}/${total}] ${escapeHtml(text.slice(0, 150))}${text.length > 150 ? '…' : ''}`;
  if (currentRenderer instanceof HtmlRenderer) currentRenderer.scrollToRatio(idx / Math.max(total, 1));
  if (currentRenderer instanceof EpubRenderer) {
    const loc = currentRenderer.rendition.currentLocation();
    if (loc && loc.start && loc.start.cfi) {
      currentRenderer.highlightSentence(loc.start.cfi + '!' + loc.end.cfi);
    }
  }
};

tts.onBoundary = (sentence, ci, cl, idx, total) => {
  const before = sentence.slice(0, ci);
  const word = sentence.slice(ci, ci + cl);
  const after = sentence.slice(ci + cl, ci + cl + 80);
  statusEl.innerHTML = `🗣️ [${idx+1}/${total}] ${escapeHtml(before)}<mark>${escapeHtml(word)}</mark>${escapeHtml(after)}`;
};

tts.onFinish = async () => {
  setPlaying(false);
  if (!currentRenderer) return;
  if (currentRenderer.isLast()) { statusEl.textContent = '✅ Fine del documento.'; return; }
  const advanced = await currentRenderer.next();
  if (!advanced) { statusEl.textContent = '✅ Fine del documento.'; return; }
  setTimeout(() => {
    if (!loadPageIntoTTs()) return;
    tts.play(); setPlaying(true);
  }, 400);
};

// ==================================================================
//  9. SEGNALIBRI E ESPORTAZIONE
// ==================================================================
function addBookmark() {
  if (!currentRenderer || !currentFileKey) return;
  const cfi = currentRenderer.getCurrentCfi();
  if (!cfi) { alert('Impossibile determinare la posizione corrente.'); return; }
  const note = prompt('Nota per questo segnalibro (opzionale):');
  const bookmarks = JSON.parse(localStorage.getItem(currentFileKey + '-bookmarks') || '[]');
  bookmarks.push({ cfi, note: note || '', timestamp: Date.now() });
  localStorage.setItem(currentFileKey + '-bookmarks', JSON.stringify(bookmarks));
  alert('Segnalibro salvato!');
}

function exportMarkdown() {
  if (!currentFileKey) return;
  const bookmarks = JSON.parse(localStorage.getItem(currentFileKey + '-bookmarks') || '[]');
  if (bookmarks.length === 0) { alert('Nessun segnalibro da esportare.'); return; }
  let md = `# Note per ${titleEl.textContent}\n\n`;
  bookmarks.forEach((b, i) => {
    md += `## Segnalibro ${i + 1}\n`;
    md += `- **Posizione:** \`${b.cfi}\`\n`;
    md += `- **Data:** ${new Date(b.timestamp).toLocaleString()}\n`;
    if (b.note) md += `- **Nota:** ${b.note}\n`;
    md += `\n`;
  });
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `note-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// ==================================================================
//  10. EVENTI
// ==================================================================
fileInput.onchange = e => { const f = e.target.files[0]; if (f) loadFile(f); };

prevBtn.onclick = async () => { if (!currentRenderer) return; tts.stop(); setPlaying(false); await currentRenderer.prev(); };
nextBtn.onclick = async () => { if (!currentRenderer) return; tts.stop(); setPlaying(false); await currentRenderer.next(); };

document.addEventListener('keydown', async e => {
  if (!currentRenderer) return;
  if (e.key === 'ArrowLeft') { tts.stop(); setPlaying(false); await currentRenderer.prev(); }
  if (e.key === 'ArrowRight') { tts.stop(); setPlaying(false); await currentRenderer.next(); }
});

playBtn.onclick = () => {
  if (!currentRenderer) return;
  if (tts.isPaused) { tts.play(); setPlaying(true); return; }
  if (!tts.isPlaying) { if (!loadPageIntoTTs()) return; }
  tts.play(); setPlaying(true);
};
pauseBtn.onclick = () => tts.pause();
stopBtn.onclick = () => { tts.stop(); setPlaying(false); statusEl.textContent = '⏹ Interrotto.'; };

tocBtn.onclick = () => { tocPanel.classList.add('open'); tocOverlay.classList.add('open'); };
tocClose.onclick = tocOverlay.onclick = () => {
  tocPanel.classList.remove('open'); tocOverlay.classList.remove('open');
};

themeBtn.onclick = () => {
  darkTheme = !darkTheme;
  document.body.classList.toggle('light-ui', !darkTheme);
  if (currentRenderer?.setTheme) currentRenderer.setTheme(darkTheme);
};

bookmarkBtn.onclick = addBookmark;
exportBtn.onclick = exportMarkdown;

// ==================================================================
//  11. PWA — registrazione service worker
// ==================================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker non registrato:', err);
  });
}
