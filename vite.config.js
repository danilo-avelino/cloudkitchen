import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite config — substitui o pipeline Babel-standalone do StockKitchen.html legado.
// Os arquivos *.jsx existentes ainda usam globais (window.Foo, MOCK, I, useState…),
// então a migração é mínima: src/main.jsx faz dynamic imports na ordem certa
// depois de injetar React e seus hooks no window. Adicionalmente, o plugin
// `injectLegacyGlobals` prepende declarações `const React = window.React` em cada
// .jsx fora de src/ pra que `React.useState`/`useState(...)` funcionem em strict mode.

const LEGACY_PRELUDE = `
const React = window.React;
const ReactDOM = window.ReactDOM;
const supabase = window.supabase;
const { useState, useEffect, useMemo, useCallback, useRef, useReducer, useContext, useLayoutEffect, createElement, Fragment } = React;
`;

// Componentes expostos em widgets.jsx — consumidores legados usam o identificador solto.
const LEGACY_WIDGET_IMPORTS = `
const SummaryStat = window.SummaryStat;
`;

function injectLegacyGlobals() {
  const rootDir = path.resolve(".");
  return {
    name: "inject-legacy-globals",
    enforce: "pre",
    transform(code, id) {
      // Só arquivos .jsx FORA de src/ (os legados na raiz)
      const normalized = id.split("?")[0].replace(/\\/g, "/");
      if (!normalized.endsWith(".jsx")) return null;
      if (normalized.includes("/src/")) return null;
      if (!normalized.startsWith(rootDir.replace(/\\/g, "/"))) return null;
      const isWidgets = normalized.endsWith("/widgets.jsx");
      return {
        code: LEGACY_PRELUDE + (isWidgets ? "" : LEGACY_WIDGET_IMPORTS) + code,
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), injectLegacyGlobals()],
  esbuild: {
    loader: "jsx",
    include: /\.(jsx?|tsx?)$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: { ".js": "jsx" },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
