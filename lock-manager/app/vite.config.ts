import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA is served through HA Ingress at an arbitrary path depth, so:
// - base must be relative ('./') for assets to resolve
// - the app must not use client-side routing (tabs are in-component state)
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
});