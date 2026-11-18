const pdfModule = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
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
let webPages;
let webFolder;
let nextPreview = 0;
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

function spreadStart(number, total) {
  if (number === 1 || number === total) return number;
  return number - number % 2;
}

function spreadPages(start, total) {
  if (start === 1 || start + 1 >= total) return [start];
  return [start, start + 1];
}

function turnSpread(direction) {
  if (!pdf) return;
  const target = direction < 0 ? page - 1 : spreadPages(page, pdf.numPages).at(-1) + 1;
  goTo(target);
}

function updateControls() {
  for (const id of controls) byId(id).disabled = !pdf;
  byId('previous').disabled = !pdf || page === 1;
  byId('next').disabled = !pdf || page === pdf.numPages;
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
    const numbers = spreadPages(page, pdf.numPages);
    const pdfPages = webPages ? null : await Promise.all(numbers.map(number => pdf.getPage(number)));
    if (version !== renderVersion) return;
    const dimensions = webPages
      ? numbers.map(number => webPages[number - 1])
      : pdfPages.map(pdfPage => pdfPage.getViewport({ scale: 1 }));
    const totalWidth = dimensions.reduce((sum, view) => sum + view.width, 0);
    const maxHeight = Math.max(...dimensions.map(view => view.height));
    const style = getComputedStyle(viewport);
    const width = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const scale = Math.max(0.01, Math.min(width / totalWidth, height / maxHeight)) * zoom;
    const previews = [];
    const canvases = dimensions.map((dimension, index) => {
      const view = { width: dimension.width * scale, height: dimension.height * scale };
      const density = Math.min(devicePixelRatio || 1, 4096 / Math.max(view.width, view.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(view.width * density));
      canvas.height = Math.max(1, Math.floor(view.height * density));
      canvas.style.width = view.width + 'px';
      canvas.style.height = view.height + 'px';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Page ' + numbers[index] + ' of ' + pdf.numPages);
      if (webPages) {
        previews.push(loadImage(numbers[index], 'preview').then(image => {
          if (version === renderVersion) paintImage(canvas, image);
        }));
      } else renderTasks.push(pdfPages[index].render({
        canvasContext: canvas.getContext('2d'),
        viewport: pdfPages[index].getViewport({ scale }),
        transform: [canvas.width / view.width, 0, 0, canvas.height / view.height, 0, 0]
      }));
      return canvas;
    });
    await Promise.all([...previews, ...renderTasks.map(task => task.promise)]);
    if (version !== renderVersion) return;
    renderTasks = [];
    const outgoing = direction && zoom === 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches
      ? [...sheet.querySelectorAll(':scope > canvas')].map(canvas => ({
        canvas,
        rect: canvas.getBoundingClientRect()
      }))
      : [];
    sheet.classList.toggle('open-book', canvases.length === 2);
    sheet.classList.toggle('closed-book', canvases.length === 1);
    sheet.style.setProperty('--binding-x', canvases[0].style.width);
    sheet.replaceChildren(...canvases);
    if (outgoing.length) animateTurn(outgoing, canvases, direction);
    message();
    if (webPages && zoom > 1) {
      numbers.forEach((number, index) => {
        loadImage(number, 'detail').then(image => {
          if (version === renderVersion) paintImage(canvases[index], image);
        }).catch(() => {});
      });
    }
    if (webPages && zoom === 1 && page < pdf.numPages && page !== nextPreview) {
      nextPreview = page;
      for (const number of spreadPages(numbers.at(-1) + 1, pdf.numPages)) {
        loadImage(number, 'preview', 'low').catch(() => {});
      }
    }
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

function animateTurn(outgoing, incoming, direction) {
  const forward = direction > 0;
  const turning = outgoing[forward ? outgoing.length - 1 : 0];
  const destination = incoming[forward ? 0 : incoming.length - 1];
  const stationary = outgoing.length === 2 ? outgoing[forward ? 0 : 1] : null;
  const sheetRect = sheet.getBoundingClientRect();
  const end = destination.getBoundingClientRect();
  const start = turning.rect;
  const startHinge = forward ? start.left : start.right;
  const endHinge = forward ? end.right : end.left;
  const options = { duration: 620, easing: 'cubic-bezier(.32,.12,.34,1)', fill: 'both' };
  const overlay = document.createElement('div');
  overlay.className = 'turn-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = true;

  function place(element, rect) {
    element.style.left = rect.left - sheetRect.left + 'px';
    element.style.top = rect.top - sheetRect.top + 'px';
    element.style.width = rect.width + 'px';
    element.style.height = rect.height + 'px';
  }

  if (stationary) {
    const rest = document.createElement('div');
    rest.className = 'turn-rest';
    place(rest, stationary.rect);
    rest.append(stationary.canvas);
    overlay.append(rest);
  }

  const leaf = document.createElement('div');
  leaf.className = 'turn-leaf';
  leaf.style.transformOrigin = forward ? 'left center' : 'right center';
  place(leaf, start);
  turning.canvas.classList.add('turn-front');
  const back = document.createElement('canvas');
  back.className = 'turn-back';
  back.width = destination.width;
  back.height = destination.height;
  back.getContext('2d').drawImage(destination, 0, 0);
  leaf.append(turning.canvas, back);
  overlay.append(leaf);
  sheet.append(overlay);

  const conceal = destination.animate([{ opacity: 0 }, { opacity: 0 }], options);
  const motion = leaf.animate([
    { transform: 'translate(0px, 0px) rotateY(0deg) scale(1, 1)' },
    { transform: 'translate(' + (endHinge - startHinge) + 'px, ' +
      (end.top - start.top + (end.height - start.height) / 2) + 'px) rotateY(' +
      (forward ? -180 : 180) + 'deg) scale(' +
      end.width / start.width + ', ' + end.height / start.height + ')' }
  ], options);
  const finish = () => {
    conceal.cancel();
    overlay.remove();
  };
  motion.finished.then(finish, finish);
}

function loadImage(number, size, priority = 'auto') {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.fetchPriority = priority;
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = new URL(size + '/' + number + '.webp', webFolder).href;
  });
}

function paintImage(canvas, image) {
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
}

async function openBook(source) {
  const folder = new URL(source.replace(/\.pdf$/i, '') + '/', location.href);
  try {
    const response = await fetch(new URL('pages.json', folder));
    if (!response.ok) throw new Error('Preview unavailable');
    const pages = await response.json();
    if (!Array.isArray(pages) || !pages.length || !pages.every(
      page => Number.isFinite(page?.width) && page.width > 0 &&
        Number.isFinite(page?.height) && page.height > 0
    )) throw new Error('Invalid page manifest');
    webFolder = folder;
    webPages = pages;
    pdf = { numPages: pages.length };
    updateControls();
    await render();
  } catch {
    await openPdf(source);
  }
}

async function openPdf(source) {
  message('Opening PDF…');
  try {
    const engine = await import(pdfModule + 'build/pdf.mjs');
    engine.GlobalWorkerOptions.workerSrc = pdfModule + 'build/pdf.worker.mjs';
    const loadingTask = engine.getDocument({
      url: source,
      // Fetch visible-page data in larger ranges without downloading ahead.
      rangeChunkSize: 256 * 1024,
      disableStream: true,
      disableAutoFetch: true,
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
  const start = spreadStart(target, pdf.numPages);
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

byId('previous').addEventListener('click', () => turnSpread(-1));
byId('next').addEventListener('click', () => turnSpread(1));
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
    turnSpread(dx < 0 ? 1 : -1);
  }
});
viewport.addEventListener('lostpointercapture', () => { gesture = null; });
document.addEventListener('keydown', event => {
  if (event.target.matches('input, select, textarea, button') || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    turnSpread(event.key === 'ArrowRight' ? 1 : -1);
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
openBook(document.body.dataset.pdf);
