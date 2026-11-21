// Detection runs on a downscaled copy. All distances below are in analysis pixels.
export const ANALYSIS_SIDE = 512;
const ANGLES = 180;
const RHO_STEP = 1.5;
const VOTE_RANGE = 15;
const EDGE_SHIFTS = [0, -1, 1, -2, 2, -3, 3];
const SAMPLE_COUNT = 24;
const radians = Math.PI / ANGLES;
const cosines = Array.from({ length: ANGLES }, (_, angle) => Math.cos(angle * radians));
const sines = Array.from({ length: ANGLES }, (_, angle) => Math.sin(angle * radians));

function blur(values, width, height, radius) {
  const horizontal = new Float32Array(values.length);
  const output = new Float32Array(values.length);
  const size = 2 * radius + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = values[row] * (radius + 1);
    for (let x = 1; x <= radius; x++) sum += values[row + x];
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / size;
      sum += values[row + Math.min(x + radius + 1, width - 1)] - values[row + Math.max(x - radius, 0)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = horizontal[x] * (radius + 1);
    for (let y = 1; y <= radius; y++) sum += horizontal[y * width + x];
    for (let y = 0; y < height; y++) {
      output[y * width + x] = sum / size;
      sum += horizontal[Math.min(y + radius + 1, height - 1) * width + x] -
        horizontal[Math.max(y - radius, 0) * width + x];
    }
  }
  return output;
}

function collectLines(values, width, height, { gradientThreshold, stepThreshold, limit }) {
  const gx = new Float32Array(values.length);
  const gy = new Float32Array(values.length);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const origin = Math.ceil(Math.hypot(centerX, centerY) / RHO_STEP);
  const stride = 2 * origin + 1;
  const votes = new Float32Array(ANGLES * stride);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const dx = (values[i - width + 1] + 2 * values[i + 1] + values[i + width + 1] -
        values[i - width - 1] - 2 * values[i - 1] - values[i + width - 1]) / 4;
      const dy = (values[i + width - 1] + 2 * values[i + width] + values[i + width + 1] -
        values[i - width - 1] - 2 * values[i - width] - values[i - width + 1]) / 4;
      gx[i] = dx;
      gy[i] = dy;
      const strength = Math.hypot(dx, dy);
      if (strength < gradientThreshold) continue;
      const angle = Math.round(Math.atan2(dy, dx) / radians);
      // Limit the influence of strong but short edges from handwriting and reflections.
      const weight = Math.min(1.35, 1 + (strength - gradientThreshold) / 24);
      for (let offset = -VOTE_RANGE; offset <= VOTE_RANGE; offset++) {
        const direction = angle + offset + ANGLES * 2;
        const bin = direction % ANGLES;
        const rho = Math.round(((x - centerX) * cosines[bin] + (y - centerY) * sines[bin]) / RHO_STEP);
        // Opposing transitions cancel, so fine texture and thin stripes cast fewer net votes.
        const sign = Math.floor(direction / ANGLES) % 2 === 0 ? 1 : -1;
        votes[bin * stride + origin + rho] += sign * weight;
      }
    }
  }

  const lines = [];
  const minVotes = Math.max(12, Math.min(width, height) * 0.055);
  for (let index = 0; index < limit; index++) {
    let peak = -1;
    let max = minVotes;
    for (let i = 0; i < votes.length; i++) {
      const support = Math.abs(votes[i]);
      if (support > max) {
        max = support;
        peak = i;
      }
    }
    if (peak < 0) break;
    const angle = Math.floor(peak / stride);
    const rho = peak % stride - origin;
    const x = cosines[angle];
    const y = sines[angle];
    lines.push({ x, y, rho: rho * RHO_STEP + x * centerX + y * centerY });
    // The normal reverses sign when the angle wraps around 180 degrees.
    for (let offset = -4; offset <= 4; offset++) {
      const bin = (angle + offset + ANGLES) % ANGLES;
      const column = origin + (bin === angle + offset ? rho : -rho);
      const row = bin * stride;
      votes.fill(0, row + Math.max(0, column - 3), row + Math.min(stride, column + 4));
    }
  }
  return { values, gx, gy, gradientThreshold, stepThreshold, lines };
}

function analyze(data, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const tone = blur(gray, width, height, 1);
  // A textured dark background can have the same mean luminance as a smooth dark rim.
  const highFrequency = gray.map((value, i) => 3 * Math.min(9, Math.abs(value - tone[i])));
  const texture = blur(highFrequency, width, height, 3);
  const features = [
    collectLines(tone, width, height, { gradientThreshold: 2.3, stepThreshold: 4.5, limit: 30 }),
    collectLines(texture, width, height, { gradientThreshold: 1.4, stepThreshold: 3.5, limit: 16 }),
  ];
  return { tone, features, lines: features.flatMap(feature => feature.lines) };
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

function traceSide(x, y, dx, dy, length, sample, image, innerOffset) {
  const nx = -dy / length;
  const ny = dx / length;
  const rim = [];
  const evidence = [[], []];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const t = 0.08 + i * 0.84 / (SAMPLE_COUNT - 1);
    const sx = x + t * dx;
    const sy = y + t * dy;
    const inside = sample(sx + nx * 5, sy + ny * 5);
    const outside = sample(sx - nx * 5, sy - ny * 5);
    rim.push(image.tone[sample(sx + nx * innerOffset, sy + ny * innerOffset)]);
    for (const [channel, feature] of image.features.entries()) {
      const step = feature.values[inside] - feature.values[outside];
      let match = 0;
      if (Math.abs(step) >= feature.stepThreshold) {
        for (const shift of EDGE_SHIFTS) {
          const edge = sample(sx + nx * shift, sy + ny * shift);
          const normal = feature.gx[edge] * nx + feature.gy[edge] * ny;
          const tangent = Math.abs(feature.gy[edge] * nx - feature.gx[edge] * ny);
          if (normal * Math.sign(step) >= Math.max(feature.gradientThreshold, tangent * 1.3)) {
            const center = (feature.values[inside] + feature.values[outside]) / 2;
            const balance = Math.min(0.5, Math.abs(feature.values[edge] - center) / Math.abs(step));
            const accuracy = 1 - Math.abs(shift) * 0.12 - balance * 0.7;
            if (accuracy > Math.abs(match)) match = Math.sign(step) * accuracy;
          }
        }
      }
      evidence[channel].push(match);
    }
  }

  // Require a sustained transition on each side. The two features can cover
  // different sections of the same edge, for example where glare masks texture.
  const coherent = evidence.map(samples => {
    const positive = samples.filter(value => value > 0).length;
    const negative = samples.filter(value => value < 0).length;
    const sign = positive >= negative ? 1 : -1;
    return samples.map(value => Math.max(0, value * sign));
  });
  const strength = coherent[0].map((value, i) => value || coherent[1][i] * 0.75);
  const count = values => values.filter(value => value > 0).length;
  const coverage = count(strength);
  if (coverage < SAMPLE_COUNT * 0.49 || count(strength.slice(0, 6)) < 2 ||
      count(strength.slice(-6)) < 2) return null;
  return { coverage, precision: strength.reduce((sum, value) => sum + value, 0), rim };
}

function rimContinuity(sides) {
  // Look for a shared rim material in the inner strip, allowing for decorations
  // and highlights. Its color may be dark or light.
  const tones = sides.flatMap(side => side.rim);
  const bins = new Uint8Array(32);
  for (const tone of tones) bins[Math.min(31, Math.floor(tone / 8))]++;
  let dominant = 4;
  let most = 0;
  for (let i = 0; i < bins.length; i++) {
    const count = (bins[i - 1] ?? 0) + bins[i] + (bins[i + 1] ?? 0);
    if (count > most) {
      dominant = i * 8 + 4;
      most = count;
    }
  }
  const matches = sides.map(side => side.rim.filter(tone => Math.abs(tone - dominant) <= 16).length);
  if (Math.min(...matches) < SAMPLE_COUNT * 0.34) return 0;
  return matches.reduce((sum, count) => sum + count, 0) / tones.length;
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
  if (ratio < 1 / 2.15 || ratio > 2.15) return null;

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

  const innerOffset = Math.max(5, Math.min(9, minLength * 0.042));
  const sample = (x, y) =>
    Math.max(0, Math.min(height - 1, Math.round(y))) * width +
    Math.max(0, Math.min(width - 1, Math.round(x)));
  const sides = [];
  for (const [i, [x, y]] of points.entries()) {
    const [dx, dy] = edges[i];
    const side = traceSide(x, y, dx, dy, lengths[i], sample, image, innerOffset);
    if (!side) return null;
    sides.push(side);
  }
  const coverage = sides.reduce((sum, side) => sum + side.coverage, 0) / (4 * SAMPLE_COUNT);
  const precision = sides.reduce((sum, side) => sum + side.precision, 0) / (4 * SAMPLE_COUNT);
  const continuity = rimContinuity(sides);
  if (coverage < 0.7 || continuity < 0.64) return null;
  return { area, score: coverage + 0.48 * precision + 0.25 * continuity + 0.29 * area };
}

function encloses(outer, inner) {
  if (outer.area < inner.area * 1.09) return false;
  return outer.points.every(([x, y], i) => {
    const [nx, ny] = outer.points[(i + 1) % 4];
    const dx = nx - x;
    const dy = ny - y;
    const tolerance = 4 * Math.hypot(dx, dy);
    return inner.points.every(([ix, iy]) => dx * (iy - y) - dy * (ix - x) >= -tolerance);
  });
}

function padCorners(points, width, height) {
  const padding = Math.max(2, Math.min(width, height) * 0.011);
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
  const image = analyze(data, width, height);
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
      const evidence = evaluate(points, image, width, height, shortSide);
      if (evidence) candidates.push({ points: orderCorners(points), ...evidence });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const [strongest] = candidates;
  if (!strongest) return null;
  // Prefer an independently supported enclosing contour over the photo window.
  const best = candidates.find(candidate => candidate.score >= strongest.score - 0.19 &&
    encloses(candidate, strongest)) ?? strongest;
  // If comparably strong contours disagree by more than the safety margin, ask the user.
  const ambiguous = candidates.some(candidate => {
    if (best.score - candidate.score >= 0.08 || encloses(best, candidate)) return false;
    const displaced = candidate.points.filter(([x, y], i) =>
      Math.hypot(x - best.points[i][0], y - best.points[i][1]) > shortSide * 0.08);
    return displaced.length >= 2;
  });
  return ambiguous ? null : padCorners(best.points, width, height);
}
