# CLAUDE.md — StockKitchen

Diretrizes para qualquer mudança neste repo. Foco em **segurança Supabase multi-tenant** (lições da auditoria de 2026-05-27 que reduziu 130 advisor lints → 3 WARNs).

---

## Checklist obrigatório por tipo de objeto

### 🆕 Nova tabela em `public`

- [ ] `ENABLE ROW LEVEL SECURITY` na criação (não deixe pra depois)
- [ ] Pelo menos uma policy por operação: `SELECT`, `INSERT`, `UPDATE`, `DELETE`
- [ ] **Toda tabela operacional precisa ter `tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE`**
- [ ] Policies filtram por `tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid())` ou helper equivalente
- [ ] Se há FK cross-tabela (ex: `supplier_id` → `suppliers.id`), criar trigger `tg_check_*_tenant` em `app` para impedir mistura de tenants

```sql
ALTER TABLE public.minha_tabela ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_select" ON public.minha_tabela
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid()));
-- + INSERT / UPDATE / DELETE análogas (UPDATE/DELETE com WITH CHECK também)
```

### 🆕 Nova VIEW em `public`

- [ ] **Sempre** `WITH (security_invoker = true)`. Sem isso a view roda com privilégios do owner (postgres) e **bypassa RLS** das tabelas-base.
- [ ] Se a view toca `auth.users`, `auth.identities` ou qualquer coluna sensível: `REVOKE SELECT FROM anon` explicitamente.
- [ ] Não usar `SECURITY DEFINER` em views (advisor flagga).

```sql
CREATE VIEW public.v_minha_view
  WITH (security_invoker = true) AS
  SELECT ...;

REVOKE SELECT ON public.v_minha_view FROM anon;  -- se houver dado sensível
```

### 🆕 Nova função / trigger

- [ ] **Sempre** `SET search_path = 'app', 'public', 'pg_temp'` (nessa ordem; `pg_temp` no fim como defesa contra temp-schema hijack)
- [ ] Default = `SECURITY INVOKER`. Só use `SECURITY DEFINER` se houver razão concreta.
- [ ] Triggers de integridade tenant (verificar FK cross-tabela) vão em schema `app`, não `public`.

```sql
CREATE OR REPLACE FUNCTION app.tg_check_xxx_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER                                -- ← default explícito
SET search_path = 'app', 'public', 'pg_temp'    -- ← obrigatório
AS $$ ... $$;
```

### 🆕 Nova RPC `SECURITY DEFINER` exposta via PostgREST

Toda RPC `SECURITY DEFINER` chamável por `authenticated` é potencial **tenant escape** — o linter NÃO lê o corpo, só você protege:

1. [ ] `SET search_path = 'app', 'public', 'pg_temp'` (obrigatório)
2. [ ] Primeira linha do corpo: validar `auth.uid() IS NOT NULL`
3. [ ] Para qualquer parâmetro `p_tenant uuid`, validar que `auth.uid()` é membro com role apropriado:
   ```sql
   IF auth.role() <> 'service_role' THEN
     IF NOT EXISTS (
       SELECT 1 FROM public.tenant_members
        WHERE tenant_id = p_tenant
          AND user_id   = auth.uid()
          AND role IN ('owner','admin')  -- ajustar conforme escopo
     ) THEN
       RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
     END IF;
   END IF;
   ```
4. [ ] Se a RPC não deveria ser chamável do frontend: `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` e implemente via edge function com `SERVICE_ROLE_KEY`.

### 🆕 Nova extensão

- [ ] **Nunca** criar em `public`. Use `CREATE EXTENSION foo WITH SCHEMA extensions`.
- [ ] Se for extensão que precisa de search_path implícito (`citext`, `pg_trgm`), confirme que `extensions` está no `search_path` dos roles `anon`/`authenticated`/`service_role`.

### 🆕 Nova edge function

- [ ] Use `SUPABASE_SERVICE_ROLE_KEY` apenas no servidor (nunca commit, nunca no JS do browser).
- [ ] **Toda função que recebe `tenant_id` do cliente** valida que o `auth.uid()` (extraído do JWT) pertence ao tenant antes de operar — não confie em parâmetros.
- [ ] Schemas `app` e `public` ambos precisam de `USAGE` + `ALL`/`EXECUTE` para o service_role (ver memórias [feedback_supabase_app_schema_grants](memory/feedback_supabase_app_schema_grants.md) e [feedback_supabase_service_role_public_grants](memory/feedback_supabase_service_role_public_grants.md)).

---

## Anti-padrões que JÁ apareceram aqui

- ❌ View `tenant_member_profiles` sem `security_invoker=true` expondo `auth.users.email` pra `anon` → corrigido 2026-05-27
- ❌ `recompute_all_costs(p_tenant uuid)` SECURITY DEFINER aceitando UUID arbitrário sem validar membership → tenant escape, corrigido 2026-05-27
- ❌ 31 triggers/funções sem `SET search_path` → vetor de privilege escalation, corrigido 2026-05-27
- ❌ Extensões em `public` (`pg_net`, `pg_trgm`, `citext`) → `pg_trgm`/`citext` movidos; `pg_net` é dívida (não suporta SET SCHEMA)
- ❌ Tabelas legadas (sistema Prisma anterior em PascalCase) sem RLS coexistindo no banco do StockKitchen → 79 renomeadas pra `_legacy_*` em 2026-05-27

---

## Após qualquer DDL: rodar advisor

Antes de considerar a migration concluída:

```
mcp__supabase__get_advisors → type: "security"
```

Se aparecer **qualquer ERROR novo** ou **WARN diferente dos 3 conhecidos** (`pg_net in public`, `recompute_all_costs DEFINER`, `auth_leaked_password_protection`), **não feche a task — trate antes**.

---

## Estado atual dos schemas

- `public` — tabelas operacionais com RLS, views `v_*` com `security_invoker=true`, RPCs (`create_tenant_with_owner`, `recompute_all_costs`, `seed_default_dre`, `snapshot_stock_value`, `run_stock_value_snapshots`, `compute_auto_min_max`)
- `app` — triggers de integridade tenant (`tg_check_*`) e triggers de side-effect (`tg_*_apply_*` em estoque/CMV)
- `extensions` — `pg_trgm`, `citext`, `uuid-ossp`, `pgcrypto`, `pg_stat_statements`
- `_legacy_*` (em public) — 79 tabelas do sistema Prisma antigo, sem grants pra anon/authenticated; podem ser dropadas quando confirmado que ninguém mais usa
- `net` — tabelas internas do `pg_net` (a extensão em si ainda está em `public` por limitação)

---

## Frontend (não-segurança, mas crítico)

- Stack: **React + JSX + Vite** (não Flutter). Ver [project_vite_runtime](memory/project_vite_runtime.md).
- Componentes JSX cross-arquivo precisam expor via `window.X` — ver [feedback_cross_file_jsx_components](memory/feedback_cross_file_jsx_components.md).
- Babel standalone: nunca use `...rest` em spread de props — ver [feedback_babel_standalone_excluded_collision](memory/feedback_babel_standalone_excluded_collision.md).
- Inputs BRL: `Number("8,50")` retorna `NaN`. Use `_parseBR` / `_parseNum` — ver [feedback_brl_number_parse](memory/feedback_brl_number_parse.md).

---

## Ordem de truncamento ao adicionar memórias

Memórias detalhadas vivem em [memory/](C:\Users\danil\.claude\projects\d--Estoque-MobyDick\memory\). Este arquivo é a versão "sempre carregada" — mantenha enxuto. Detalhes técnicos longos → memória dedicada + link.
