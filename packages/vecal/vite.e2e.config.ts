import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        outDir: '.e2e-dist',
        emptyOutDir: true,
        rollupOptions: { input: resolve(import.meta.dirname, 'e2e/index.html') },
    },
});
