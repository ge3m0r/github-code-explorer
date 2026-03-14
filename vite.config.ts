import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.AI_API_KEY': JSON.stringify(env.AI_API_KEY),
      'process.env.AI_BASE_URL': JSON.stringify(env.AI_BASE_URL ?? ''),
      'process.env.AI_MODEL': JSON.stringify(env.AI_MODEL ?? 'deepseek-chat'),
      'process.env.AI_DRILL_DOWN_MAX_DEPTH': JSON.stringify(env.AI_DRILL_DOWN_MAX_DEPTH ?? '3'),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GITHUB_TOKEN': JSON.stringify(env.GITHUB_TOKEN ?? ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
