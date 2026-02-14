import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    build: {
        lib: {
            entry: path.resolve(__dirname, 'src/index.ts'),
            name: 'vecal',
            formats: ['es'],
            fileName: () => 'vecal.es.js',
        },
    },
    test: {
        globals: true,
        environment: 'jsdom',
    },
});
