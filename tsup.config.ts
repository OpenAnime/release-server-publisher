import { defineConfig } from 'tsup';

export default defineConfig({
    target: 'esnext',
    keepNames: true,
    entry: ['src/index.ts'],
    clean: true,
    format: 'cjs',
    splitting: true,
    minify: true,
    config: 'tsconfig.json',
    dts: true,
});
