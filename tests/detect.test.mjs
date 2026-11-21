import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectCorners } from '../detect.js';
import { isConvex, project } from '../rectify.js';

const width = 384;
const height = 512;
const portrait = [[67, 61], [313, 94], [296, 433], [44, 454]];
const wide = [[45, 127], [326, 77], [358, 324], [77, 379]];
const inside = (x, y, points) => points.every(([ax, ay], i) => {
  const [bx, by] = points[(i + 1) % 4];
  return (bx - ax) * (y - ay) >= (by - ay) * (x - ax);
});

function fixture(corners, { background = 28, paper = 232, reflection = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const map = corners && project(corners);
  const box = (x, y, w, h) => [map(x, y), map(x + w, y), map(x + w, y + h), map(x, y + h)];
  const photo = map && box(0.075, 0.055, 0.85, 0.68);
  const writing = map && [box(0.07, 0.82, 0.045, 0.11), box(0.12, 0.86, 0.38, 0.025)];
  // A wide reflection crosses the upper edge and reduces the contrast on part of it.
  const glare = reflection && box(0.41, -0.13, 0.31, 0.51);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let light = background;
      if (map && inside(px, py, corners)) {
        light = paper;
        if (inside(px, py, photo)) light = 63 + 45 * Math.sin(x / 22) + 30 * Math.cos(y / 29);
        if (writing.some(stroke => inside(px, py, stroke))) light = 43;
      }
      if (glare && inside(px, py, glare)) light = 251;
      light += ((x * 131 + y * 79 + x * y * 17) % 7) - 3;
      const i = (y * width + x) * 4;
      data.set([light, light, light, 255], i);
    }
  }
  return { data, width, height };
}

for (const [label, corners, options] of [
  ['dark background with writing', portrait, {}],
  ['low-contrast white background', portrait, { background: 242, paper: 231 }],
  ['reflection crossing a border on white', portrait, { background: 245, paper: 229, reflection: true }],
  ['bright reflection on a dark background', portrait, { reflection: true }],
  ['rotated landscape film', wide, {}],
]) {
  test(label, () => {
    const detected = detectCorners(fixture(corners, options));
    assert.ok(detected && isConvex(detected), 'expected a clockwise quadrilateral');
    const pixels = detected.map(([x, y]) => [x * width, y * height]);
    assert.ok(corners.every(([x, y]) => inside(x, y, pixels)), 'the original film must stay inside the crop');
    for (const [[x, y], [dx, dy]] of corners.map((corner, i) => [corner, pixels[i]])) {
      assert.ok(Math.hypot(x - dx, y - dy) < 12, 'each handle should stay near its corresponding corner');
    }
  });
}

test('an indistinguishable border triggers manual adjustment', () => {
  assert.equal(detectCorners(fixture(portrait, { background: 232, paper: 232 })), null);
});

test('an image without a card triggers manual adjustment', () => {
  assert.equal(detectCorners(fixture(null)), null);
});

test('the interior photo is not mistaken for a card cut off by the frame', () => {
  assert.equal(detectCorners(fixture([[-43, 44], [306, 94], [280, 461], [-20, 460]])), null);
});

test('two similarly clear cards leave the choice to the user', () => {
  const left = [[22, 92], [164, 105], [161, 334], [19, 320]];
  const right = left.map(([x, y]) => [x + 191, y + 48]);
  const image = fixture(left);
  const other = fixture(right);
  for (let y = 0; y < height; y++) {
    const from = (y * width + 192) * 4;
    const to = (y + 1) * width * 4;
    image.data.set(other.data.subarray(from, to), from);
  }
  assert.equal(detectCorners(image), null);
});
