import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(webDir, '..');

const BACKEND = process.env.MDP_BACKEND || 'http://127.0.0.1:8757';


/**
 * 去掉 KaTeX 字体里所有现代浏览器都不需要的 woff / ttf 回退。
 *
 * 依据（实测产物构成）：dist/assets 里 woff2 250KB + woff 296KB + ttf 502KB，
 * 共 1048KB / 59 个字体文件；其中 **798KB / 40 个文件** 是 woff 与 ttf。
 * woff2 自 2016 年起被所有在用的浏览器支持（Chrome/Edge/Firefox/Safari 全系），
 * 保留 woff/ttf 只是历史包袱——它会让产物目录膨胀 27%，并拖慢首次静态托管。
 *
 * 注意：只动 CSS 里的 src 回退链与对应的字体文件，不改任何字形，渲染结果不变。
 * 预览与导出共用同一套字体（导出用的内联 CSS 在 shared/theme.mjs 里同样只保留 woff2）。
 */
function stripLegacyKatexFonts(): Plugin {
  return {
    name: 'mdp-strip-legacy-fonts',
    enforce: 'post',
    generateBundle(_options, bundle) {
      let droppedFiles = 0;
      let savedBytes = 0;
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type === 'asset' && /\.(woff|ttf)$/i.test(name)) {
          savedBytes += typeof item.source === 'string' ? item.source.length : item.source.byteLength;
          delete bundle[name];
          droppedFiles++;
        }
      }
      for (const item of Object.values(bundle)) {
        if (item.type !== 'asset' || !/\.css$/.test(item.fileName)) continue;
        let css = typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8');
        css = css
          .replace(/,\s*url\([^)]+\.woff\)\s*format\("woff"\)/g, '')
          .replace(/,\s*url\([^)]+\.ttf\)\s*format\("truetype"\)/g, '');
        item.source = css;
      }
      if (droppedFiles) {
        this.info(`已移除 ${droppedFiles} 个 woff/ttf 字体文件（省约 ${(savedBytes / 1024).toFixed(0)} KB），只保留 woff2`);
      }
    },
  };
}

export default defineConfig({
  root: webDir,
  base: '/',
  plugins: [react(), tailwindcss(), stripLegacyKatexFonts()],
  resolve: {
    alias: {
      '@shared': path.join(projectRoot, 'shared'),
      '@': path.join(webDir, 'src'),
    },
  },
  build: {
    outDir: path.join(webDir, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // 注意：不要把 @codemirror/language-data 里的**动态** import 归并进固定
        // chunk —— 那会把这些按需加载的语言模式变成首屏必载。只切分静态大依赖。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('katex')) return 'katex';
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) return 'react';
          if (id.includes('markdown-it') || id.includes('highlight.js')) return 'markdown';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    // shared/ 在 web/ 之外，开发服务器需要显式放行工程根目录
    fs: { allow: [projectRoot] },
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/vendor': { target: BACKEND, changeOrigin: true },
      '/render': { target: BACKEND, changeOrigin: true },
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'katex', 'markdown-it', 'highlight.js/lib/common'],
  },
});
