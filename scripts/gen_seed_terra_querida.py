# -*- coding: utf-8 -*-
# Gera o SQL de seed (categorias + itens) para o tenant Terra Querida - Dom Severino
# a partir de scripts/terra-querida-source.md. Idempotente.
import re, io, os

SRC = os.path.join(os.path.dirname(__file__), "terra-querida-source.md")
OUT = os.path.join(os.path.dirname(__file__), "..", "supabase", "seed-terra-querida-dom-severino.sql")
SLUG = "terra-querida-dom-severino"

# Nome de exibição por cabeçalho do markdown (Title Case legível, com acentos)
CAT_DISPLAY = {
    "BEBIDAS": "Bebidas",
    "PROTEINAS - BOVINAS": "Proteínas - Bovinas",
    "CARNE SUÍNA": "Carne Suína",
    "CORDEIRO": "Cordeiro",
    "DESCARTÁVEIS E EMBALAGENS": "Descartáveis e Embalagens",
    "FRANGO": "Frango",
    "HORTIFRUTI": "Hortifruti",
    "INSUMOS": "Insumos",
    "LATICÍNIOS E FRIOS": "Laticínios e Frios",
    "LIMPEZA E HIGIENE": "Limpeza e Higiene",
    "ÓLEOS, MOLHOS E CONDIMENTOS": "Óleos, Molhos e Condimentos",
    "PEIXES E FRUTOS DO MAR": "Peixes e Frutos do Mar",
}

UNIT_MAP = {"und": "un", "un": "un", "kg": "kg", "g": "g", "ml": "ml", "l": "L"}

def parse_price(s):
    s = s.strip().replace("R$", "").strip()
    s = s.replace(".", "").replace(",", ".")  # BRL: ponto=milhar, vírgula=decimal
    return float(s)

def sqlq(s):
    return "'" + s.replace("'", "''") + "'"

cats = []        # [(display, ord)]
items = []       # [(cat_display, name, unit, cost)]
cur = None
with io.open(SRC, encoding="utf-8") as f:
    for raw in f:
        line = raw.rstrip("\n")
        if line.startswith("## "):
            head = line[3:].strip()
            disp = CAT_DISPLAY.get(head, head.title())
            cur = disp
            cats.append((disp, len(cats) * 10 + 10))
        elif line.startswith("- "):
            body = line[2:]
            parts = [p.strip() for p in body.split("|")]
            assert len(parts) == 3, "linha mal formada: " + line
            name, unit_raw, price_raw = parts
            unit = UNIT_MAP.get(unit_raw.lower())
            assert unit, "unidade desconhecida: " + unit_raw + " em " + line
            items.append((cur, name, unit, parse_price(price_raw)))

# ---- Emite SQL ----
o = io.StringIO()
w = o.write
w("-- Seed de estoque · tenant 'Terra Querida - Dom Severino'\n")
w("-- Gerado por scripts/gen_seed_terra_querida.py · idempotente (re-rodável).\n")
w("-- Substitui as 8 categorias padrão (vazias) pelas %d categorias abaixo.\n\n" % len(cats))
w("begin;\n\n")

w("with t as (select id from public.tenants where slug = %s)\n" % sqlq(SLUG))
w("-- 1) Remove categorias pré-existentes do tenant que NÃO estão na nova lista\n")
w("--    e que não têm nenhum item vinculado (as 8 padrão estão vazias).\n")
cat_names_sql = ", ".join(sqlq(c[0]) for c in cats)
w("delete from public.stock_categories c\n")
w(" using t\n")
w(" where c.tenant_id = t.id\n")
w("   and c.name not in (%s)\n" % cat_names_sql)
w("   and not exists (select 1 from public.stock_items i where i.category_id = c.id);\n\n")

w("-- 2) Cria as categorias (idempotente via unique (tenant_id, name)).\n")
w("insert into public.stock_categories (tenant_id, name, sort_order)\n")
w("select t.id, v.name, v.ord\n")
w("from (select id from public.tenants where slug = %s) t\n" % sqlq(SLUG))
w("cross join (values\n")
for i, (disp, ordv) in enumerate(cats):
    w("  (%s, %d)%s\n" % (sqlq(disp), ordv, "," if i < len(cats) - 1 else ""))
w(") as v(name, ord)\n")
w("on conflict (tenant_id, name) do update set sort_order = excluded.sort_order;\n\n")

w("-- 3) Insere os itens, vinculando à categoria pelo nome.\n")
w("--    NOT EXISTS por (tenant,nome) torna o re-run seguro (sem duplicar).\n")
w("insert into public.stock_items (tenant_id, category_id, name, unit, unit_cost)\n")
w("select t.id, c.id, d.name, d.unit, d.cost\n")
w("from (select id from public.tenants where slug = %s) t\n" % sqlq(SLUG))
w("join (values\n")
for i, (cat, name, unit, cost) in enumerate(items):
    w("  (%s, %s, %s, %s)%s\n" % (
        sqlq(cat), sqlq(name), sqlq(unit), ("%.4f" % cost),
        "," if i < len(items) - 1 else ""))
w(") as d(cat, name, unit, cost) on true\n")
w("join public.stock_categories c on c.tenant_id = t.id and c.name = d.cat\n")
w("where not exists (\n")
w("  select 1 from public.stock_items i\n")
w("  where i.tenant_id = t.id and i.name = d.name\n")
w(");\n\n")

w("commit;\n\n")
w("-- Conferência rápida (rode separado se quiser):\n")
w("-- select c.name, count(i.*) from public.stock_categories c\n")
w("--   left join public.stock_items i on i.category_id=c.id\n")
w("--   where c.tenant_id=(select id from public.tenants where slug=%s)\n" % sqlq(SLUG))
w("--   group by c.name order by c.name;\n")

with io.open(OUT, "w", encoding="utf-8") as f:
    f.write(o.getvalue())

# Resumo no stdout
from collections import Counter, OrderedDict
per = OrderedDict()
for c in cats: per[c[0]] = 0
for it in items: per[it[0]] = per.get(it[0], 0) + 1
print("Categorias: %d" % len(cats))
print("Itens totais: %d" % len(items))
for k, v in per.items():
    print("  %-30s %d" % (k, v))
print("\nSQL escrito em:", os.path.normpath(OUT))
