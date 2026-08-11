-- Etapa "separada" nas ordens de produção — a solicitação de insumos passa a
-- ser operada dentro do módulo Requisições, com o mesmo ritual das requisições
-- de cozinha: pendente → separada → entregue.
--
-- Modelagem: a ordem NÃO ganha um status novo. Ela continua 'draft' enquanto
-- está sendo separada e só vira 'issued' na entrega — que é quando o trigger
-- tg_production_order_transition baixa os insumos e tira o snapshot de custo.
-- "Separada" é apenas o carimbo separated_at sobre uma ordem 'draft'.
--
-- Por que não virar kitchen_request de verdade: a baixa de uma requisição de
-- cozinha é atribuída a uma operação (marca) e entra no CMV dela. O insumo que
-- vai para a produção não é consumo da marca — ele vira transformado, e é o
-- transformado que a marca requisita depois. Contar os dois seria CMV em
-- dobro. Movimentos com reference_type='production_order' já são excluídos do
-- consumo (ver dbTopConsumedItems), então a baixa continua sendo da ordem.
--
-- Sem mudança de trigger: nenhuma transição de status é afetada, logo o
-- tg_production_order_transition e o tg_check_production_output seguem iguais.

alter table public.production_orders
  add column if not exists separated_at timestamptz,
  add column if not exists separated_by uuid references auth.users(id) on delete set null;

comment on column public.production_orders.separated_at is
  'Carimbo de quando os insumos foram separados no módulo Requisições. Só faz sentido com status=draft; a entrega (draft → issued) é que baixa o estoque. NULL = ainda pendente de separação.';
comment on column public.production_orders.separated_by is
  'Usuário que marcou a ordem como separada.';

-- Fila de separação: as ordens abertas (draft) ordenadas por chegada.
create index if not exists production_orders_open_idx
  on public.production_orders (tenant_id, status, created_at)
  where status = 'draft';
