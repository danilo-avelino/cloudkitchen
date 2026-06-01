# StockKitchen · dev setup

## Pré-requisitos

- Node.js 20+
- npm 10+

## Primeira vez

```bash
# 1. Instalar dependências
npm install

# 2. Copiar .env.example pra .env.local e preencher
cp .env.example .env.local
# Editar .env.local com VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY
```

## Comandos

| Comando            | O que faz                                              |
|--------------------|--------------------------------------------------------|
| `npm run dev`      | Vite dev server em `http://localhost:5173` com HMR     |
| `npm run build`    | Bundle de produção em `dist/`                          |
| `npm run preview`  | Serve o bundle de produção localmente                  |
| `npm run typecheck`| `tsc --noEmit` (gradual · `strict:false` por enquanto) |

## Estrutura

```
StockKitchen/
├── index.html              # Entry HTML do Vite
├── src/
│   ├── main.jsx           # Entry Vite: injeta globais + monta App
│   └── App.jsx            # Componente raiz
├── *.jsx                   # Arquivos legados (estilo "global scripts" do Babel-standalone)
├── styles.css
├── supabase/              # Schema, edge functions, migrations
├── vite.config.js
├── tsconfig.json
└── .env.local             # Credenciais Supabase (gitignored)
```

## Notas sobre a migração

O projeto está em **transição** do pipeline antigo (Babel-standalone no browser) para
Vite + ES modules. Os arquivos `.jsx` da raiz ainda usam globais (`React`, `useState`,
`MOCK`, `I`…) — o `src/main.jsx` injeta essas referências no `window` pra manter
compatibilidade enquanto a migração avança.

Quando os arquivos forem convertidos pra módulos ES "limpos" (com `import React from 'react'`
e exports nomeados), o bloco de shim no `main.jsx` pode ser removido gradualmente.

## CI

GitHub Actions roda `npm ci` + `typecheck` + `build` em cada push/PR pra `main`.
Configure os secrets `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` no repo
(Settings → Secrets and variables → Actions) pra builds com credenciais reais.

## Edge Functions

Deploy via Supabase CLI:

```bash
supabase login
supabase functions deploy provision-tenant
supabase functions deploy ingest-revenue
supabase functions deploy compute-cmv-daily
```

Ou via MCP do Supabase.
