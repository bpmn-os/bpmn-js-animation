import { defineConfig } from 'vite';

// Builds the `demo/` app (the interactive simulator) — the package's sole example app, deployed to
// GitHub Pages. `root: 'demo'` serves demo/index.html; `fs.allow: ['..']` lets it read the sibling
// lib/ + assets/ + examples/. `base` is the gh-pages sub-path (https://bpmn-os.github.io/<repo>/) in
// CI; build output goes to the repo-root dist/ for the Pages workflow to upload.
export default defineConfig({
  root: 'demo',
  base: process.env.GITHUB_ACTIONS ? '/bpmn-js-animation/' : '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true
  },
  server: {
    fs: {
      allow: [ '..' ]
    }
  }
});
