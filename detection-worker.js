import { detectCorners } from './detect.js';

self.addEventListener('message', ({ data }) => {
  self.postMessage(detectCorners(data));
});
