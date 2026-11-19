import { getDocument, GlobalWorkerOptions } from './vendor/pdfjs/pdf.min.mjs';

const pdfAssets = '/vendor/pdfjs/';
GlobalWorkerOptions.workerSrc = `${pdfAssets}pdf.worker.min.mjs`;

const back = document.querySelector('#readerBack');
const download = document.querySelector('#readerDownload');
const previous = document.querySelector('#pagePrev');
const next = document.querySelector('#pageNext');
const pageNumber = document.querySelector('#pageNumber');
const total = document.querySelector('#pageTotal');
const container = document.querySelector('#readerPage');
const canvas = document.querySelector('#readerCanvas');
const status = document.querySelector('#readerStatus');

let pdf;
let current = 1;
let renderVersion = 0;
let activeRender;

try {
  if (localStorage.getItem('reading-theme') === 'light') document.documentElement.dataset.theme = 'light';
} catch {
  // The document is still readable if storage is unavailable.
}

function fail(message) {
  status.textContent = message;
  canvas.hidden = true;
}

async function showPage(index) {
  if (!pdf) return;
  const version = ++renderVersion;
  current = Math.min(Math.max(1, index), pdf.numPages);
  pageNumber.value = current;
  previous.disabled = current === 1;
  next.disabled = current === pdf.numPages;
  activeRender?.cancel();
  status.textContent = 'Chargement de la page…';

  try {
    const page = await pdf.getPage(current);
    if (version !== renderVersion) return;
    const base = page.getViewport({ scale: 1 });
    const width = Math.min(container.clientWidth - 24, 900);
    const viewport = page.getViewport({ scale: Math.max(1, width) / base.width });
    const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(5_000_000 / (viewport.width * viewport.height)));
    canvas.width = Math.max(1, Math.floor(viewport.width * density));
    canvas.height = Math.max(1, Math.floor(viewport.height * density));
    canvas.style.width = `${viewport.width}px`;
    canvas.setAttribute('aria-label', `Page ${current} sur ${pdf.numPages}`);
    activeRender = page.render({
      canvas,
      viewport,
      transform: [density, 0, 0, density, 0, 0],
    });
    await activeRender.promise;
    if (version !== renderVersion) return;
    canvas.hidden = false;
    status.textContent = '';
  } catch (error) {
    if (version === renderVersion && error.name !== 'RenderingCancelledException') {
      fail('Impossible d’afficher cette page. Tu peux télécharger le PDF.');
    }
  }
}

function goToPage(index) {
  if (!Number.isInteger(index)) {
    pageNumber.value = current;
    return;
  }
  window.scrollTo(0, 0);
  showPage(index);
}

previous.addEventListener('click', () => goToPage(current - 1));
next.addEventListener('click', () => goToPage(current + 1));
pageNumber.addEventListener('change', () => goToPage(pageNumber.valueAsNumber));
document.addEventListener('keydown', (event) => {
  if (event.target === pageNumber || event.altKey || event.metaKey || event.ctrlKey || !pdf) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    goToPage(current + (event.key === 'ArrowLeft' ? -1 : 1));
  }
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => showPage(current), 100);
});

const id = new URLSearchParams(location.search).get('book');
if (!id) {
  fail('Ce livre est introuvable.');
} else {
  const book = encodeURIComponent(id);
  const url = `/api/books/${book}/file`;
  back.href = `/?book=${book}`;
  download.href = `${url}?download=1`;
  download.hidden = false;

  try {
    pdf = await getDocument({
      url,
      cMapUrl: `${pdfAssets}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${pdfAssets}standard_fonts/`,
      wasmUrl: `${pdfAssets}wasm/`,
      isEvalSupported: false,
    }).promise;
    total.textContent = `/ ${pdf.numPages}`;
    pageNumber.max = pdf.numPages;
    pageNumber.disabled = false;
    await showPage(1);
  } catch {
    fail('Impossible d’ouvrir ce PDF. Tu peux le télécharger pour l’essayer dans un autre lecteur.');
  }
}
