// StockKitchen · entry Vite
//
// Migração mínima do pipeline Babel-standalone legado: cada arquivo .jsx da raiz
// foi escrito assumindo globais (React, useState, supabase, MOCK, I…). Em vez de
// converter tudo pra módulos ES de uma vez (centenas de edits), este entry:
//
//   1. Injeta React + hooks + Supabase no window (compatibilidade com `React.useState` etc.)
//   2. Define `SK_CONFIG` a partir de import.meta.env (substitui config.local.js)
//   3. *Dynamically* importa cada .jsx em ordem — DEPOIS dos passos 1-2,
//      pois `import` estático é içado e rodaria antes
//   4. Monta o <App /> no #root

import React from "react";
import * as ReactDOMClient from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import * as Supabase from "@supabase/supabase-js";

// Globais que os arquivos legados esperam.
// `react-dom/client` só expõe createRoot/hydrateRoot; createPortal vive em `react-dom`
// — espalhamos os dois no mesmo objeto pra manter compat com o uso legado de ReactDOM.createPortal.
window.React        = React;
window.ReactDOM     = { ...ReactDOMClient, createPortal, flushSync };
window.supabase     = Supabase;

// Hooks como globais (legados usam `useState(...)` direto, sem destructuring)
window.useState        = React.useState;
window.useEffect       = React.useEffect;
window.useMemo         = React.useMemo;
window.useCallback     = React.useCallback;
window.useRef          = React.useRef;
window.useReducer      = React.useReducer;
window.useContext      = React.useContext;
window.useLayoutEffect = React.useLayoutEffect;
window.createElement   = React.createElement;
window.Fragment        = React.Fragment;

// SK_CONFIG vem de .env.local (VITE_*) — substitui o antigo config.local.js
window.SK_CONFIG = {
  supabaseUrl:     import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  appVersion:      import.meta.env.VITE_APP_VERSION || "dev",
};

if (!window.SK_CONFIG.supabaseUrl || !window.SK_CONFIG.supabaseAnonKey) {
  console.error(
    "[stockkitchen] VITE_SUPABASE_URL ou VITE_SUPABASE_ANON_KEY não definidas. " +
    "Copie .env.example para .env.local e preencha."
  );
}

// Dynamic imports — executam SEQUENCIAL e DEPOIS dos assigns acima.
// Cada arquivo faz `window.Foo = Foo` no fim, então funcionam como side-effect.
async function bootstrap() {
  await import("../icons.jsx");
  await import("../data.jsx");
  await import("../widgets.jsx");
  await import("../lib-supabase.jsx");
  await import("../tweaks-panel.jsx");
  await import("../shell.jsx");
  await import("../page-login.jsx");
  await import("../page-superadmin.jsx");
  await import("../page-dashboard.jsx");
  await import("../page-inventory.jsx");
  await import("../page-stock.jsx");
  await import("../page-recipes.jsx");
  await import("../page-revenue.jsx");
  await import("../page-requests.jsx");
  await import("../page-purchases.jsx");
  await import("../page-shopping.jsx");
  await import("../page-cmv.jsx");
  await import("../page-finance.jsx");
  await import("../page-conciliacao.jsx");
  await import("../page-dre.jsx");
  await import("../page-settings.jsx");

  const { App } = await import("./App.jsx");
  ReactDOMClient.createRoot(document.getElementById("root")).render(<App />);
}

bootstrap().catch((e) => {
  console.error("[stockkitchen] falha no bootstrap:", e);
  document.getElementById("root").innerHTML = `
    <div style="padding:32px;font-family:sans-serif;color:#f87171">
      <h2>Erro ao iniciar o app</h2>
      <pre style="background:#1a1a1a;padding:16px;border-radius:4px;overflow:auto">${e.stack || e.message || e}</pre>
    </div>
  `;
});
