import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    build: {
        lib: {
            entry: path.resolve(__dirname, 'src/main.ts'),
            name: 'vecal',
            fileName: (format) => `vecal.${format}.js`,
        },
    },
    test: {
        globals: true,
        environment: 'jsdom',
    },
});
