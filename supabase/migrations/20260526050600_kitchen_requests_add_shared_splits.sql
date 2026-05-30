alter table public.kitchen_requests
  add column if not exists is_shared boolean not null default false,
  add column if not exists splits    jsonb;

comment on column public.kitchen_requests.is_shared is
  'Quando true, a requisição é "Uso compartilhado" — o custo é rateado entre operações (ver coluna splits). operation_id continua sendo a operação primária (maior pct) para satisfazer NOT NULL e o trigger de baixa de estoque.';

comment on column public.kitchen_requests.splits is
  'Array JSON com a divisão de custo: [{ "op": "<operation_id>", "pct": 50 }, ...]. Só preenchido quando is_shared=true.';
;
