import { isConvex, rectify } from './rectify.js';
import { ANALYSIS_SIDE } from './detect.js';

const byId = id => document.getElementById(id);
const source = byId('source');
const frame = byId('frame');
const handles = [...frame.querySelectorAll('.handle')];
const correct = byId('correct');
const format = byId('format');
const error = byId('error');
const status = byId('status');
const detectionStatus = byId('detection-status');
const result = byId('result');
const download = byId('download');
const dimensions = byId('dimensions');
const ratios = { mini: 54 / 86, 'mini-landscape': 86 / 54, square: 72 / 86, wide: 108 / 86, 'wide-portrait': 86 / 108 };
let points;
let sourceURL;
let resultURL;
let loadVersion = 0;
let pendingCorrection;
let detectionWorker;

function showError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function clearResult() {
  pendingCorrection?.abort();
  pendingCorrection = undefined;
  correct.disabled = Boolean(detectionWorker);
  correct.textContent = '補正してプレビュー';
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = undefined;
  result.removeAttribute('src');
  result.hidden = true;
  byId('preview-empty').hidden = false;
  download.removeAttribute('href');
  download.setAttribute('aria-disabled', 'true');
  dimensions.textContent = '';
  status.textContent = '';
}

function showPoints() {
  byId('quad').setAttribute('points', points.map(([x, y]) => `${x * 100},${y * 100}`).join(' '));
  handles.forEach((handle, i) => {
    handle.style.left = `${points[i][0] * 100}%`;
    handle.style.top = `${points[i][1] * 100}%`;
  });
}

function resetPoints() {
  stopDetection('manual');
  points = [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]];
  clearResult();
  showError();
  showPoints();
}

function showDetection(state) {
  detectionStatus.dataset.state = state;
  detectionStatus.textContent = {
    running: 'チェキの外側の四隅を検出しています…',
    found: '四隅を自動検出しました。白いフチの外側に合っているか確認してください。',
    missed: '四隅を自動検出できませんでした。丸を動かして、手動で合わせてください。',
    manual: '手動調整中。四隅を白いフチの外側に合わせてください。',
  }[state];
}

function stopDetection(state) {
  if (detectionWorker) {
    detectionWorker.terminate();
    detectionWorker = undefined;
    correct.disabled = false;
  }
  showDetection(state);
}

function startDetection(image) {
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, ANALYSIS_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const worker = detectionWorker = new Worker(new URL('./detection-worker.js', import.meta.url), { type: 'module' });
    correct.disabled = true;
    showDetection('running');
    worker.addEventListener('message', ({ data: detected }) => {
      if (worker !== detectionWorker) return;
      if (detected && isConvex(detected)) {
        points = detected;
        showPoints();
        stopDetection('found');
      } else {
        stopDetection('missed');
      }
    });
    const fallback = () => {
      if (worker === detectionWorker) stopDetection('missed');
    };
    worker.addEventListener('error', fallback);
    worker.addEventListener('messageerror', fallback);
    worker.postMessage(imageData, [imageData.data.buffer]);
  } catch {
    stopDetection('missed');
  } finally {
    canvas.width = canvas.height = 0;
  }
}

async function chooseFile(event) {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const version = ++loadVersion;
  const url = URL.createObjectURL(file);
  try {
    const candidate = new Image();
    candidate.src = url;
    await candidate.decode();
    if (version !== loadVersion) return;
    if (sourceURL) URL.revokeObjectURL(sourceURL);
    source.src = sourceURL = url;
    // Fix the overlay to the actual displayed image, including narrow portrait photos.
    frame.style.setProperty('--image-ratio', candidate.naturalWidth / candidate.naturalHeight);
    byId('editor').hidden = false;
    byId('source-empty').hidden = true;
    resetPoints();
    startDetection(candidate);
  } catch {
    if (version === loadVersion) showError('画像を開けませんでした。端末のカメラ設定でJPEGを選ぶか、別の画像をお試しください。');
  } finally {
    if (url !== sourceURL) URL.revokeObjectURL(url);
  }
}

const clamp = value => Math.max(0, Math.min(1, value));
function movePoint(i, x, y) {
  const next = points.map((point, index) => index === i ? [clamp(x), clamp(y)] : point);
  if (!isConvex(next) || (next[i][0] === points[i][0] && next[i][1] === points[i][1])) return;
  stopDetection('manual');
  points = next;
  clearResult();
  showError();
  showPoints();
}

handles.forEach((handle, i) => {
  let pointer;
  let offsetX;
  let offsetY;
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    if (detectionWorker) stopDetection('manual');
    const bounds = frame.getBoundingClientRect();
    offsetX = (event.clientX - bounds.left) / bounds.width - points[i][0];
    offsetY = (event.clientY - bounds.top) / bounds.height - points[i][1];
    pointer = event.pointerId;
    handle.setPointerCapture(pointer);
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return;
    const bounds = frame.getBoundingClientRect();
    movePoint(i, (event.clientX - bounds.left) / bounds.width - offsetX,
      (event.clientY - bounds.top) / bounds.height - offsetY);
  });
  handle.addEventListener('lostpointercapture', () => { pointer = undefined; });
  handle.addEventListener('keydown', event => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.02 : 0.003;
    movePoint(i, points[i][0] + direction[0] * step, points[i][1] + direction[1] * step);
  });
});

correct.addEventListener('click', async () => {
  clearResult();
  showError();
  const controller = pendingCorrection = new AbortController();
  correct.disabled = true;
  correct.textContent = '補正しています…';
  status.textContent = '画像を補正しています。';
  try {
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    controller.signal.throwIfAborted();
    await source.decode();
    controller.signal.throwIfAborted();
    const { blob, width, height } = await rectify(source, points, ratios[format.value], controller.signal);
    if (controller.signal.aborted) return;
    resultURL = URL.createObjectURL(blob);
    result.src = resultURL;
    result.hidden = false;
    byId('preview-empty').hidden = true;
    dimensions.textContent = `${width} × ${height} px`;
    download.href = resultURL;
    download.download = `cheki-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    download.setAttribute('aria-disabled', 'false');
    status.textContent = '補正が完了しました。プレビューを確認して保存できます。';
  } catch (failure) {
    if (!controller.signal.aborted) {
      showError(failure.message === '補正する範囲が小さすぎます。' ? failure.message :
        '補正できませんでした。別の画像や、より小さい画像をお試しください。');
      status.textContent = '';
    }
  } finally {
    if (pendingCorrection === controller) {
      pendingCorrection = undefined;
      correct.disabled = false;
      correct.textContent = '補正してプレビュー';
    }
  }
});

for (const id of ['camera', 'gallery']) byId(id).addEventListener('change', chooseFile);
byId('reset').addEventListener('click', resetPoints);
format.addEventListener('change', () => {
  clearResult();
  showError();
});
