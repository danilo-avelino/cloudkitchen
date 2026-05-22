# Deploy da Fase 13 (Produção)

Esta fase adiciona o que falta pra rodar StockKitchen em produção: superadmin via
JWT (sem chave compartilhada), trigger Inventário → DRE, materialização de CMV
diário, índices quentes, e Realtime nas tabelas que mudam ao vivo.

## Ordem de execução

### 1. Aplicar o SQL da Fase 13

No SQL Editor do Supabase (ou via CLI):

```bash
supabase db execute --file supabase/phase-13-prod.sql
# ou cole o conteúdo no SQL Editor → Run
```

O script é **idempotente** — pode rodar várias vezes.

Saída esperada (linha final):

```
fn_superadmin | fn_inv_to_dre | fn_cmv_daily | realtime_tables
       1      |       1       |       1      |       4 (ou mais)
```

### 2. Promover seu usuário a superadmin (one-shot)

```sql
update public.profiles
set is_superadmin = true
where id = '<seu-auth-user-id>';
```

O `auth-user-id` está em `Authentication → Users → seu email → User UID` no
dashboard do Supabase.

### 3. Deploy das Edge Functions

```bash
# Refatoração de provision-tenant (não usa mais SK_ADMIN_KEY)
supabase functions deploy provision-tenant

# Nova: importação de faturamento (manual + stub iFood)
supabase functions deploy ingest-revenue

# Nova: materialização de CMV diário (callable por cron)
supabase functions deploy compute-cmv-daily
```

### 4. Remover env var antiga e adicionar novas

No Dashboard → Settings → Edge Functions → Secrets:

- **Remover**: `SK_ADMIN_KEY` (provision-tenant não usa mais)
- **Adicionar (opcional)**: `IFOOD_TOKEN`, `IFOOD_WEBHOOK_SECRET` — só quando
  for plugar iFood de verdade

### 5. Configurar cron pro CMV diário

No Dashboard → Database → Cron Jobs → New job:

| Campo     | Valor                                                  |
|-----------|--------------------------------------------------------|
| Name      | `compute-cmv-daily`                                    |
| Schedule  | `0 3 * * *` (todo dia às 03:00 UTC)                    |
| Type      | `Edge Function`                                        |
| Function  | `compute-cmv-daily`                                    |
| Headers   | `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`    |
| Body      | `{"days": 7}` (re-materializa últimos 7 dias)          |

> Alternativa via SQL (`pg_cron`):
>
> ```sql
> select cron.schedule(
>   'compute-cmv-daily', '0 3 * * *',
>   $$ select app.compute_cmv_daily(t.id, current_date - 7, current_date)
>      from public.tenants t; $$
> );
> ```

### 6. Realtime no dashboard

O script já adicionou as tabelas (`kitchen_requests`, `stock_movements`,
`revenue_entries`, `goods_receipts`) à publicação `supabase_realtime`. Confirme em:

Dashboard → Database → Replication → ON pras 4 tabelas.

### 7. Backups / PITR

Disponível só nos planos **Pro+** ($25/mês mínimo). Em Dashboard →
Database → Backups → Enable PITR (retention 7-28 dias conforme plano).

Sem PITR, você tem snapshots diários automáticos (retidos 7 dias no Pro).

### 8. Frontend (já feito)

A linha `adminKey` foi removida de [config.local.js](../config.local.js).
Nenhum caller do front usava ela, então sem mudanças adicionais.

---

## Validação pós-deploy

### Trigger Inventário → DRE

```sql
-- Cria um inventário fake só pra ver o trigger disparar
insert into public.inventory_sessions (tenant_id, status, score, financial_impact, finished_at)
values ('<tenant_id>', 'finalized', 92.5, -127.40, now())
returning id;

-- Deve aparecer uma linha em finance_entries:
select * from public.finance_entries
where auto_source = 'inventory_session'
order by created_at desc
limit 1;
```

### CMV materializado

```sql
-- Roda manualmente
select app.compute_cmv_daily('<tenant_id>', current_date - 30, current_date);

-- Inspeciona
select * from public.cmv_daily where tenant_id = '<tenant_id>' order by business_date desc;
```

### provision-tenant via JWT

```bash
# Login no app, copia o access_token do localStorage (chave stockkitchen.session.v1)
ACCESS_TOKEN="..."

curl -X POST "https://<projeto>.supabase.co/functions/v1/provision-tenant" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Nova Cozinha","slug":"nova-cozinha","ownerEmail":"novo@exemplo.com"}'
```

Se o seu profile não tem `is_superadmin = true` → resposta `403 Forbidden`.

### Realtime

No console do app, abra duas abas. Crie uma requisição na aba 1; a aba 2 deve
mostrar ela aparecendo sem reload (já existia para `kitchen_requests`).

Agora também funciona pra `stock_movements`: faça uma entrada manual no Estoque
da aba 1 → a aba 2 reflete em <500ms.

---

## Rollback

Se precisar reverter qualquer trigger ou índice:

```sql
-- Reverte trigger
drop trigger if exists tg_inventory_sessions_to_dre on public.inventory_sessions;
drop function if exists app.tg_inventory_to_dre();

-- Reverte tabela materializada (mantém função)
drop table if exists public.cmv_daily;

-- Remove flag superadmin
alter table public.profiles drop column if exists is_superadmin;
```

`drop column` apaga dados — se já promoveu usuários, recupere os IDs antes.
