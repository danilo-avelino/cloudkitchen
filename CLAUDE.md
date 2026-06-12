# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Supabase (StockKitchen)

**Regras obrigatórias para qualquer migration/edge function. Validar antes de `apply_migration`.**

### 5.1 Segurança (views, funções, RPCs)

- **Views em `public`** → sempre `WITH (security_invoker = true)`. Sem isso o PostgREST executa com privilégios do owner (postgres) e bypassa a RLS das tabelas-base. Views que tocam `auth.users`/`auth.identities` → também `REVOKE SELECT FROM anon`.
- **Funções / triggers** → sempre `SET search_path = 'app','public','pg_temp'` (nessa ordem; `pg_temp` no fim como defesa). Sem isso, atacante com CREATE em qualquer schema do search_path pode interpor objetos maliciosos.
- **RPCs `SECURITY DEFINER` expostos via PostgREST** → obrigatório, em ordem:
  1. `auth.uid() IS NULL` check no início.
  2. Validar `tenant_members.role` para qualquer parâmetro `p_tenant uuid` (bypass apenas via `auth.role() = 'service_role'`).
  3. Se não for signup público → `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` e expor via edge function com service_role.

O linter do Supabase **não lê o corpo das funções** — validações internas não silenciam o advisor, mas são a única defesa contra tenant escape. Rodar `mcp__supabase__get_advisors` após qualquer mudança estrutural e confirmar que o advisor não regrediu.

### 5.2 GRANTs no schema `app`

Toda função/utilitário criado em `app.*` (ou qualquer schema fora de `public`) precisa de:

```sql
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;
```

RLS policies chamam `app.has_tenant_role(...)`/`app.is_tenant_member(...)`. Mesmo sendo `SECURITY DEFINER`, a resolução do nome `app.foo()` exige USAGE no schema pelo role que está chamando. Sem isso, **todo** INSERT/UPDATE/SELECT em tabela com RLS falha com `permission denied for schema app`. Se um tenant reportar esse erro, rodar a migration `grant_usage_on_app_schema` (idempotente) antes de investigar qualquer outra coisa.

### 5.3 GRANTs no schema `public` para `service_role`

Toda edge function que usa `SERVICE_ROLE_KEY` precisa que `service_role` tenha:

```sql
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
```

Sem USAGE em `public`, edge functions caem em 500 com `permission denied for schema public` — inclusive no lookup inicial de `tenant_members` para validar role. Diagnosticar via `has_schema_privilege('service_role', 'public', 'USAGE')`. Toda migration que mexe com edge function deve incluir esses GRANTs por garantia.

## 6. Deploy e Commit

**Nunca fazer deploy nem commit sem pedido explícito do usuário.**

- Não rodar `git commit`, `git push`, `apply_migration` em produção, `deploy_edge_function` ou qualquer ação equivalente por iniciativa própria — mesmo que pareça o "próximo passo natural" depois de uma mudança.
- Terminar a tarefa, mostrar o que mudou e esperar o usuário pedir o commit/deploy.
- Vale também para criar PR, push de branch, merge, e qualquer ação visível fora do working tree local.

---
7. Botões. Em todos os novos botões devemos adicionar um guard de duplo-clique e aviso de Carregando

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.