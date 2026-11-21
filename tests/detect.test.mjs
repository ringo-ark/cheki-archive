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

function fixture(corners, { background = 28, paper = 232, reflection = false, dark = false,
  weave = 0, illumination = 0, boxedWriting = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const map = corners && project(corners);
  const box = (x, y, w, h) => [map(x, y), map(x + w, y), map(x + w, y + h), map(x, y + h)];
  const photo = map && box(0.075, 0.055, 0.85, 0.68);
  const writing = map && (dark
    ? [box(0.08, 0.04, 0.06, 0.09), box(0.72, 0.08, 0.07, 0.19),
      box(0.12, 0.88, 0.5, 0.02), box(0.27, 0.8, 0.06, 0.11)]
    : [box(0.07, 0.82, 0.045, 0.11), box(0.12, 0.86, 0.38, 0.025)]);
  const insetFrame = boxedWriting && [
    box(0.04, 0.035, 0.92, 0.013), box(0.04, 0.945, 0.92, 0.013),
    box(0.04, 0.035, 0.012, 0.92), box(0.948, 0.035, 0.012, 0.92),
  ];
  // A wide reflection crosses the upper edge and reduces the contrast on part of it.
  const glare = reflection && box(0.41, -0.13, 0.31, 0.51);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let light = background + weave * Math.sin((x * 2 + y) * Math.PI / 4);
      if (map && inside(px, py, corners)) {
        light = paper;
        if (inside(px, py, photo)) light = dark
          ? 123 + 55 * Math.sin(x / 19) + 34 * Math.cos(y / 27)
          : 63 + 45 * Math.sin(x / 22) + 30 * Math.cos(y / 29);
        if (writing.some(stroke => inside(px, py, stroke))) light = dark ? 230 : 43;
      }
      if (glare && inside(px, py, glare)) light = 251;
      if (insetFrame && insetFrame.some(stroke => inside(px, py, stroke))) light = 230;
      light += illumination * (px / width - py / height);
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
  ['black film with a faint border and bright handwriting', portrait, { background: 23, paper: 31, dark: true }],
  ['black film on woven black fabric of the same brightness', portrait, { background: 32, paper: 32, dark: true, weave: 12 }],
  ['tilted black film on textured fabric with a reflection', [[114, 54], [347, 139], [252, 458], [22, 363]],
    { background: 27, paper: 32, dark: true, weave: 11, reflection: true, illumination: 13 }],
  ['black film close to the image edges', [[49, 10], [330, 19], [354, 479], [28, 488]],
    { background: 29, paper: 34, dark: true, weave: 10, reflection: true }],
  ['black film on a white background', portrait, { background: 238, paper: 27, dark: true }],
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

test('a bright inner photo and white handwriting cannot stand in for an invisible black border', () => {
  assert.equal(detectCorners(fixture(portrait, { background: 29, paper: 29, dark: true })), null);
});

test('a narrow hand-drawn frame cannot replace the film outline', () => {
  assert.equal(detectCorners(fixture(portrait, {
    background: 29, paper: 29, dark: true, boxedWriting: true,
  })), null);
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
