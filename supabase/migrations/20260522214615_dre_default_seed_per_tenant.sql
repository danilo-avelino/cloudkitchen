-- Função: popula a estrutura padrão de DRE (groups + categories + subcategories)
-- para um tenant. Idempotente — usa NOT EXISTS para não duplicar quando re-rodada.
CREATE OR REPLACE FUNCTION public.seed_default_dre(p_tenant uuid)
RETURNS void AS $$
DECLARE
  v_cat_id uuid;
BEGIN
  -- 1. Groups
  INSERT INTO public.dre_groups (tenant_id, slug, label, sign, sort_order, is_subtotal)
  SELECT p_tenant, g.slug::citext, g.label, g.sign::app.dre_sign, g.ord, g.subt
  FROM (VALUES
    ('revenue',        'Receita com Vendas',     '+', 10, true),
    ('deductions',     'Impostos e Deduções',    '-', 20, false),
    ('cmv',            'Custo de Mercadoria',    '-', 30, true),
    ('fixed_expenses', 'Despesas Fixas',         '-', 40, false),
    ('personnel',      'Despesas com Pessoal',   '-', 50, false),
    ('operational',    'Despesas Operacionais',  '-', 60, false),
    ('logistics',      'Logística',              '-', 70, false),
    ('financial',      'Despesas Financeiras',   '-', 80, false),
    ('owner',          'Sócios e Investimentos', '-', 90, false)
  ) AS g(slug, label, sign, ord, subt)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.dre_groups dg
    WHERE dg.tenant_id = p_tenant AND dg.slug = g.slug::citext
  );

  -- 2. Categories (uma por grupo)
  INSERT INTO public.dre_categories (tenant_id, group_id, name, sort_order, is_default, is_active)
  SELECT p_tenant, g.id, g.label, g.sort_order, true, true
  FROM public.dre_groups g
  WHERE g.tenant_id = p_tenant
    AND NOT EXISTS (
      SELECT 1 FROM public.dre_categories c
      WHERE c.tenant_id = p_tenant AND c.group_id = g.id
    );

  -- 3. Subcategories
  INSERT INTO public.dre_subcategories (tenant_id, category_id, name, sort_order, autofeed)
  SELECT p_tenant, cat.id, sub.name, sub.ord, sub.autofeed
  FROM (VALUES
    ('revenue','Salão',                                10, NULL),
    ('revenue','Delivery',                             20, NULL),
    ('revenue','Retirada',                             30, NULL),
    ('deductions','Simples (DAS)',                     10, NULL),
    ('deductions','ICMS',                              20, NULL),
    ('deductions','Comissões de vendas',               30, NULL),
    ('deductions','Taxas Aplicativos',                 40, NULL),
    ('cmv','Fornecedores',                             10, 'stock_in'),
    ('cmv','Embalagens',                               20, NULL),
    ('fixed_expenses','Advogado',                      10, NULL),
    ('fixed_expenses','Água',                          20, NULL),
    ('fixed_expenses','Aluguel',                       30, NULL),
    ('fixed_expenses','Consultoria',                   40, NULL),
    ('fixed_expenses','Contador',                      50, NULL),
    ('fixed_expenses','Despesas fixas variadas',       60, NULL),
    ('fixed_expenses','Gás',                           70, NULL),
    ('fixed_expenses','Gasolina',                      80, NULL),
    ('fixed_expenses','Internet',                      90, NULL),
    ('fixed_expenses','Energia',                      100, NULL),
    ('fixed_expenses','Manutenção de equipamentos',   110, NULL),
    ('fixed_expenses','Manutenção predial',           120, NULL),
    ('fixed_expenses','Marketing',                    130, NULL),
    ('fixed_expenses','Anúncios iFood',               140, NULL),
    ('fixed_expenses','Softwares',                    150, NULL),
    ('fixed_expenses','Taxa de lixo',                 160, NULL),
    ('fixed_expenses','Telefones',                    170, NULL),
    ('fixed_expenses','Material de limpeza',          180, NULL),
    ('personnel','Folha de pagamento',                 10, NULL),
    ('personnel','Diaristas',                          20, NULL),
    ('personnel','Outras despesas com pessoas',        30, NULL),
    ('personnel','Rescisão trabalhista',               40, NULL),
    ('personnel','13º salário (provisão)',             50, NULL),
    ('personnel','Férias (provisão)',                  60, NULL),
    ('personnel','1/3 de Férias (provisão)',           70, NULL),
    ('personnel','Rescisão trabalhista (provisão)',    80, NULL),
    ('operational','Outros',                           10, NULL),
    ('logistics','Motoboys',                           10, NULL),
    ('financial','Taxas máquina Delivery',             10, NULL),
    ('financial','Mensalidade e tarifas bancárias',    20, NULL),
    ('owner','Investimento no negócio',                10, NULL),
    ('owner','Retiradas dos sócios',                   20, NULL),
    ('owner','Contas atrasadas',                       30, NULL)
  ) AS sub(group_slug, name, ord, autofeed)
  JOIN public.dre_categories cat
    ON cat.tenant_id = p_tenant
   AND cat.group_id = (
     SELECT id FROM public.dre_groups
     WHERE tenant_id = p_tenant AND slug = sub.group_slug::citext
   )
  WHERE NOT EXISTS (
    SELECT 1 FROM public.dre_subcategories s
    WHERE s.tenant_id = p_tenant
      AND s.category_id = cat.id
      AND s.name = sub.name
  );
END;
$$ LANGUAGE plpgsql;

-- Trigger: ao criar um novo tenant, popula automaticamente a DRE padrão
CREATE OR REPLACE FUNCTION public.tg_seed_dre_on_tenant_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM public.seed_default_dre(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_seed_dre_on_tenant ON public.tenants;
CREATE TRIGGER trg_seed_dre_on_tenant
AFTER INSERT ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.tg_seed_dre_on_tenant_insert();
;
