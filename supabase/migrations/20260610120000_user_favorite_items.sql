-- Favoritos de insumos por usuário (página mobile de requisições).
-- Dado PESSOAL: cada linha pertence a um usuário e fica escopada a um tenant do
-- qual ele é membro. A página mobile (#/mobile) lê/escreve via PostgREST com a
-- chave anon do usuário logado, então a RLS é a única defesa — política FOR ALL
-- com user_id = auth.uid() + app.is_tenant_member(tenant_id).

CREATE TABLE IF NOT EXISTS public.user_favorite_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id)        ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id)    ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id, stock_item_id)
);

CREATE INDEX IF NOT EXISTS user_favorite_items_user_tenant_idx
  ON public.user_favorite_items (user_id, tenant_id);

ALTER TABLE public.user_favorite_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_favorite_items_own ON public.user_favorite_items;
CREATE POLICY user_favorite_items_own ON public.user_favorite_items
  FOR ALL
  USING      (user_id = auth.uid() AND app.is_tenant_member(tenant_id))
  WITH CHECK (user_id = auth.uid() AND app.is_tenant_member(tenant_id));

GRANT SELECT, INSERT, DELETE ON public.user_favorite_items TO authenticated;
GRANT ALL ON public.user_favorite_items TO service_role;
