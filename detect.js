// Detection runs on a downscaled copy. All distances below are in analysis pixels.
export const ANALYSIS_SIDE = 512;
const ANGLES = 180;
const RHO_STEP = 1.5;
const VOTE_RANGE = 15;
const MAX_LINES = 40;
const SAMPLE_COUNT = 24;
const radians = Math.PI / ANGLES;
const cosines = Array.from({ length: ANGLES }, (_, angle) => Math.cos(angle * radians));
const sines = Array.from({ length: ANGLES }, (_, angle) => Math.sin(angle * radians));

function findLines(data, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const gx = new Float32Array(gray.length);
  const gy = new Float32Array(gray.length);
  const stride = 2 * Math.ceil(Math.hypot(width, height) / RHO_STEP) + 1;
  const origin = (stride - 1) / 2;
  const votes = new Float32Array(ANGLES * stride);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const dx = (gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1] -
        gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1]) / 4;
      const dy = (gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1] -
        gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1]) / 4;
      gx[i] = dx;
      gy[i] = dy;
      const strength = Math.hypot(dx, dy);
      if (strength < 5) continue;
      const angle = Math.round(Math.atan2(dy, dx) / radians);
      // Saturate edge strength so dark writing or glare cannot outvote a long faint border.
      const weight = Math.min(2, 1 + (strength - 5) / 30);
      for (let offset = -VOTE_RANGE; offset <= VOTE_RANGE; offset++) {
        const bin = (angle + offset + ANGLES * 2) % ANGLES;
        const rho = Math.round((x * cosines[bin] + y * sines[bin]) / RHO_STEP);
        votes[bin * stride + origin + rho] += weight;
      }
    }
  }

  const lines = [];
  const minVotes = Math.max(12, Math.min(width, height) * 0.055);
  for (let index = 0; index < MAX_LINES; index++) {
    let peak = -1;
    let max = minVotes;
    for (let i = 0; i < votes.length; i++) {
      if (votes[i] > max) {
        max = votes[i];
        peak = i;
      }
    }
    if (peak < 0) break;
    const angle = Math.floor(peak / stride);
    const rho = peak % stride - origin;
    lines.push({ x: cosines[angle], y: sines[angle], rho: rho * RHO_STEP });
    // The normal reverses sign when the angle wraps around 180 degrees.
    for (let offset = -4; offset <= 4; offset++) {
      const bin = (angle + offset + ANGLES) % ANGLES;
      const column = origin + (bin === angle + offset ? rho : -rho);
      const row = bin * stride;
      votes.fill(0, row + Math.max(0, column - 3), row + Math.min(stride, column + 4));
    }
  }
  return { gray, gx, gy, lines };
}

function intersect(a, b) {
  const determinant = a.x * b.y - a.y * b.x;
  return [(a.rho * b.y - b.rho * a.y) / determinant, (a.x * b.rho - b.x * a.rho) / determinant];
}

const alignment = (a, b) => Math.abs(a.x * b.x + a.y * b.y);

function orderCorners(points) {
  // The two most horizontal opposite edges determine which handles are on top.
  const horizontal = (a, b) => Math.abs(b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
  const [a, b, c, d] = points;
  if (horizontal(a, b) + horizontal(c, d) < horizontal(b, c) + horizontal(d, a)) {
    points = [b, c, d, a];
  }
  if (points[0][1] + points[1][1] > points[2][1] + points[3][1]) {
    points = [points[2], points[3], points[0], points[1]];
  }
  return points;
}

function evaluate(points, image, width, height, shortSide) {
  const edges = points.map(([x, y], i) => {
    const [nx, ny] = points[(i + 1) % 4];
    return [nx - x, ny - y];
  });
  const lengths = edges.map(([x, y]) => Math.hypot(x, y));
  const minLength = Math.min(...lengths);
  if (minLength < shortSide * 0.16 || Math.max(...lengths) > minLength * 3) return null;
  const ratio = (lengths[0] + lengths[2]) / (lengths[1] + lengths[3]);
  if (ratio < 1 / 2.4 || ratio > 2.4) return null;

  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [x, y] = points[i];
    const [dx, dy] = edges[i];
    const [nx, ny] = edges[(i + 1) % 4];
    if (dx * ny - dy * nx < 0.58 * lengths[i] * lengths[(i + 1) % 4]) return null;
    area += x * dy - y * dx;
  }
  area /= 2 * width * height;
  if (area < 0.075) return null;

  const { gray, gx, gy } = image;
  const innerOffset = Math.max(5, Math.min(9, minLength * 0.045));
  const sample = (x, y) =>
    Math.max(0, Math.min(height - 1, Math.round(y))) * width +
    Math.max(0, Math.min(width - 1, Math.round(x)));
  let coverage = 0;
  let precision = 0;
  let brightness = 0;
  for (let side = 0; side < 4; side++) {
    const [x, y] = points[side];
    const [dx, dy] = edges[side];
    const nx = -dy / lengths[side];
    const ny = dx / lengths[side];
    let supported = 0;
    let nearStart = 0;
    let nearEnd = 0;
    let light = 0;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const t = 0.08 + i * 0.84 / (SAMPLE_COUNT - 1);
      const sx = x + t * dx;
      const sy = y + t * dy;
      const inner = gray[sample(sx + nx * innerOffset, sy + ny * innerOffset)];
      if (inner >= 148) light++;
      for (const shift of [0, -1, 1, -2, 2]) {
        const edge = sample(sx + nx * shift, sy + ny * shift);
        const normal = Math.abs(gx[edge] * nx + gy[edge] * ny);
        const tangent = Math.abs(gy[edge] * nx - gx[edge] * ny);
        if (normal >= 6 && normal >= tangent * 1.4) {
          supported++;
          precision += 1 - Math.abs(shift) / 3;
          if (i < 6) nearStart++;
          if (i >= SAMPLE_COUNT - 6) nearEnd++;
          break;
        }
      }
    }
    if (supported < SAMPLE_COUNT * 0.46 || nearStart < 2 || nearEnd < 2 || light < SAMPLE_COUNT * 0.46) return null;
    coverage += supported;
    brightness += light;
  }
  if (coverage < 4 * SAMPLE_COUNT * 0.68 || brightness < 4 * SAMPLE_COUNT * 0.7) return null;
  // Give a modest advantage to the enclosing contour over similarly supported inner lines.
  return (coverage + 0.25 * precision + 0.3 * brightness) / (4 * SAMPLE_COUNT) + 0.45 * area;
}

function padCorners(points, width, height) {
  const padding = Math.max(2, Math.min(width, height) * 0.009);
  const lines = points.map(([x, y], i) => {
    const [nx, ny] = points[(i + 1) % 4];
    const length = Math.hypot(nx - x, ny - y);
    const normalX = (ny - y) / length;
    const normalY = (x - nx) / length;
    return { x: normalX, y: normalY, rho: normalX * x + normalY * y + padding };
  });
  return points.map((_, i) => {
    const [x, y] = intersect(lines[(i + 3) % 4], lines[i]);
    // Gradients are indexed at pixel centers. The crop uses image-edge coordinates.
    return [Math.min(1, Math.max(0, (x + 0.5) / width)), Math.min(1, Math.max(0, (y + 0.5) / height))];
  });
}

export function detectCorners({ data, width, height }) {
  const shortSide = Math.min(width, height);
  if (shortSide < 48) return null;
  const image = findLines(data, width, height);
  const pairs = [];
  for (const [i, a] of image.lines.entries()) {
    for (const b of image.lines.slice(i + 1)) {
      if (alignment(a, b) >= 0.8) pairs.push([a, b]);
    }
  }

  const candidates = [];
  for (let i = 0; i < pairs.length; i++) {
    const [a, c] = pairs[i];
    for (let j = i + 1; j < pairs.length; j++) {
      const [b, d] = pairs[j];
      if (Math.max(alignment(a, b), alignment(b, c), alignment(c, d), alignment(d, a)) > 0.8) continue;
      let points = [intersect(a, b), intersect(b, c), intersect(c, d), intersect(d, a)];
      if (points.some(([x, y]) => x < 2 || x > width - 3 || y < 2 || y > height - 3)) continue;
      if (points[0][0] * (points[1][1] - points[2][1]) +
          points[1][0] * (points[2][1] - points[0][1]) +
          points[2][0] * (points[0][1] - points[1][1]) < 0) points.reverse();
      const score = evaluate(points, image, width, height, shortSide);
      if (score !== null) candidates.push({ points: orderCorners(points), score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const [best] = candidates;
  if (!best) return null;
  // If comparably strong contours disagree by more than the safety margin, ask the user.
  const ambiguous = candidates.some(({ points, score }) => best.score - score < 0.08 &&
    points.filter(([x, y], i) => Math.hypot(x - best.points[i][0], y - best.points[i][1]) > shortSide * 0.08).length >= 2);
  return ambiguous ? null : padCorners(best.points, width, height);
}
