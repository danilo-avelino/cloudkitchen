-- iFood app distribuído: fluxo authorization_code (userCode) + refresh_token.
-- Tokens por operação ficam numa tabela à parte SEM policies de leitura —
-- só service_role (edge function) acessa. Refresh token nunca chega ao cliente.

-- status da integração (pending → aguardando autorização da loja; active → ok)
ALTER TABLE public.operation_integrations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS public.operation_integration_auth (
  integration_id               uuid PRIMARY KEY
                                 REFERENCES public.operation_integrations(id) ON DELETE CASCADE,
  authorization_code_verifier  text,        -- transitório (entre userCode e token)
  access_token                 text,
  refresh_token                text,
  token_expires_at             timestamptz,
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

-- RLS habilitado SEM nenhuma policy → nenhum usuário lê/escreve; service_role bypassa.
ALTER TABLE public.operation_integration_auth ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.operation_integration_auth TO service_role;
