-- L1 (segurança): remove superfície desnecessária — anon não precisa SELECT nestas
-- views internas. São security_invoker (anon já via 0 linhas via RLS), mas o grant
-- é superfície inútil. Revoga explicitamente.
revoke select on public.v_closing_checklist from anon;
revoke select on public.v_cmv_real_monthly   from anon;
revoke select on public.v_dre_monthly        from anon;
revoke select on public.v_revenue_entries    from anon;
