import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Keep fixture traffic separate from any running preview.
export default defineConfig({
  ...base,
  outputDir: './test-results/fixtures',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5187' },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5187',
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: false,
  },
});
