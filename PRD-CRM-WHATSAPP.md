# PRD — Módulo CRM/WhatsApp (base: wacrm)

**Data:** 2026-06-22
**Autor:** Danilo (via análise técnica)
**Status:** Proposta / avaliação
**Base de código de referência:** [wacrm](https://github.com/ArnasDon/wacrm) — MIT License

---

## 1. Contexto

Avaliamos o repositório open-source **wacrm** (CRM self-hosted para WhatsApp Business) como
base para um **módulo de CRM/atendimento WhatsApp** dentro do StockKitchen.

A licença é **MIT** — podemos copiar, modificar e usar comercialmente sem restrição (basta
manter o aviso de copyright original nos arquivos derivados). **Não há impeditivo legal.**

O obstáculo é **técnico**: o wacrm é Next.js (App Router, server components, API routes) e o
nosso app é uma **SPA Vite + React** com roteamento por hash, globais no `window`, Babel
standalone em parte do front e multi-tenant via `tenant_members`/`app.has_tenant_role`.
As arquiteturas de **front são incompatíveis**; o **backend (Supabase)** é compatível e
reaproveitável.

### 1.1 O que o wacrm entrega

| Feature | Descrição |
|---|---|
| Inbox compartilhado | Conversas WhatsApp multi-agente, em tempo real |
| Contatos | Tags, campos customizados, notas, dedupe por telefone |
| Pipeline de vendas | Kanban (drag-and-drop) com estágios e deals |
| Broadcasts | Envio em massa com templates aprovados pela Meta |
| Automações no-code | Gatilho → condição → ação |
| Flows | Fluxos conversacionais (botões/listas interativas) |
| Templates | Sync/submissão de templates via Meta Cloud API |
| Multi-conta + RBAC | owner/admin/agent/viewer |
| Segurança | Criptografia AES-256-GCM dos tokens, RLS, verificação de assinatura do webhook |

### 1.2 Tamanho da base (medido)

- ~52.000 LOC TS/TSX no total.
- 25 migrations Supabase = 3.660 LOC SQL (idempotentes, bem comentadas).
- Lib WhatsApp (TS framework-agnóstico, **muito testada**): `meta-api.ts` 1.036, `encryption.ts` 113,
  `phone-utils.ts` 104, `webhook-signature.ts` 47, + dezenas de `*.test.ts`.
- Engines: automações 703, flows 1.117.
- API routes Next.js (cola server-side): 5.545 LOC.

---

## 2. Objetivo

Disponibilizar dentro do StockKitchen a capacidade de **conversar com clientes via WhatsApp,
gerir contatos/leads e disparar broadcasts**, aproveitando ao máximo o trabalho já feito no
wacrm e respeitando o nosso modelo multi-tenant e padrões de segurança Supabase
(seção 5 do CLAUDE.md).

### 2.1 Não-objetivos (primeira entrega)

- Flows conversacionais complexos (deixar para fase posterior).
- Paridade visual 1:1 com o wacrm.
- Migrar histórico de conversas de outra ferramenta.

---

## 3. As duas opções

Apresentamos **duas estratégias de implementação**. Ambas compartilham o **mesmo núcleo de
backend WhatsApp** (seção 6). A diferença está em **onde mora o front e como o usuário acessa**.

### Opção A — Módulo nativo (port completo)

Reescrever o front do wacrm como um **módulo nativo** do StockKitchen (Vite/React, mesmo
padrão das abas atuais), e portar o backend para o nosso schema multi-tenant + edge functions.

```
┌─────────────────────────────────────────────┐
│  StockKitchen SPA (Vite)                      │
│  #/crm  →  Inbox | Contatos | Pipeline | ...  │  ← UI reescrita no nosso padrão
└───────────────┬─────────────────────────────┘
                │ supabase-js (mesmo client/tenant)
        ┌───────▼────────┐
        │  Supabase       │  tabelas crm_* com tenant_id + RLS por módulo
        │  + edge funcs   │  whatsapp-webhook / whatsapp-send / whatsapp-templates
        └───────┬────────┘
                │ Meta Cloud API
            WhatsApp
```

**Prós**
- Experiência unificada: uma aba a mais (`#/crm`), mesmo login, mesmo tenant switcher, mesmo
  visual e RLS por módulo (`can_access_module(tenant,'crm')`).
- Dados no mesmo banco → cruzamento com pedidos/Agilizone/faturamento é trivial.
- Manutenção num só app/deploy.

**Contras**
- Maior esforço: o front (~30k LOC Next/React/TS) precisa ser **reescrito**, não copiado.
- Precisamos reimplementar Kanban (drag-and-drop), inbox realtime, etc. no nosso padrão.

### Opção B — App standalone integrado (SSO + Supabase compartilhado)

Subir o wacrm **quase como está** (Next.js), apontando para **o mesmo projeto Supabase**, e
linká-lo a partir do StockKitchen (item de menu que abre o CRM, idealmente com sessão
compartilhada). Adaptações mínimas: alinhar auth e o conceito de conta↔tenant.

```
┌──────────────────┐      link / iframe / SSO      ┌──────────────────────┐
│ StockKitchen SPA │ ────────────────────────────▶ │ wacrm (Next.js)       │
│  menu: "CRM ↗"   │                                │ deploy próprio         │
└────────┬─────────┘                                └──────────┬───────────┘
         │                                                     │
         └──────────────► Supabase (mesmo projeto) ◀───────────┘
                          auth compartilhada + RLS
```

**Prós**
- **Time-to-value muito menor**: aproveita o front pronto, testado e mantido upstream.
- Acompanha updates do projeto open-source com menos atrito.

**Contras**
- São **dois apps** (dois deploys, dois domínios/builds, dois conjuntos de dependências).
- Auth/sessão compartilhada entre Vite SPA e Next.js exige trabalho (cookies de domínio,
  ou SSO via Supabase) — e o modelo de "account" do wacrm não é o nosso "tenant".
- UX costurada (sai do app, ou iframe); difícil cruzar dados no front.
- Risco de divergência: customizações nossas vs. upstream.

### 3.1 Recomendação

**Opção A** como destino final (é o que vira "módulo de verdade"), mas considerar a
**Opção B como validação/MVP** se a urgência for alta: subir o wacrm standalone para validar
a operação de WhatsApp com a Meta e a aprovação de templates **antes** de investir na reescrita
do front. O **backend WhatsApp (seção 6) é construído uma vez e serve às duas**.

---

## 4. Mapeamento de modelo de dados (wacrm → StockKitchen)

O wacrm já evoluiu de single-user para multi-conta (migration 017: `accounts`,
`account_role_enum` = owner/admin/agent/viewer, função `is_account_member()`).
Isso é **paralelo direto** ao nosso modelo, o que facilita o port.

| wacrm | StockKitchen | Ação no port |
|---|---|---|
| `accounts` / `account_id` | `tenants` / `tenant_id` | Substituir coluna e FKs |
| `is_account_member(account_id, role)` | `app.has_tenant_role(...)` / `app.can_access_module(tenant,'crm')` | Trocar as policies |
| `account_role_enum` | `tenant_members.role` | Mapear papéis (owner/admin→admin; agent/viewer→membro) |
| `profiles.user_id = auth.uid()` | nosso `auth.uid()` + `tenant_members` | Reescrever RLS no nosso padrão |
| tabelas: `contacts`, `tags`, `conversations`, `messages`, `pipelines`, `pipeline_stages`, `deals`, `broadcasts`, `whatsapp_config`, `message_templates`, `automations`, `flows` | prefixar `crm_*` e trocar ownership por `tenant_id` | Reescrever 25 migrations → 1 migration consolidada nossa |

**Regras obrigatórias ao reescrever (CLAUDE.md §5):**
- Toda view em `public` → `WITH (security_invoker = true)`.
- Toda função/trigger → `SET search_path = 'app','public','pg_temp'`.
- RPC `SECURITY DEFINER` exposto → check `auth.uid() IS NULL` + validar `tenant_members.role`.
- GRANTs de `app` e de `public` para `service_role` (CLAUDE.md §5.2/§5.3).
- Rodar `get_advisors` após e confirmar que não regrediu.

---

## 5. Componente compartilhado: núcleo WhatsApp (vale para A e B)

A lib de integração com a Meta é o **ativo mais valioso** do wacrm (o mais caro de construir do
zero) e é **TypeScript framework-agnóstico**, portanto direto para **edge functions (Deno/TS)**:

| Arquivo wacrm | Vira | Esforço |
|---|---|---|
| `lib/whatsapp/meta-api.ts` (1.036 LOC) | helper compartilhado das edge functions | Baixo — quase copiar |
| `lib/whatsapp/encryption.ts` (AES-256-GCM) | idem (Web Crypto no Deno) | Baixo |
| `lib/whatsapp/phone-utils.ts` | idem | Baixo |
| `lib/whatsapp/webhook-signature.ts` | verificação de assinatura no webhook | Baixo |
| `api/whatsapp/webhook/route.ts` | edge fn `whatsapp-webhook` (recebe mensagens) | Médio — reescrever cola |
| `api/whatsapp/send/route.ts` | edge fn `whatsapp-send` | Médio |
| `api/whatsapp/templates/*` | edge fn `whatsapp-templates` (sync/submit) | Médio |
| `api/whatsapp/broadcast/route.ts` | edge fn `whatsapp-broadcast` | Médio |

Padrão já usado no Agilizone ([[project_agilizone_ingest]]): secrets no Vault (RPC
`*_get_secret`), disparo via `pg_net`, header de segredo no header (`x-ingest-secret`).
Aplicar o **mesmo padrão** aqui: token da Meta criptografado/no Vault, webhook validado por
assinatura HMAC da Meta.

### 5.1 Pré-requisitos externos (Meta / WhatsApp Business)

Independente da opção, é preciso (do lado da Meta, fora do código):
- Conta WhatsApp Business + número aprovado.
- App na Meta com **WhatsApp Cloud API**, `phone_number_id`, `waba_id` e token permanente.
- Webhook público (HTTPS) configurado e verificado pela Meta.
- **Templates aprovados** pela Meta para qualquer mensagem ativa (broadcast/automação fora da
  janela de 24h). Aprovação leva tempo → validar cedo (argumento a favor do MVP via Opção B).

---

## 6. Escopo por fases

### Fase 0 — Provisionamento Meta (bloqueante, externo)
- Criar app Meta, número, token permanente, webhook.
- **Verify:** webhook responde ao desafio da Meta; envio de 1 mensagem de teste OK.

### Fase 1 — Núcleo backend WhatsApp (compartilhado A/B)
- Portar `meta-api.ts` + utils para helper de edge function.
- Edge functions: `whatsapp-webhook`, `whatsapp-send`, `whatsapp-templates`.
- Secrets no Vault; verificação de assinatura; GRANTs (§5.2/§5.3).
- **Verify:** mensagem recebida grava em `crm_messages`; mensagem enviada chega no celular;
  `get_advisors` sem regressão.

### Fase 2 — Schema CRM multi-tenant
- 1 migration consolidada: `crm_contacts`, `crm_tags`, `crm_conversations`, `crm_messages`,
  `crm_pipelines`, `crm_stages`, `crm_deals`, `crm_broadcasts`, `crm_whatsapp_config`,
  `crm_templates` — todas com `tenant_id` + RLS via `can_access_module(tenant,'crm')`.
- Registrar o módulo `crm` no controle de acesso.
- **Verify:** RLS testada com 2 tenants (sem vazamento); advisors limpos.

### Fase 3 — Front (decisão A vs B)
- **A:** módulo `#/crm` com sub-abas Inbox / Contatos / Pipeline / Broadcasts no padrão do app
  (globais no `window`, hash routing, guard de duplo-clique nos botões — CLAUDE.md §7).
- **B:** subir wacrm standalone apontando para o mesmo Supabase; alinhar auth conta↔tenant;
  item de menu "CRM ↗".
- **Verify:** usuário logado abre o CRM, vê só os dados do tenant ativo, envia/recebe mensagem.

### Fase 4 — Automações/Broadcasts (incremental)
- Portar engine de automações (703 LOC) e broadcasts para edge functions + cron (`pg_cron`/agendado).
- **Verify:** broadcast com template aprovado entrega para lista de contatos; logs registrados.

### Fase 5 — Flows conversacionais (opcional, posterior)
- Portar engine de flows (1.117 LOC) — maior complexidade; só se houver demanda.

---

## 7. Estimativa de esforço (ordem de grandeza)

| Item | Opção A | Opção B |
|---|---|---|
| Fase 0 (Meta) | igual | igual |
| Fase 1 (backend WhatsApp) | igual | igual |
| Fase 2 (schema multi-tenant) | necessário | parcial (adaptar account↔tenant) |
| Fase 3 (front) | **alto** (reescrita) | **baixo** (deploy + auth) |
| Manutenção contínua | 1 app | 2 apps |
| Time-to-first-message | médio | **rápido** |

> Estimativa fina (em dias) deve sair após a Fase 0, pois depende do tempo de aprovação da Meta
> e da decisão A/B. As Fases 1–2 são pré-requisito comum e podem começar já.

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| Aprovação de templates pela Meta demora | Iniciar Fase 0 cedo; MVP via Opção B para validar |
| Modelo `account` (wacrm) ≠ `tenant` (nosso) | Mapeamento da seção 4; reescrever RLS no nosso padrão |
| RLS mal portada → vazamento entre tenants | Testes com 2 tenants + `get_advisors` (CLAUDE.md §5) |
| Token da Meta exposto | Vault + criptografia (reuso do `encryption.ts`), igual Agilizone |
| Custo de manutenção dobrado (Opção B) | Tratar B como MVP/temporário, A como destino |
| Divergência do upstream (Opção B) | Minimizar customizações no fork; ou ir direto para A |

---

## 9. Decisão pendente

1. **A, B, ou B→A (MVP standalone agora, módulo nativo depois)?**
2. Confirmar quem provisiona a conta Meta/WhatsApp Business (Fase 0 é bloqueante).
3. Prioridade do módulo CRM vs. outras frentes em aberto.

---

## 10. Conformidade legal (MIT)

- Manter o aviso de copyright/licença do wacrm nos arquivos derivados (especialmente se
  copiarmos `meta-api.ts` e libs).
- Sem obrigação de open-source do nosso código (MIT é permissiva).
- Recomendado: arquivo `THIRD-PARTY-NOTICES` citando o wacrm.
