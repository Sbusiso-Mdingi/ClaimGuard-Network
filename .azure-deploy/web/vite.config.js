import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));
const appSrcRoot = resolve(configDir, '../../apps/web/src');
const deployDistRoot = resolve(configDir, 'dist');

export default defineConfig({
  root: appSrcRoot,
  build: {
    outDir: deployDistRoot,
    emptyOutDir: true,
  },
});
