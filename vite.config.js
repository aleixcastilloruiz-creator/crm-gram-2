import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(process.cwd(), 'frontend'),
  plugins: [react()],
  base: '/ui/',
  build: {
    outDir: path.resolve(process.cwd(), 'public/ui'),
    emptyOutDir: true,
  },
});
