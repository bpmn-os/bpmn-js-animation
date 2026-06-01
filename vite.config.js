import { defineConfig } from 'vite';

// Dev-only config for the example playground (not part of the published package).
// Serves example/index.html and is allowed to read the sibling lib/ + assets/.
export default defineConfig({
  root: 'example',
  server: {
    fs: {
      allow: [ '..' ]
    }
  }
});
