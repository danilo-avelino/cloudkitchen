-- =====================================================================
-- Cria usuário de teste no Supabase Auth
-- Rode no SQL Editor do Supabase com credenciais de superuser
-- =====================================================================

-- Email: danilocaioavelino@gmail.com
-- Senha: StockKitchen2026! (mude após primeiro login)

select
  auth.admin_create_user(
    email := 'danilocaioavelino@gmail.com',
    password := 'StockKitchen2026!',
    email_confirm := true,
    user_metadata := '{"name":"Rafa Medeiros"}'::jsonb
  ) as created_user;
