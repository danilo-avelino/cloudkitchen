-- Backfill de payment_methods para tenants que nasceram sem nenhum método.
--
-- Causa: a edge function provision-tenant semeava payment_methods com colunas
-- inexistentes (name/kind) em vez de slug/label/short_label/color, e o INSERT
-- falhava em silêncio. Tenants criados por ela ficaram com zero métodos, o que
-- zerava todo o faturamento (breakdown vazio → revenue = 0).
--
-- Idempotente: só insere para tenants que hoje não têm NENHUM payment_method.
-- Não toca em tenants que já configuraram (ou customizaram) os seus.

insert into public.payment_methods (tenant_id, slug, label, short_label, color, sort_order, is_active)
select t.id, s.slug, s.label, s.short_label, s.color, s.sort_order, true
from public.tenants t
cross join (values
  ('debito',   'Débito',   'Déb',  '#3d6cb0', 1),
  ('credito',  'Crédito',  'Créd', '#6b5fb0', 2),
  ('voucher',  'Voucher',  'Vchr', '#c2843a', 3),
  ('dinheiro', 'Dinheiro', 'Din',  '#2d8c66', 4),
  ('pix',      'Pix',      'Pix',  '#1aa39e', 5),
  ('online',   'Online',   'Onl',  '#b04545', 6)
) as s(slug, label, short_label, color, sort_order)
where not exists (
  select 1 from public.payment_methods pm where pm.tenant_id = t.id
)
on conflict (tenant_id, slug) do nothing;
