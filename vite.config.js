import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Builds the `demo/` app — the package's example app, deployed to GitHub Pages. `root: 'demo'`
// serves the two pages: `index.html` (the interactive simulator) and `playback.html` (the job-shop
// API playback). `fs.allow: ['..']` lets them read the sibling lib/ + assets/ + examples/. `base` is
// the gh-pages sub-path (https://bpmn-os.github.io/<repo>/) in CI; output goes to the repo-root dist/.
export default defineConfig({
  root: 'demo',
  base: process.env.GITHUB_ACTIONS ? '/bpmn-js-animation/' : '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        simulator: resolve(here, 'demo/index.html'),
        playback: resolve(here, 'demo/playback.html')
      }
    }
  },
  server: {
    fs: {
      allow: [ '..' ]
    }
  }
});
