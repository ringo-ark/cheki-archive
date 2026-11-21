const MAX_SOURCE_PIXELS = 16_000_000;
const MAX_OUTPUT_PIXELS = 12_000_000;
const MAX_SIDE = 8192;

export function isConvex(points) {
  return points.every(([x, y], i) => {
    const [nextX, nextY] = points[(i + 1) % 4];
    const [lastX, lastY] = points[(i + 2) % 4];
    return (nextX - x) * (lastY - nextY) - (nextY - y) * (lastX - nextX) > 0.000001;
  });
}

// Map the unit output rectangle back onto the four source corners in clockwise order.
export function project(points) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = points;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  return (u, v) => {
    const scale = g * u + h * v + 1;
    return [(a * u + b * v + x0) / scale, (d * u + e * v + y0) / scale];
  };
}

function fitScale(width, height, pixels) {
  return Math.min(1, Math.sqrt(pixels / (width * height)), MAX_SIDE / Math.max(width, height));
}

export async function rectify(image, points, ratio, signal) {
  const pixels = points.map(([x, y]) => [x * image.naturalWidth, y * image.naturalHeight]);
  const xs = pixels.map(([x]) => x);
  const ys = pixels.map(([, y]) => y);
  const left = Math.max(0, Math.floor(Math.min(...xs)) - 1);
  const top = Math.max(0, Math.floor(Math.min(...ys)) - 1);
  const sw = Math.min(image.naturalWidth, Math.ceil(Math.max(...xs)) + 1) - left;
  const sh = Math.min(image.naturalHeight, Math.ceil(Math.max(...ys)) + 1) - top;
  const sourceScale = fitScale(sw, sh, MAX_SOURCE_PIXELS);
  const source = document.createElement('canvas');
  const output = document.createElement('canvas');
  try {
    source.width = Math.max(1, Math.floor(sw * sourceScale));
    source.height = Math.max(1, Math.floor(sh * sourceScale));
    const sourceContext = source.getContext('2d', { willReadFrequently: true });
    sourceContext.fillStyle = '#fff';
    sourceContext.fillRect(0, 0, source.width, source.height);
    sourceContext.imageSmoothingQuality = 'high';
    sourceContext.drawImage(image, left, top, sw, sh, 0, 0, source.width, source.height);
    const { data } = sourceContext.getImageData(0, 0, source.width, source.height);
    const corners = pixels.map(([x, y]) => [(x - left) * source.width / sw, (y - top) * source.height / sh]);
    const area = corners.reduce((sum, [x, y], i) => {
      const [nx, ny] = corners[(i + 1) % 4];
      return sum + x * ny - y * nx;
    }, 0) / 2;
    if (area < 16) throw new Error('補正する範囲が小さすぎます。');
    const idealWidth = Math.sqrt(area * ratio);
    const idealHeight = Math.sqrt(area / ratio);
    const scale = fitScale(idealWidth, idealHeight, MAX_OUTPUT_PIXELS);
    const width = output.width = Math.max(1, Math.round(idealWidth * scale));
    const height = output.height = Math.max(1, Math.round(idealHeight * scale));
    const context = output.getContext('2d', { alpha: false });
    const result = context.createImageData(width, height);
    const map = project(corners);
    let deadline = performance.now() + 16;
    for (let y = 0; y < height; y++) {
      if (performance.now() >= deadline) {
        await new Promise(resolve => setTimeout(resolve, 0));
        signal.throwIfAborted();
        deadline = performance.now() + 16;
      }
      for (let x = 0; x < width; x++) {
        const [sx, sy] = map((x + 0.5) / width, (y + 0.5) / height);
        const px = Math.min(source.width - 1, Math.max(0, sx - 0.5));
        const py = Math.min(source.height - 1, Math.max(0, sy - 0.5));
        const ix = Math.floor(px);
        const iy = Math.floor(py);
        const i = (iy * source.width + ix) * 4;
        const right = ix + 1 < source.width ? 4 : 0;
        const down = iy + 1 < source.height ? source.width * 4 : 0;
        const fx = px - ix;
        const fy = py - iy;
        const j = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          const upper = data[i + c] * (1 - fx) + data[i + right + c] * fx;
          const lower = data[i + down + c] * (1 - fx) + data[i + down + right + c] * fx;
          result.data[j + c] = upper * (1 - fy) + lower * fy;
        }
        result.data[j + 3] = 255;
      }
    }
    context.putImageData(result, 0, 0);
    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob || blob.type !== 'image/jpeg') throw new Error('JPEGを作成できませんでした。');
    return { blob, width, height };
  } finally {
    source.width = source.height = output.width = output.height = 0;
  }
}
