import { gui } from '@opencode/plugin/gui/vite';
import { defineConfig } from 'vite';

// One prebuilt CommonJS file; OpenCode Desktop loads it through the
// ./gui-experimental export. The app provides solid-js and the GUI SDK.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
  },
  plugins: [gui({ entry: 'src/gui.tsx' })],
});
