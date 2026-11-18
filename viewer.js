const pdfModule = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const pdfEngine = import(pdfModule + 'build/pdf.mjs').then(engine => {
  engine.GlobalWorkerOptions.workerSrc = pdfModule + 'build/pdf.worker.mjs';
  return engine;
});

document.body.insertAdjacentHTML('afterbegin', `
  <div class="reader" id="reader">
    <header>
      <h1 id="book-title"></h1>
    </header>

    <main id="viewport" aria-label="PDF reading area" tabindex="0">
      <div id="sheet"></div>
      <p id="status" role="status">Loading the reader…</p>
    </main>

    <footer aria-label="Reading controls">
      <button id="previous" type="button" aria-label="Previous spread" disabled>‹</button>
      <form id="jump">
        <input id="page" type="number" aria-label="Page number" min="1" value="1" required disabled>
        <span id="total">/ —</span>
        <button id="go" disabled>Go</button>
      </form>
      <button id="next" type="button" aria-label="Next spread" disabled>›</button>
      <span class="divider" aria-hidden="true"></span>
      <button id="minus" type="button" aria-label="Zoom out" disabled>−</button>
      <button id="fit" type="button" aria-label="Fit page" disabled>Fit</button>
      <button id="plus" type="button" aria-label="Zoom in" disabled>+</button>
      <button id="fullscreen" type="button" aria-label="Fullscreen" aria-pressed="false" hidden>⛶</button>
    </footer>
  </div>
`);
document.querySelector('#book-title').textContent = document.title;

const byId = id => document.getElementById(id);
const reader = byId('reader');
const viewport = byId('viewport');
const sheet = byId('sheet');
const status = byId('status');
const pageInput = byId('page');
const controls = ['previous', 'next', 'page', 'go', 'minus', 'fit', 'plus'];

let pdf;
let renderTasks = [];
let renderVersion = 0;
let page = 1;
let zoom = 1;
let renderTimer;
let zoomAnchor;
let gesture;

function message(text = '') {
  status.textContent = text;
  status.hidden = !text;
}

function updateControls() {
  for (const id of controls) byId(id).disabled = !pdf;
  byId('previous').disabled = !pdf || page === 1;
  byId('next').disabled = !pdf || page + 1 >= pdf.numPages;
  byId('minus').disabled = !pdf || zoom <= 1;
  byId('plus').disabled = !pdf || zoom >= 4;
  viewport.classList.toggle('zoomed', zoom > 1);
  pageInput.value = page;
  pageInput.max = pdf?.numPages ?? 1;
  byId('total').textContent = '/ ' + (pdf?.numPages ?? '—');
  byId('fit').textContent = zoom === 1 ? 'Fit' : Math.round(zoom * 100) + '%';
}

function renderLater() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => render(), 80);
}

async function render(direction = 0) {
  if (!pdf) return;
  const version = ++renderVersion;
  for (const task of renderTasks) task.cancel();
  renderTasks = [];
  try {
    const numbers = [page, page + 1].filter(number => number <= pdf.numPages);
    const pdfPages = await Promise.all(numbers.map(number => pdf.getPage(number)));
    if (version !== renderVersion) return;
    const dimensions = pdfPages.map(pdfPage => pdfPage.getViewport({ scale: 1 }));
    const totalWidth = dimensions.reduce((sum, view) => sum + view.width, 0);
    const maxHeight = Math.max(...dimensions.map(view => view.height));
    const style = getComputedStyle(viewport);
    const width = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const scale = Math.max(0.01, Math.min(width / totalWidth, height / maxHeight)) * zoom;
    const canvases = pdfPages.map((pdfPage, index) => {
      const view = pdfPage.getViewport({ scale });
      const density = Math.min(devicePixelRatio || 1, 4096 / Math.max(view.width, view.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(view.width * density));
      canvas.height = Math.max(1, Math.floor(view.height * density));
      canvas.style.width = view.width + 'px';
      canvas.style.height = view.height + 'px';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Page ' + numbers[index] + ' of ' + pdf.numPages);
      renderTasks.push(pdfPage.render({
        canvasContext: canvas.getContext('2d'),
        viewport: view,
        transform: [canvas.width / view.width, 0, 0, canvas.height / view.height, 0, 0]
      }));
      return canvas;
    });
    await Promise.all(renderTasks.map(task => task.promise));
    if (version !== renderVersion) return;
    renderTasks = [];
    if (direction > 0) canvases.at(-1).className = 'forward';
    if (direction < 0) canvases[0].className = 'backward';
    sheet.replaceChildren(...canvases);
    message();
    if (zoomAnchor) {
      const rect = sheet.getBoundingClientRect();
      viewport.scrollBy({
        left: rect.left + zoomAnchor.xRatio * rect.width - zoomAnchor.x,
        top: rect.top + zoomAnchor.yRatio * rect.height - zoomAnchor.y,
        behavior: 'instant'
      });
      zoomAnchor = null;
    }
  } catch (error) {
    if (version === renderVersion && error.name !== 'RenderingCancelledException') {
      message('This page could not be displayed. Try another page.');
    }
  }
}

async function openPdf(source) {
  message('Opening PDF…');
  try {
    const engine = await pdfEngine;
    const loadingTask = engine.getDocument({
		rangeChunkSize: 256 * 1024,
		disableStream: true,
		disableAutoFetch: true,
      url: source,
      isEvalSupported: false,
      cMapUrl: pdfModule + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: pdfModule + 'standard_fonts/'
    });
    pdf = await loadingTask.promise;
    updateControls();
    await render();
  } catch {
    message('Could not open ' + decodeURIComponent(source) + '. Check the PDF filename and reload.');
  }
}

function goTo(target) {
  if (!pdf || !Number.isInteger(target) || target < 1 || target > pdf.numPages) return;
  const start = target - (target - 1) % 2;
  if (start === page) {
    pageInput.value = page;
    return;
  }
  const direction = Math.sign(start - page);
  page = start;
  zoomAnchor = null;
  clearTimeout(renderTimer);
  viewport.scrollTo(0, 0);
  updateControls();
  render(direction);
}

function changeZoom(factor, point) {
  if (!pdf) return;
  const newZoom = Math.max(1, Math.min(4, zoom * factor));
  if (newZoom === zoom) return;
  if (sheet.firstElementChild && point && newZoom > 1) {
    const rect = sheet.getBoundingClientRect();
    zoomAnchor = {
      x: point.clientX,
      y: point.clientY,
      xRatio: (point.clientX - rect.left) / rect.width,
      yRatio: (point.clientY - rect.top) / rect.height
    };
  } else {
    zoomAnchor = null;
  }
  zoom = newZoom;
  updateControls();
  renderLater();
}

byId('previous').addEventListener('click', () => goTo(page - 2));
byId('next').addEventListener('click', () => goTo(page + 2));
byId('jump').addEventListener('submit', event => {
  event.preventDefault();
  goTo(Number(pageInput.value));
});
byId('minus').addEventListener('click', () => changeZoom(1 / 1.25));
byId('plus').addEventListener('click', () => changeZoom(1.25));
byId('fit').addEventListener('click', () => changeZoom(0));
viewport.addEventListener('wheel', event => {
  if (!pdf || !event.deltaY) return;
  event.preventDefault();
  changeZoom(event.deltaY < 0 ? 1.14 : 1 / 1.14, event);
}, { passive: false });
viewport.addEventListener('pointerdown', event => {
  if (!pdf || !event.isPrimary || event.button !== 0) return;
  if (zoom > 1 && event.pointerType !== 'mouse') return;
  gesture = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    panning: zoom > 1
  };
  viewport.setPointerCapture(gesture.id);
});
viewport.addEventListener('pointermove', event => {
  if (event.pointerId !== gesture?.id || !gesture.panning) return;
  viewport.scrollBy(gesture.x - event.clientX, gesture.y - event.clientY);
  gesture.x = event.clientX;
  gesture.y = event.clientY;
});
viewport.addEventListener('pointerup', event => {
  if (event.pointerId !== gesture?.id) return;
  const start = gesture;
  gesture = null;
  if (start.panning) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  if (Math.abs(dx) >= 36 && Math.abs(dx) > Math.abs(dy) * 1.25) {
    goTo(page + (dx < 0 ? 2 : -2));
  }
});
viewport.addEventListener('lostpointercapture', () => { gesture = null; });
document.addEventListener('keydown', event => {
  if (event.target.matches('input, select, textarea, button') || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    goTo(page + (event.key === 'ArrowRight' ? 2 : -2));
  }
});
const fullscreen = byId('fullscreen');
fullscreen.hidden = !document.fullscreenEnabled;
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await reader.requestFullscreen();
  } catch {
    message('Fullscreen is unavailable in this browser.');
  }
});
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  fullscreen.setAttribute('aria-pressed', String(active));
  fullscreen.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Fullscreen');
});
new ResizeObserver(renderLater).observe(viewport);
pdfEngine.catch(() => message('The PDF reader could not load. Check your internet connection and reload.'));
openPdf(document.body.dataset.pdf);
