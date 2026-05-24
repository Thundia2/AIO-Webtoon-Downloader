import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Empty string base means relative paths in built HTML, needed for Electron file:// loading
  base: '',
  build: {
    outDir: 'dist',
  },
});
