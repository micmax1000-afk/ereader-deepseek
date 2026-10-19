const CACHE_NAME = 'reader-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
  // Librerie CDN (verranno richieste in modalità no-cors)
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Aggiunge i file locali normalmente
      const localAssets = ASSETS.filter(url => url.startsWith('/'));
      return cache.addAll(localAssets);
    }).then(() => {
      // Aggiunge le librerie CDN con mode: 'no-cors'
      return caches.open(CACHE_NAME).then(cache => {
        const cdnAssets = ASSETS.filter(url => !url.startsWith('/'));
        return Promise.all(
          cdnAssets.map(url =>
            cache.add(new Request(url, { mode: 'no-cors' })).catch(err => {
              console.warn('Impossibile mettere in cache:', url, err);
            })
          )
        );
      });
    })
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
