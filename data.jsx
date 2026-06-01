// Mock data realistic for SP dark kitchen
const OPERATIONS = [
  { id: "all",        name: "Consolidado",     short: "TODAS",  color: "#8a9098", iFood: null },
  { id: "burguer",    name: "Forno & Brasa",   short: "BURG",   color: "#c2843a", iFood: "@fornoebrasa" },
  { id: "pizzaria",   name: "Mestre Stefano",  short: "PIZZ",   color: "#b04545", iFood: "@mestrestefano" },
  { id: "acai",       name: "Tigela do Vale",  short: "AÇAÍ",   color: "#6b5fb0", iFood: "@tigeladovale" },
  { id: "saudavel",   name: "Verde Marmita",   short: "VERDE",  color: "#2d8c66", iFood: "@verdemarmita" },
];

// KPI snapshot per scope
const KPI = {
  all: {
    revenue:    { v: "R$ 184.730", d: "+12,4%", tone: "up",   sub: "vs semana anterior" },
    cmv:        { v: "32,8%",      d: "+1,2pp", tone: "warn", sub: "meta 31,0%" },
    stockValue: { v: "R$ 47.218",  d: "−R$ 1.204", tone: "down", sub: "94 SKUs" },
    alerts:     { v: "12",         d: "3 críticos", tone: "warn", sub: "ruptura + vencimento" },
  },
  burguer: {
    revenue:    { v: "R$ 62.410",  d: "+8,1%",  tone: "up",   sub: "tk médio R$ 48,30" },
    cmv:        { v: "29,4%",      d: "−0,3pp", tone: "up",   sub: "meta 30,0%" },
    stockValue: { v: "R$ 14.082",  d: "+R$ 412", tone: "warn", sub: "alocado" },
    alerts:     { v: "3",          d: "1 ruptura", tone: "warn", sub: "queijo cheddar" },
  },
  pizzaria: {
    revenue:    { v: "R$ 71.220",  d: "+18,2%", tone: "up",   sub: "tk médio R$ 62,80" },
    cmv:        { v: "34,1%",      d: "+2,4pp", tone: "down", sub: "meta 31,0%" },
    stockValue: { v: "R$ 18.940",  d: "+R$ 880", tone: "warn", sub: "alocado" },
    alerts:     { v: "5",          d: "2 críticos", tone: "warn", sub: "muçarela + farinha 00" },
  },
  acai: {
    revenue:    { v: "R$ 28.140",  d: "−4,2%",  tone: "down", sub: "tk médio R$ 32,10" },
    cmv:        { v: "38,7%",      d: "+3,1pp", tone: "down", sub: "meta 35,0%" },
    stockValue: { v: "R$ 8.790",   d: "+R$ 1.108", tone: "warn", sub: "alocado" },
    alerts:     { v: "3",          d: "embalagem 500ml", tone: "crit", sub: "ruptura iminente" },
  },
  saudavel: {
    revenue:    { v: "R$ 22.960",  d: "+22,4%", tone: "up",   sub: "tk médio R$ 38,90" },
    cmv:        { v: "27,2%",      d: "−1,4pp", tone: "up",   sub: "meta 28,0%" },
    stockValue: { v: "R$ 5.406",   d: "+R$ 318", tone: "warn", sub: "alocado" },
    alerts:     { v: "1",          d: "alface próximo venc.", tone: "warn", sub: "" },
  },
};

// =====================================================================
// COMPRAS · RECEBIMENTOS · ESTOQUE — separação clara de modelos
// =====================================================================
// SHOPPING_LISTS — listas de compras (pedido). Snapshot imutável dos itens
//   no momento em que a lista foi gerada. Status muda conforme recebimentos.
// GOODS_RECEIPTS — recebimentos físicos. Cada recebimento referencia uma
//   shopping_list + um fornecedor. Pode haver múltiplos recebimentos parciais.
// Cada recebimento confirmado gera STOCK_MOVEMENTS (kind='in') ao backend
//   e atualiza qty/cost médio em STOCK_ITEMS. Lista original permanece
//   intocada — o histórico de divergências fica nos receipt_items.

const SHOPPING_LISTS = [
  {
    id: "LCO-0001",
    title: "Auto · 06/05",
    created_at: "2026-05-06T14:30:00",
    created_by: "Rafa Medeiros",
    status: "received", // open | partial | received | closed
    notes: "Reposição semanal · hortifruti + laticínios",
    items: [
      { id: "lci-0101", stock_item_id: "INS-0001", name: "Tomate italiano",     supplier: "Hortifruti Zona Leste",  category: "Hortifruti", qty: 20,   unit: "kg", est_unit_cost: 8.90,  est_cost: 178.00 },
      { id: "lci-0102", stock_item_id: "INS-0017", name: "Cebola roxa",         supplier: "Hortifruti Zona Leste",  category: "Hortifruti", qty: 10,   unit: "kg", est_unit_cost: 7.20,  est_cost: 72.00  },
      { id: "lci-0103", stock_item_id: "INS-0009", name: "Alface americana",    supplier: "Hortifruti Zona Leste",  category: "Hortifruti", qty: 12,   unit: "und", est_unit_cost: 4.50,  est_cost: 54.00  },
      { id: "lci-0104", stock_item_id: "INS-0010", name: "Banana nanica",       supplier: "Hortifruti Zona Leste",  category: "Hortifruti", qty: 20,   unit: "kg", est_unit_cost: 5.20,  est_cost: 104.00 },
      { id: "lci-0105", stock_item_id: "INS-0007", name: "Cheddar fatiado",     supplier: "Laticínios São Paulo",   category: "Laticínios", qty: 8,    unit: "kg", est_unit_cost: 64.00, est_cost: 512.00 },
      { id: "lci-0106", stock_item_id: "INS-0002", name: "Queijo muçarela bola",supplier: "Laticínios São Paulo",   category: "Laticínios", qty: 15,   unit: "kg", est_unit_cost: 42.80, est_cost: 642.00 },
    ],
  },
  {
    id: "LCO-0002",
    title: "Embalagens emergencial · 07/05",
    created_at: "2026-05-07T08:15:00",
    created_by: "Rafa Medeiros",
    status: "open",
    notes: "Ruptura de isopor na operação Açaí",
    items: [
      { id: "lci-0201", stock_item_id: "INS-0003", name: "Embalagem isopor 500ml", supplier: "Embalagens BR", category: "Embalagens", qty: 600, unit: "und", est_unit_cost: 0.42, est_cost: 252.00 },
      { id: "lci-0202", stock_item_id: "INS-0016", name: "Pote PP 750ml c/ tampa", supplier: "Embalagens BR", category: "Embalagens", qty: 200, unit: "und", est_unit_cost: 0.68, est_cost: 136.00 },
    ],
  },
  {
    id: "LCO-0003",
    title: "Carnes · semana 19",
    created_at: "2026-05-07T09:45:00",
    created_by: "Rafa Medeiros",
    status: "partial",
    notes: "",
    items: [
      { id: "lci-0301", stock_item_id: "INS-0005", name: "Carne bovina moída 80/20", supplier: "Distribuidor Carnes BR", category: "Carnes", qty: 21, unit: "kg", est_unit_cost: 38.40, est_cost: 806.40 },
      { id: "lci-0302", stock_item_id: "INS-0014", name: "Bacon em cubos",           supplier: "Distribuidor Carnes BR", category: "Carnes", qty: 8,  unit: "kg", est_unit_cost: 48.90, est_cost: 391.20 },
      { id: "lci-0303", stock_item_id: "INS-0018", name: "Calabresa defumada",       supplier: "Distribuidor Carnes BR", category: "Carnes", qty: 6,  unit: "kg", est_unit_cost: 36.40, est_cost: 218.40 },
    ],
  },
];

const GOODS_RECEIPTS = [
  // Recebimento completo da LCO-0001 · Hortifruti
  {
    id: "REC-0001",
    list_id: "LCO-0001",
    supplier: "Hortifruti Zona Leste",
    received_at: "2026-05-06T15:30:00",
    received_by: "André Oliveira",
    nf_number: "NF 12345",
    notes: "",
    items: [
      { id: "rci-001", list_item_id: "lci-0101", name: "Tomate italiano",  qty_ordered: 20, qty_received: 20, unit: "kg", unit_cost: 8.90, line_cost: 178.00, divergent: false, divergence_reason: "" },
      { id: "rci-002", list_item_id: "lci-0102", name: "Cebola roxa",      qty_ordered: 10, qty_received: 9.5, unit: "kg", unit_cost: 7.20, line_cost: 68.40,  divergent: true,  divergence_reason: "Pacotes incompletos" },
      { id: "rci-003", list_item_id: "lci-0103", name: "Alface americana", qty_ordered: 12, qty_received: 12,  unit: "und", unit_cost: 4.50, line_cost: 54.00,  divergent: false, divergence_reason: "" },
      { id: "rci-004", list_item_id: "lci-0104", name: "Banana nanica",    qty_ordered: 20, qty_received: 20,  unit: "kg", unit_cost: 5.20, line_cost: 104.00, divergent: false, divergence_reason: "" },
    ],
  },
  // Recebimento da LCO-0001 · Laticínios
  {
    id: "REC-0002",
    list_id: "LCO-0001",
    supplier: "Laticínios São Paulo",
    received_at: "2026-05-06T17:10:00",
    received_by: "André Oliveira",
    nf_number: "NF 5520",
    notes: "Cheddar veio em peça inteira (não fatiado) · negociado desconto",
    items: [
      { id: "rci-005", list_item_id: "lci-0105", name: "Cheddar fatiado",      qty_ordered: 8, qty_received: 8,  unit: "kg", unit_cost: 60.00, line_cost: 480.00, divergent: true,  divergence_reason: "Veio peça inteira · −R$ 4/kg" },
      { id: "rci-006", list_item_id: "lci-0106", name: "Queijo muçarela bola", qty_ordered: 15, qty_received: 15, unit: "kg", unit_cost: 42.80, line_cost: 642.00, divergent: false, divergence_reason: "" },
    ],
  },
  // Recebimento parcial da LCO-0003 · Carnes (só carne moída chegou)
  {
    id: "REC-0003",
    list_id: "LCO-0003",
    supplier: "Distribuidor Carnes BR",
    received_at: "2026-05-07T11:20:00",
    received_by: "André Oliveira",
    nf_number: "NF 0917",
    notes: "Bacon e calabresa em rota · próxima entrega às 17h",
    items: [
      { id: "rci-007", list_item_id: "lci-0301", name: "Carne bovina moída 80/20", qty_ordered: 21, qty_received: 21, unit: "kg", unit_cost: 38.40, line_cost: 806.40, divergent: false, divergence_reason: "" },
    ],
  },
];

// Fornecedores cadastrados — usados pelo módulo de Lista de compras p/ agrupar
// itens por fornecedor e ter o contato pronto na hora de copiar pro WhatsApp.
const SUPPLIERS = [
  { id: "sup-hortifruti", name: "Hortifruti Zona Leste",   contact: "WhatsApp · 11 9 8412-3304",  lead: "12h" },
  { id: "sup-laticinios", name: "Laticínios São Paulo",    contact: "WhatsApp · 11 9 7233-1188",  lead: "24h" },
  { id: "sup-embalagens", name: "Embalagens BR",           contact: "Email · vendas@embalagens.br", lead: "48h" },
  { id: "sup-carnes",     name: "Distribuidor Carnes BR",  contact: "WhatsApp · 11 9 5102-7799",  lead: "24h" },
  { id: "sup-secos",      name: "Atacadão",                contact: "Loja · Av. das Nações 1500", lead: "imediato" },
  { id: "sup-congelados", name: "Distribuidor Congelados", contact: "WhatsApp · 11 9 7800-5500",  lead: "48h" },
  { id: "sup-padaria",    name: "Padaria Pão de Cada Dia", contact: "WhatsApp · 11 9 9050-2244",  lead: "12h" },
];

// Cada item tem:
//   reorder  = estoque mínimo (ponto de pedido)
//   max      = estoque máximo desejado (alvo após compra)
//   usage30d = consumo dos últimos 30 dias (UI deriva média semanal = usage30d / 4)
//   supplier = nome do fornecedor preferido (case-insensitive · faz lookup em SUPPLIERS)
const STOCK_ITEMS = [
  { id: "INS-0001", name: "Tomate italiano",          cat: "Hortifruti",   supplier: "Hortifruti Zona Leste",  qty: 12.4,  unit: "kg", cost: 8.90,  status: "ok",   reorder: 8,   max: 25,  usage30d: 78,   exp: "09/05",  alloc: { burguer: 4.2, pizzaria: 7.1, acai: 0,   saudavel: 1.1 } },
  { id: "INS-0002", name: "Queijo muçarela bola",     cat: "Laticínios",   supplier: "Laticínios São Paulo",   qty: 3.2,   unit: "kg", cost: 42.80, status: "warn", reorder: 6,   max: 15,  usage30d: 28,   exp: "12/05",  alloc: { burguer: 0.8, pizzaria: 2.4, acai: 0,   saudavel: 0   } },
  { id: "INS-0003", name: "Embalagem isopor 500ml",   cat: "Embalagens",   supplier: "Embalagens BR",          qty: 0,     unit: "und", cost: 0.42,  status: "crit", reorder: 200, max: 600, usage30d: 580,  exp: "—",      alloc: { burguer: 0,   pizzaria: 0,   acai: 0,   saudavel: 0   }, composeCmv: false },
  { id: "INS-0004", name: "Farinha tipo 00",          cat: "Secos",        supplier: "Atacadão",                qty: 28.5,  unit: "kg", cost: 6.20,  status: "ok",   reorder: 15,  max: 40,  usage30d: 45,   exp: "08/2026", alloc: { burguer: 0,   pizzaria: 28.5, acai: 0,  saudavel: 0   } },
  { id: "INS-0005", name: "Carne bovina moída 80/20", cat: "Carnes",       supplier: "Distribuidor Carnes BR", qty: 8.7,   unit: "kg", cost: 38.40, status: "warn", reorder: 12,  max: 30,  usage30d: 38,   exp: "08/05",  alloc: { burguer: 8.7, pizzaria: 0,   acai: 0,   saudavel: 0   } },
  { id: "INS-0006", name: "Polpa de açaí 1kg",        cat: "Congelados",   supplier: "Distribuidor Congelados", qty: 22,    unit: "und", cost: 18.90, status: "ok",   reorder: 10,  max: 35,  usage30d: 75,   exp: "11/2026", alloc: { burguer: 0,  pizzaria: 0,   acai: 22,  saudavel: 0   } },
  { id: "INS-0007", name: "Cheddar fatiado",          cat: "Laticínios",   supplier: "Laticínios São Paulo",   qty: 0.4,   unit: "kg", cost: 64.00, status: "crit", reorder: 4,   max: 10,  usage30d: 12,   exp: "10/05",  alloc: { burguer: 0.4, pizzaria: 0,   acai: 0,   saudavel: 0   } },
  { id: "INS-0008", name: "Pão brioche burguer",      cat: "Padaria",      supplier: "Padaria Pão de Cada Dia", qty: 84,    unit: "und", cost: 1.80,  status: "ok",   reorder: 60,  max: 200, usage30d: 540,  exp: "08/05",  alloc: { burguer: 84,  pizzaria: 0,   acai: 0,   saudavel: 0   } },
  { id: "INS-0009", name: "Alface americana",         cat: "Hortifruti",   supplier: "Hortifruti Zona Leste",  qty: 6,     unit: "und", cost: 4.50,  status: "warn", reorder: 8,   max: 20,  usage30d: 28,   exp: "07/05",  alloc: { burguer: 2,  pizzaria: 0,   acai: 0,   saudavel: 4   } },
  { id: "INS-0010", name: "Banana nanica",            cat: "Hortifruti",   supplier: "Hortifruti Zona Leste",  qty: 14,    unit: "kg", cost: 5.20,  status: "ok",   reorder: 10,  max: 30,  usage30d: 48,   exp: "10/05",  alloc: { burguer: 0,  pizzaria: 0,   acai: 14,  saudavel: 0   } },
  { id: "INS-0011", name: "Granola sem açúcar",       cat: "Secos",        supplier: "Atacadão",                qty: 5.4,   unit: "kg", cost: 28.40, status: "ok",   reorder: 3,   max: 8,   usage30d: 14,   exp: "09/2026", alloc: { burguer: 0, pizzaria: 0,   acai: 5.4, saudavel: 0   } },
  { id: "INS-0012", name: "Frango peito desfiado",    cat: "Carnes",       supplier: "Distribuidor Carnes BR", qty: 4.1,   unit: "kg", cost: 32.80, status: "warn", reorder: 6,   max: 15,  usage30d: 22,   exp: "08/05",  alloc: { burguer: 0,  pizzaria: 1.2, acai: 0,   saudavel: 2.9 } },
  { id: "INS-0013", name: "Azeite extra virgem 500ml", cat: "Mercearia",   supplier: "Atacadão",                qty: 11,    unit: "und", cost: 32.00, status: "ok",   reorder: 6,   max: 18,  usage30d: 28,   exp: "06/2027", alloc: { burguer: 0, pizzaria: 8,   acai: 0,   saudavel: 3   } },
  { id: "INS-0014", name: "Bacon em cubos",           cat: "Carnes",       supplier: "Distribuidor Carnes BR", qty: 2.1,   unit: "kg", cost: 48.90, status: "warn", reorder: 4,   max: 10,  usage30d: 11,   exp: "14/05",  alloc: { burguer: 1.4, pizzaria: 0.7, acai: 0,   saudavel: 0   } },
  { id: "INS-0015", name: "Leite integral 1L",        cat: "Laticínios",   supplier: "Laticínios São Paulo",   qty: 18,    unit: "und", cost: 5.40,  status: "ok",   reorder: 12,  max: 30,  usage30d: 60,   exp: "20/05",  alloc: { burguer: 4,  pizzaria: 6,   acai: 8,   saudavel: 0   } },
  { id: "INS-0016", name: "Pote PP 750ml c/ tampa",   cat: "Embalagens",   supplier: "Embalagens BR",          qty: 320,   unit: "und", cost: 0.68,  status: "ok",   reorder: 200, max: 500, usage30d: 580,  exp: "—",      alloc: { burguer: 0, pizzaria: 0,    acai: 0,   saudavel: 320 }, composeCmv: false },
  { id: "INS-0017", name: "Cebola roxa",              cat: "Hortifruti",   supplier: "Hortifruti Zona Leste",  qty: 7.8,   unit: "kg", cost: 7.20,  status: "ok",   reorder: 5,   max: 15,  usage30d: 22,   exp: "18/05",  alloc: { burguer: 2.4, pizzaria: 3.4, acai: 0,   saudavel: 2   } },
  { id: "INS-0018", name: "Calabresa defumada",       cat: "Carnes",       supplier: "Distribuidor Carnes BR", qty: 1.8,   unit: "kg", cost: 36.40, status: "warn", reorder: 3,   max: 8,   usage30d: 9,    exp: "11/05",  alloc: { burguer: 0,  pizzaria: 1.8, acai: 0,   saudavel: 0   } },
];

const REQUESTS = [
  { id: "REQ-0418", op: "pizzaria", at: "20:14", by: "Stefano (cozinha)",   itemsCount: 4, total: "R$ 312,40", status: "pending",  priority: "high",   age: "4 min", items: [["Muçarela", "2 kg"], ["Farinha 00", "5 kg"], ["Calabresa", "1 kg"], ["Azeite 500ml", "2 un"]] },
  { id: "REQ-0417", op: "burguer",  at: "20:08", by: "Marina (cozinha)",    itemsCount: 3, total: "R$ 184,90", status: "pending",  priority: "normal", age: "10 min", items: [["Cheddar", "0,5 kg"], ["Pão brioche", "20 un"], ["Bacon", "0,4 kg"]] },
  { id: "REQ-0416", op: "acai",     at: "19:52", by: "Lucas (cozinha)",     itemsCount: 2, total: "R$ 84,20",  status: "approved", priority: "high",   age: "26 min", items: [["Polpa açaí 1kg", "4 un"], ["Granola", "0,8 kg"]] },
  { id: "REQ-0415", op: "saudavel", at: "19:40", by: "Camila (cozinha)",    itemsCount: 5, total: "R$ 218,30", status: "approved", priority: "normal", age: "38 min", items: [["Frango desf.", "1,2 kg"], ["Alface", "2 pé"], ["Pote 750ml", "30 un"], ["Cebola roxa", "0,5 kg"], ["Azeite 500ml", "1 un"]] },
  { id: "REQ-0414", op: "pizzaria", at: "19:22", by: "Stefano (cozinha)",   itemsCount: 2, total: "R$ 96,40",  status: "separated", priority: "normal", age: "56 min", items: [["Tomate italiano", "3 kg"], ["Mussarela", "1 kg"]] },
  { id: "REQ-0413", op: "burguer",  at: "18:55", by: "Marina (cozinha)",    itemsCount: 1, total: "R$ 38,40",  status: "separated", priority: "normal", age: "1h 23m", items: [["Carne moída", "1 kg"]] },
  { id: "REQ-0412", op: "acai",     at: "18:30", by: "Lucas (cozinha)",     itemsCount: 3, total: "R$ 142,60", status: "delivered", priority: "normal", age: "1h 48m", items: [["Banana nanica", "4 kg"], ["Granola", "0,5 kg"], ["Pote 500ml", "60 un"]] },
  { id: "REQ-0411", op: "saudavel", at: "18:12", by: "Camila (cozinha)",    itemsCount: 4, total: "R$ 178,80", status: "delivered", priority: "normal", age: "2h 06m", items: [["Frango desf.", "1,5 kg"], ["Alface", "3 pé"], ["Pote 750ml", "20 un"], ["Cebola roxa", "0,8 kg"]] },
];

const SHOPPING = [
  { sup: "Hortifruti Zona Leste",  contact: "WhatsApp · 11 9 8412-3304", lead: "12h", items: [
    { name: "Tomate italiano",   qty: "20 kg",  est: "R$ 178,00", reason: "Cobertura 7 dias · consumo médio 2,8 kg/dia" },
    { name: "Cebola roxa",        qty: "10 kg",  est: "R$ 72,00",  reason: "Estoque baixo (7,8 kg) · ponto de pedido em 5 kg" },
    { name: "Alface americana",   qty: "12 pés", est: "R$ 54,00",  reason: "Próximo do vencimento · alta rotatividade" },
    { name: "Banana nanica",      qty: "20 kg",  est: "R$ 104,00", reason: "Consumo Açaí ↑22% nos últimos 7 dias" },
  ] },
  { sup: "Laticínios São Paulo",   contact: "WhatsApp · 11 9 7233-1188", lead: "24h", items: [
    { name: "Queijo muçarela",    qty: "15 kg",  est: "R$ 642,00", reason: "Ruptura iminente · Pizzaria consome 3,1 kg/dia" },
    { name: "Cheddar fatiado",    qty: "8 kg",   est: "R$ 512,00", reason: "Ruptura em 2 dias · Burguer 0,4 kg restantes" },
    { name: "Leite integral 1L",  qty: "24 un",  est: "R$ 129,60", reason: "Reposição padrão" },
  ] },
  { sup: "Embalagens BR",          contact: "Email · vendas@embalagens.br", lead: "48h", items: [
    { name: "Embalagem isopor 500ml",  qty: "500 un", est: "R$ 210,00", reason: "RUPTURA · Açaí parou de aceitar pedidos delivery" },
    { name: "Pote PP 750ml c/ tampa",  qty: "200 un", est: "R$ 136,00", reason: "Reposição preventiva" },
  ] },
  { sup: "Distribuidor Carnes BR", contact: "WhatsApp · 11 9 5102-7799", lead: "24h", items: [
    { name: "Carne bovina moída",  qty: "10 kg",  est: "R$ 384,00", reason: "Burguer consome 1,4 kg/dia" },
    { name: "Bacon em cubos",      qty: "4 kg",   est: "R$ 195,60", reason: "Estoque baixo" },
    { name: "Calabresa defumada",  qty: "3 kg",   est: "R$ 109,20", reason: "Pizzaria · estoque baixo" },
  ] },
];

// =====================================================================
// CMV REAL · derivado das saídas de estoque (consumo × custo) e do faturamento.
// Não há mais CMV teórico — CMV % = COGS_real / Receita × 100.
//
// CMV_DAILY: 30 dias (incluindo hoje, parcial), por operação.
// Gerado deterministicamente para que os números sejam estáveis entre renders.
// =====================================================================
const CMV_DAILY = (() => {
  const ops = [
    { op: "burguer",  baseRev: 4500, baseCmv: 29.0 },
    { op: "pizzaria", baseRev: 4000, baseCmv: 33.5 },
    { op: "acai",     baseRev: 2500, baseCmv: 38.0 },
    { op: "saudavel", baseRev: 1900, baseCmv: 27.0 },
  ];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = [];
  // Inclui hoje (parcial) + 30 dias para trás
  for (let dOff = 30; dOff >= 0; dOff--) {
    const date = new Date(today); date.setDate(today.getDate() - dOff);
    const dow = date.getDay(); // 0=Dom .. 6=Sáb
    const weekend = (dow === 0 || dow === 6) ? 1.18
                  : (dow === 5)              ? 1.12
                  : (dow === 1)              ? 0.92
                                             : 1.00;
    const partial = (dOff === 0) ? 0.45 : 1.00; // hoje · ainda meio dia
    ops.forEach((o, i) => {
      const seed = ((date.getDate() * 31) + (date.getMonth() * 17) + i * 11) % 100;
      const revNoise = ((seed % 21) - 10) / 100;  // ±10%
      const cmvNoise = ((seed * 7 % 13) - 6) / 10; // ±0,6pp
      const revenue  = Math.round(o.baseRev * weekend * partial * (1 + revNoise));
      const cmvPct   = Math.max(22, Math.min(45, o.baseCmv + cmvNoise));
      const cogs     = Math.round(revenue * cmvPct / 100);
      const dStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      out.push({ date: dStr, op: o.op, revenue, cogs });
    });
  }
  return out;
})();

// Metas por operação + razão de "itens compartilhados" no CMV.
// sharedRatio = fração do CMV que vem de insumos usados por mais de uma
// operação (cebola, queijo, embalagens etc.). Em cinza no início da barra
// para separar do CMV exclusivo da operação.
const CMV_TABLE = [
  { op: "burguer",  goal: 30.0, sharedRatio: 0.25 },
  { op: "pizzaria", goal: 31.0, sharedRatio: 0.40 },
  { op: "acai",     goal: 35.0, sharedRatio: 0.20 },
  { op: "saudavel", goal: 28.0, sharedRatio: 0.50 },
];

// Top insumos com maior R$ saído do estoque nos últimos 7 dias.
// Substitui o antigo "Top fichas com CMV alto" (que dependia da ficha técnica).
const TOP_CONSUMED = [
  { item: "Carne bovina moída 80/20", op: "burguer",  qty: 28.4, unit: "kg",  value: 1090.56 },
  { item: "Queijo muçarela bola",      op: "pizzaria", qty: 22.0, unit: "kg",  value:  941.60 },
  { item: "Polpa de açaí 1kg",         op: "acai",     qty: 38,   unit: "und", value:  718.20 },
  { item: "Pão brioche burguer",       op: "burguer",  qty: 320,  unit: "und", value:  576.00 },
  { item: "Cheddar fatiado",           op: "burguer",  qty: 8.5,  unit: "kg",  value:  544.00 },
  { item: "Frango peito desfiado",     op: "saudavel", qty: 14.0, unit: "kg",  value:  459.20 },
  { item: "Farinha tipo 00",           op: "pizzaria", qty: 62,   unit: "kg",  value:  384.40 },
  { item: "Embalagem isopor 500ml",    op: "acai",     qty: 720,  unit: "und", value:  302.40 },
];

// Preparos (sub-receitas) — fichas sem preço de venda, com aproveitamento (yield).
// Custo unitário do preparo = soma dos custos dos insumos / aproveitamento.
// Aparecem na lista de insumos disponíveis para outras fichas e preparos.
const PREPARATIONS = [
  {
    id: "PRP-001", op: "burguer", cat: "outro",
    name: "Maionese da casa",
    yieldQty: 1, yieldUnit: "kg",
    items: [
      ["Maionese pronta", "0,8 kg", 12.00],
      ["Mostarda Dijon",  "0,1 kg",  4.00],
      ["Limão",           "2 un",    1.50],
      ["Ervas finas",     "0,02 kg", 1.20],
    ],
    theo: 18.70,
    unitCost: 18.70,
  },
  {
    id: "PRP-002", op: "pizzaria", cat: "outro",
    name: "Massa de pizza pré-fermentada",
    yieldQty: 5, yieldUnit: "und",
    items: [
      ["Farinha 00", "1,4 kg",   8.68],
      ["Água",       "0,9 kg",   0.10],
      ["Sal",        "0,03 kg",  0.20],
      ["Fermento",   "5 g",      0.40],
      ["Azeite",     "30 ml",    1.92],
    ],
    theo: 11.30,
    unitCost: 2.26,
  },
];

// Categorias de produto/ficha técnica — distintas de operação.
// Uma operação pode ter várias categorias (ex.: Forno & Brasa: Hambúrgueres + Acompanhamentos).
const RECIPE_CATEGORIES = [
  { id: "principal",     label: "Pratos principais",      color: "#3d6cb0" },
  { id: "lanche",        label: "Lanches / Sanduíches",   color: "#c2843a" },
  { id: "pizza",         label: "Pizzas",                 color: "#b04545" },
  { id: "marmita",       label: "Marmitas",               color: "#2d8c66" },
  { id: "sobremesa",     label: "Sobremesas",             color: "#6b5fb0" },
  { id: "bebida",        label: "Bebidas",                color: "#1aa39e" },
  { id: "acompanhamento",label: "Acompanhamentos",        color: "#8a9098" },
  { id: "combo",         label: "Combos / Promoções",     color: "#c98a3a" },
  { id: "outro",         label: "Outro",                  color: "#666c75" },
];

const TECH_SHEETS = [
  { id: "FIC-001", op: "burguer", cat: "lanche", name: "Brasa Cheddar Bacon",   price: 36.90, theo: 11.32, cmv: 30.7, items: [
    ["Pão brioche",   "1 un",   1.80],
    ["Carne 80/20",   "0,16 kg", 6.14],
    ["Cheddar fatiado", "0,04 kg", 2.56],
    ["Bacon",          "0,02 kg", 0.98],
    ["Embalagem",      "1 un",   1.20],
  ]},
  { id: "FIC-002", op: "pizzaria", cat: "pizza", name: "Stefano Margherita",    price: 58.00, theo: 19.78, cmv: 34.1, items: [
    ["Massa 280g",     "1 un",   3.40],
    ["Muçarela",       "0,18 kg", 7.70],
    ["Tomate pelati",  "0,12 kg", 1.92],
    ["Manjericão",     "5 un",    0.80],
    ["Azeite",         "10 ml",   0.64],
    ["Embalagem",      "1 un",    2.30],
  ]},
  { id: "FIC-003", op: "acai", cat: "sobremesa", name: "Açaí Tradicional 500ml",   price: 24.90, theo: 9.64,  cmv: 38.7, items: [
    ["Polpa açaí",     "0,30 kg", 5.67],
    ["Banana",         "0,10 kg", 0.52],
    ["Granola",        "0,03 kg", 0.85],
    ["Embalagem 500ml", "1 un",   0.42],
    ["Colher",         "1 un",    0.18],
  ]},
  { id: "FIC-004", op: "saudavel", cat: "marmita", name: "Marmita Frango/Quinoa", price: 38.90, theo: 10.58, cmv: 27.2, items: [
    ["Frango desfiado", "0,12 kg", 3.94],
    ["Quinoa cozida",   "0,08 kg", 1.76],
    ["Mix folhas",      "0,06 kg", 0.84],
    ["Pote PP 750ml",   "1 un",    0.68],
    ["Molho",           "1 un",    0.40],
  ]},
];

// ============ FINANCEIRO / DRE ============
// Categorias DRE — cada uma se encaixa em um "grupo" da DRE
// groups: receita | deducoes | cmv | pessoal | ocupacao | marketing | operacional | financeiro | outras
// =====================================================================
// Estrutura da DRE · 2 níveis: Categoria → Subcategoria → Lançamento
//
// Categoria: agregação de topo na DRE (Receita, CMV, Pessoal, etc.)
//   - kind: define como entra no cálculo
//       revenue   → soma na receita bruta
//       deduction → deduz da receita bruta
//       cogs      → deduz da receita líquida (entra no lucro bruto)
//       expense   → deduz do lucro bruto (OPEX)
//       financial → variante de expense (despesas financeiras)
//   - locked: true → essencial, não pode ser excluída pelo usuário
//   - autofeed: identifica origem automática (sub-categorias podem ter o mesmo)
//
// Subcategoria: pertence a uma Categoria. Lançamentos referenciam subcategoria
//   pelo campo `cat` em ENTRIES (legado de quando era categoria de 1 nível).
// =====================================================================
const DRE_CATEGORIES = [
  { id: "receita",    name: "Receita bruta",     kind: "revenue",   order: 1, locked: true,  autofeed: "revenue" },
  { id: "deducoes",   name: "Deduções e taxas",  kind: "deduction", order: 2, locked: true },
  { id: "cmv",        name: "CMV",               kind: "cogs",      order: 3, locked: true },
  { id: "pessoal",    name: "Pessoal",           kind: "expense",   order: 4 },
  { id: "ocupacao",   name: "Ocupação",          kind: "expense",   order: 5 },
  { id: "marketing",  name: "Marketing",         kind: "expense",   order: 6 },
  { id: "operacional",name: "Operacional",       kind: "expense",   order: 7 },
  { id: "financeiro", name: "Financeiro",        kind: "financial", order: 8 },
  { id: "outras",     name: "Outras despesas",   kind: "expense",   order: 9 },
];

// Subcategorias · referenciadas em ENTRIES.cat (mesmo id que existia antes).
// Algumas têm `autofeed` indicando que recebem valores automaticamente:
//   "stock-adjust" → soma do impacto financeiro de inventários finalizados.
const DRE_SUBCATEGORIES = [
  // Receita
  { id: "cat-01", name: "Vendas iFood",            category: "receita",   color: "#b04545" },
  { id: "cat-02", name: "Vendas Rappi",            category: "receita",   color: "#c2843a" },
  { id: "cat-03", name: "Vendas balcão",           category: "receita",   color: "#2d8c66" },
  // Deduções
  { id: "cat-10", name: "Comissão iFood (23%)",    category: "deducoes",  color: "#b04545" },
  { id: "cat-11", name: "Comissão Rappi (18%)",    category: "deducoes",  color: "#c2843a" },
  { id: "cat-12", name: "Impostos (Simples)",      category: "deducoes",  color: "#8a9098" },
  { id: "cat-13", name: "Taxa cartão balcão",      category: "deducoes",  color: "#8a9098" },
  // CMV · Compras + Ajuste automático
  { id: "cat-20", name: "Compras hortifruti",      category: "cmv",       color: "#2d8c66" },
  { id: "cat-21", name: "Compras carnes",          category: "cmv",       color: "#b04545" },
  { id: "cat-22", name: "Compras laticínios",      category: "cmv",       color: "#c2843a" },
  { id: "cat-23", name: "Compras embalagens",      category: "cmv",       color: "#8a9098" },
  { id: "cat-24", name: "Compras secos/mercearia", category: "cmv",       color: "#6b5fb0" },
  { id: "cat-29", name: "Ajuste de estoque",       category: "cmv",       color: "#8a9098", autofeed: "stock-adjust", locked: true },
  // Pessoal
  { id: "cat-30", name: "Salários cozinha",        category: "pessoal",   color: "#3d6cb0" },
  { id: "cat-31", name: "Encargos (INSS/FGTS)",    category: "pessoal",   color: "#3d6cb0" },
  { id: "cat-32", name: "Vale transporte/refeição",category: "pessoal",   color: "#3d6cb0" },
  { id: "cat-33", name: "Pró-labore",              category: "pessoal",   color: "#3d6cb0" },
  // Ocupação
  { id: "cat-40", name: "Aluguel cozinha",         category: "ocupacao",  color: "#6b5fb0" },
  { id: "cat-41", name: "Energia elétrica",        category: "ocupacao",  color: "#c2843a" },
  { id: "cat-42", name: "Água e gás",              category: "ocupacao",  color: "#3d6cb0" },
  { id: "cat-43", name: "Internet",                category: "ocupacao",  color: "#8a9098" },
  // Marketing
  { id: "cat-50", name: "Mídia paga iFood",        category: "marketing", color: "#b04545" },
  { id: "cat-51", name: "Mídia paga Instagram",    category: "marketing", color: "#c2843a" },
  // Operacional
  { id: "cat-60", name: "Limpeza e descartáveis",  category: "operacional", color: "#8a9098" },
  { id: "cat-61", name: "Manutenção equipamentos", category: "operacional", color: "#8a9098" },
  // Financeiro
  { id: "cat-70", name: "Tarifas bancárias",       category: "financeiro",  color: "#8a9098" },
  { id: "cat-71", name: "Juros empréstimos",       category: "financeiro",  color: "#b04545" },
];

// Lançamentos — competência maio/2026 (mês atual)
const ENTRIES = [
  // Receitas: vindas automaticamente do módulo Faturamento (REVENUE_ENTRIES)
  // Deduções
  { id: "LAN-1010", cat: "cat-10", desc: "Comissão iFood maio",            op: "all",       value: 13717.00,  comp: "2026-05-15", paid: "2026-05-22", status: "scheduled" },
  { id: "LAN-1011", cat: "cat-11", desc: "Comissão Rappi maio",            op: "all",       value: 3315.00,   comp: "2026-05-15", paid: "2026-05-30", status: "scheduled" },
  { id: "LAN-1012", cat: "cat-12", desc: "Simples Nacional · DAS maio",    op: "all",       value: 4870.00,   comp: "2026-05-31", paid: "2026-06-20", status: "pending" },
  // CMV / compras
  { id: "LAN-1020", cat: "cat-20", desc: "Hortifruti Zona Leste · NF 2284", op: "all",      value: 1840.00,   comp: "2026-05-03", paid: "2026-05-10", status: "paid"  },
  { id: "LAN-1021", cat: "cat-21", desc: "Distribuidor Carnes BR · NF 0917", op: "all",     value: 4280.00,   comp: "2026-05-04", paid: "2026-05-18", status: "paid"  },
  { id: "LAN-1022", cat: "cat-22", desc: "Laticínios SP · NF 5520",         op: "all",      value: 3140.00,   comp: "2026-05-04", paid: "2026-05-19", status: "paid"  },
  { id: "LAN-1023", cat: "cat-23", desc: "Embalagens BR · NF 1180",         op: "all",      value: 1620.00,   comp: "2026-05-06", paid: "2026-06-04", status: "scheduled" },
  { id: "LAN-1024", cat: "cat-24", desc: "Atacadão · NF 88210",             op: "all",      value: 2410.00,   comp: "2026-05-02", paid: "2026-05-02", status: "paid"  },
  { id: "LAN-1025", cat: "cat-20", desc: "Hortifruti Zona Leste · NF 2298", op: "all",      value: 1290.00,   comp: "2026-05-08", paid: "2026-05-15", status: "paid"  },
  { id: "LAN-1026", cat: "cat-22", desc: "Laticínios SP · NF 5588",         op: "all",      value: 2580.00,   comp: "2026-05-09", paid: "2026-05-24", status: "scheduled" },
  // Pessoal
  { id: "LAN-1030", cat: "cat-30", desc: "Folha cozinha maio",              op: "all",      value: 18400.00,  comp: "2026-05-31", paid: "2026-06-05", status: "scheduled" },
  { id: "LAN-1031", cat: "cat-31", desc: "INSS / FGTS maio",                op: "all",      value: 5240.00,   comp: "2026-05-31", paid: "2026-06-20", status: "pending" },
  { id: "LAN-1032", cat: "cat-32", desc: "VR/VT cozinha",                    op: "all",      value: 1480.00,   comp: "2026-05-01", paid: "2026-05-01", status: "paid"  },
  { id: "LAN-1033", cat: "cat-33", desc: "Pró-labore Rafa",                  op: "all",      value: 6500.00,   comp: "2026-05-31", paid: "2026-06-05", status: "scheduled" },
  // Ocupação
  { id: "LAN-1040", cat: "cat-40", desc: "Aluguel cozinha · maio",           op: "all",      value: 7800.00,   comp: "2026-05-01", paid: "2026-05-05", status: "paid"  },
  { id: "LAN-1041", cat: "cat-41", desc: "Enel · maio",                      op: "all",      value: 2840.00,   comp: "2026-05-01", paid: "2026-05-22", status: "scheduled" },
  { id: "LAN-1042", cat: "cat-42", desc: "Sabesp + GLP · maio",              op: "all",      value: 1640.00,   comp: "2026-05-01", paid: "2026-05-18", status: "paid"  },
  { id: "LAN-1043", cat: "cat-43", desc: "Vivo Empresas",                    op: "all",      value: 380.00,    comp: "2026-05-10", paid: "2026-05-20", status: "scheduled" },
  // Marketing
  { id: "LAN-1050", cat: "cat-50", desc: "Patrocinado iFood",                op: "all",      value: 1840.00,   comp: "2026-05-15", paid: "2026-05-22", status: "scheduled" },
  { id: "LAN-1051", cat: "cat-51", desc: "Meta Ads · campanha açaí",         op: "acai",     value: 620.00,    comp: "2026-05-08", paid: "2026-05-08", status: "paid"  },
  // Operacional
  { id: "LAN-1060", cat: "cat-60", desc: "Limpeza e descartáveis",           op: "all",      value: 720.00,    comp: "2026-05-04", paid: "2026-05-04", status: "paid"  },
  { id: "LAN-1061", cat: "cat-61", desc: "Manutenção forno pizza",           op: "pizzaria", value: 480.00,    comp: "2026-05-06", paid: "2026-05-06", status: "paid"  },
  // Financeiro
  { id: "LAN-1070", cat: "cat-70", desc: "Tarifas Itaú",                     op: "all",      value: 184.00,    comp: "2026-05-31", paid: "2026-05-31", status: "scheduled" },
];

// Checklist de fechamento — gastos recorrentes pré-cadastrados
// que precisam ser preenchidos com valor para entrar na DRE do mês.
// status: "filled" (já virou lançamento) | "estimated" (valor estimado, aguardando NF) | "pending" (sem valor ainda)
// recurrence: "monthly" | "biweekly" | "weekly" | "variable"
const CLOSING_CHECKLIST = [
  // RECEITAS
  { id: "chk-r01", cat: "cat-01", label: "Vendas iFood — fechamento mensal",        recurrence: "monthly",  due: 31, owner: "Rafa",      status: "filled",    expected: 59640.00, actual: 59640.00, entryIds: ["LAN-1001","LAN-1002"], required: true,  source: "Integração iFood" },
  { id: "chk-r02", cat: "cat-02", label: "Vendas Rappi — fechamento mensal",        recurrence: "monthly",  due: 31, owner: "Rafa",      status: "filled",    expected: 18000.00, actual: 18420.00, entryIds: ["LAN-1003"],            required: true,  source: "Integração Rappi" },
  { id: "chk-r03", cat: "cat-03", label: "Vendas balcão — fechamento mensal",       recurrence: "monthly",  due: 31, owner: "Rafa",      status: "filled",    expected: 12000.00, actual: 12180.00, entryIds: ["LAN-1004"],            required: true,  source: "PDV interno" },

  // DEDUÇÕES
  { id: "chk-d01", cat: "cat-10", label: "Comissão iFood",                          recurrence: "monthly",  due: 15, owner: "Rafa",      status: "filled",    expected: 13500.00, actual: 13717.00, entryIds: ["LAN-1010"], required: true,  source: "Extrato iFood",  formula: "≈ 23% das vendas iFood" },
  { id: "chk-d02", cat: "cat-11", label: "Comissão Rappi",                          recurrence: "monthly",  due: 15, owner: "Rafa",      status: "filled",    expected: 3300.00,  actual: 3315.00,  entryIds: ["LAN-1011"], required: true,  source: "Extrato Rappi",  formula: "≈ 18% das vendas Rappi" },
  { id: "chk-d03", cat: "cat-12", label: "DAS — Simples Nacional",                  recurrence: "monthly",  due: 20, owner: "Contador",  status: "filled",    expected: 4870.00,  actual: 4870.00,  entryIds: ["LAN-1012"], required: true,  source: "Guia DAS" },

  // CMV / COMPRAS — variáveis
  { id: "chk-c01", cat: "cat-20", label: "Hortifruti — semana 1 a 4",               recurrence: "weekly",   due: null, owner: "Estoquista", status: "filled",  expected: 3400.00,  actual: 3130.00,  entryIds: ["LAN-1020","LAN-1025"], required: false, source: "NF entrada" },
  { id: "chk-c02", cat: "cat-21", label: "Distribuidor de carnes",                  recurrence: "biweekly", due: null, owner: "Estoquista", status: "filled",  expected: 8500.00,  actual: 4280.00,  entryIds: ["LAN-1021"],            required: false, source: "NF entrada" },
  { id: "chk-c03", cat: "cat-22", label: "Laticínios",                              recurrence: "biweekly", due: null, owner: "Estoquista", status: "filled",  expected: 5800.00,  actual: 5720.00,  entryIds: ["LAN-1022","LAN-1026"], required: false, source: "NF entrada" },
  { id: "chk-c04", cat: "cat-23", label: "Embalagens",                              recurrence: "monthly",  due: 6,  owner: "Estoquista", status: "filled",    expected: 1700.00,  actual: 1620.00,  entryIds: ["LAN-1023"],            required: false, source: "NF entrada" },
  { id: "chk-c05", cat: "cat-24", label: "Atacadão — secos e mantimentos",          recurrence: "monthly",  due: 2,  owner: "Estoquista", status: "filled",    expected: 2400.00,  actual: 2410.00,  entryIds: ["LAN-1024"],            required: false, source: "NF entrada" },
  { id: "chk-c06", cat: "cat-22", label: "Laticínios — 2ª quinzena pendente",       recurrence: "biweekly", due: 25, owner: "Estoquista", status: "estimated", expected: 2900.00,  actual: null,     entryIds: [],                        required: true,  source: "Aguardando NF" },
  { id: "chk-c07", cat: "cat-21", label: "Carnes — 2ª quinzena pendente",           recurrence: "biweekly", due: 22, owner: "Estoquista", status: "pending",  expected: 4200.00,  actual: null,     entryIds: [],                        required: true,  source: "Aguardando NF" },

  // PESSOAL
  { id: "chk-p01", cat: "cat-30", label: "Folha de pagamento — cozinha",            recurrence: "monthly",  due: 5,  owner: "Contador",  status: "filled",    expected: 18400.00, actual: 18400.00, entryIds: ["LAN-1030"], required: true,  source: "Holerite" },
  { id: "chk-p02", cat: "cat-31", label: "INSS + FGTS",                             recurrence: "monthly",  due: 20, owner: "Contador",  status: "filled",    expected: 5240.00,  actual: 5240.00,  entryIds: ["LAN-1031"], required: true,  source: "Guias",            formula: "≈ 28% da folha" },
  { id: "chk-p03", cat: "cat-32", label: "VR / VT",                                 recurrence: "monthly",  due: 1,  owner: "Contador",  status: "filled",    expected: 1480.00,  actual: 1480.00,  entryIds: ["LAN-1032"], required: true,  source: "Operadora benefício" },
  { id: "chk-p04", cat: "cat-33", label: "Pró-labore sócios",                       recurrence: "monthly",  due: 5,  owner: "Rafa",      status: "filled",    expected: 6500.00,  actual: 6500.00,  entryIds: ["LAN-1033"], required: true,  source: "Manual" },

  // OCUPAÇÃO
  { id: "chk-o01", cat: "cat-40", label: "Aluguel cozinha",                         recurrence: "monthly",  due: 5,  owner: "Rafa",      status: "filled",    expected: 7800.00,  actual: 7800.00,  entryIds: ["LAN-1040"], required: true,  source: "Contrato" },
  { id: "chk-o02", cat: "cat-41", label: "Conta de luz — Enel",                     recurrence: "monthly",  due: 22, owner: "Rafa",      status: "filled",    expected: 2700.00,  actual: 2840.00,  entryIds: ["LAN-1041"], required: true,  source: "Fatura Enel" },
  { id: "chk-o03", cat: "cat-42", label: "Sabesp + GLP",                            recurrence: "monthly",  due: 18, owner: "Rafa",      status: "filled",    expected: 1640.00,  actual: 1640.00,  entryIds: ["LAN-1042"], required: true,  source: "Fatura" },
  { id: "chk-o04", cat: "cat-43", label: "Internet + telefonia — Vivo",             recurrence: "monthly",  due: 20, owner: "Rafa",      status: "filled",    expected: 380.00,   actual: 380.00,   entryIds: ["LAN-1043"], required: true,  source: "Fatura Vivo" },
  { id: "chk-o05", cat: "cat-40", label: "IPTU — parcela maio",                     recurrence: "monthly",  due: 10, owner: "Contador",  status: "pending",  expected: 420.00,   actual: null,     entryIds: [],            required: true,  source: "Guia IPTU" },

  // MARKETING
  { id: "chk-m01", cat: "cat-50", label: "Patrocinado iFood",                       recurrence: "monthly",  due: 22, owner: "Rafa",      status: "filled",    expected: 1800.00,  actual: 1840.00,  entryIds: ["LAN-1050"], required: false, source: "Painel iFood" },
  { id: "chk-m02", cat: "cat-51", label: "Meta Ads — campanhas",                    recurrence: "variable", due: null, owner: "Rafa",    status: "filled",    expected: 600.00,   actual: 620.00,   entryIds: ["LAN-1051"], required: false, source: "Cartão" },

  // OPERACIONAL
  { id: "chk-x01", cat: "cat-60", label: "Limpeza + descartáveis",                  recurrence: "monthly",  due: 4,  owner: "Estoquista", status: "filled",   expected: 720.00,   actual: 720.00,   entryIds: ["LAN-1060"], required: true,  source: "Compra direta" },
  { id: "chk-x02", cat: "cat-61", label: "Manutenções e reparos",                   recurrence: "variable", due: null, owner: "Rafa",    status: "filled",    expected: 0.00,     actual: 480.00,   entryIds: ["LAN-1061"], required: false, source: "Quando ocorrer" },
  { id: "chk-x03", cat: "cat-62", label: "Software e SaaS",                         recurrence: "monthly",  due: 15, owner: "Rafa",      status: "pending",  expected: 540.00,   actual: null,     entryIds: [],            required: true,  source: "Cartão" },

  // FINANCEIRO
  { id: "chk-f01", cat: "cat-70", label: "Tarifas bancárias — Itaú",                recurrence: "monthly",  due: 31, owner: "Contador",  status: "filled",    expected: 180.00,   actual: 184.00,   entryIds: ["LAN-1070"], required: true,  source: "Extrato" },
  { id: "chk-f02", cat: "cat-70", label: "Maquininha — taxas Stone",                recurrence: "monthly",  due: 31, owner: "Contador",  status: "estimated", expected: 380.00,   actual: null,     entryIds: [],            required: true,  source: "Extrato Stone" },
];

// Métodos de pagamento — base do cadastro de faturamento
const PAYMENT_METHODS = [
  { id: "debito",   label: "Débito",   short: "Déb",   color: "#3d6cb0" },
  { id: "credito",  label: "Crédito",  short: "Créd",  color: "#6b5fb0" },
  { id: "voucher",  label: "Voucher",  short: "Vchr",  color: "#c2843a" },
  { id: "dinheiro", label: "Dinheiro", short: "Din",   color: "#2d8c66" },
  { id: "pix",      label: "Pix",      short: "Pix",   color: "#1aa39e" },
  { id: "online",   label: "Online",   short: "Onl",   color: "#b04545" },
];

// Faturamento — agora cada entrada é um dia×operação com breakdown por método de pagamento
// A receita total = soma dos métodos. Alimenta a DRE.
const REVENUE_ENTRIES = [
  { id: 1,  date: "2026-05-06", op: "burguer",  orders: 184,
    methods: { debito: 1820.40, credito: 3210.50, voucher: 412.00,  dinheiro: 680.30,  pix: 1980.20, online: 780.80 },
    cogs: 2611.94, status: "confirmed" },
  { id: 2,  date: "2026-05-06", op: "pizzaria", orders: 142,
    methods: { debito: 1280.00, credito: 2940.60, voucher: 0,       dinheiro: 320.00,  pix: 1490.00, online: 2887.00 },
    cogs: 3040.90, status: "confirmed" },
  { id: 3,  date: "2026-05-06", op: "acai",     orders:  98,
    methods: { debito: 480.00,  credito: 920.00,  voucher: 0,       dinheiro: 280.80,  pix: 580.00,  online: 885.00 },
    cogs: 1217.42, status: "confirmed" },
  { id: 4,  date: "2026-05-06", op: "saudavel", orders:  74,
    methods: { debito: 320.00,  credito: 940.40,  voucher: 240.00,  dinheiro: 180.00,  pix: 420.20,  online: 778.00 },
    cogs: 782.97, status: "confirmed" },
  { id: 5,  date: "2026-05-05", op: "burguer",  orders: 167,
    methods: { debito: 1620.00, credito: 2880.10, voucher: 380.00,  dinheiro: 540.00,  pix: 1742.00, online: 900.00 },
    cogs: 2370.26, status: "confirmed" },
  { id: 6,  date: "2026-05-05", op: "pizzaria", orders: 138,
    methods: { debito: 1180.00, credito: 2820.40, voucher: 0,       dinheiro: 280.00,  pix: 1486.00, online: 2900.00 },
    cogs: 2782.91, status: "confirmed" },
  { id: 7,  date: "2026-05-05", op: "acai",     orders:  91,
    methods: { debito: 420.00,  credito: 880.10,  voucher: 0,       dinheiro: 261.00,  pix: 580.00,  online: 780.00 },
    cogs: 1098.33, status: "confirmed" },
  { id: 8,  date: "2026-05-05", op: "saudavel", orders:  68,
    methods: { debito: 280.00,  credito: 880.20,  voucher: 200.00,  dinheiro: 165.00,  pix: 380.00,  online: 740.00 },
    cogs: 719.49, status: "pending" },
  { id: 10, date: "2026-05-01", op: "burguer",  orders: 156,
    methods: { debito: 1480.00, credito: 2680.00, voucher: 320.00,  dinheiro: 540.00,  pix: 1620.00, online: 840.00 },
    cogs: 2200.00, status: "confirmed" },
  { id: 11, date: "2026-05-01", op: "pizzaria", orders: 132,
    methods: { debito: 1140.00, credito: 2620.00, voucher: 0,       dinheiro: 280.00,  pix: 1380.00, online: 2770.00 },
    cogs: 2620.00, status: "confirmed" },
  { id: 12, date: "2026-05-01", op: "acai",     orders:  88,
    methods: { debito: 380.00,  credito: 820.00,  voucher: 0,       dinheiro: 240.00,  pix: 560.00,  online: 780.00 },
    cogs: 1080.00, status: "confirmed" },
  { id: 13, date: "2026-05-01", op: "saudavel", orders:  61,
    methods: { debito: 240.00,  credito: 760.00,  voucher: 180.00,  dinheiro: 140.00,  pix: 360.00,  online: 700.00 },
    cogs: 650.00, status: "confirmed" },
].map((e) => ({ ...e, revenue: Object.values(e.methods).reduce((s, v) => s + v, 0) }));

// Estoque inicial e final do mês para CMV real = EI + Compras − EF
const STOCK_BALANCE = {
  initial:    { date: "2026-04-30", value: 42180.00 },
  final:      { date: "2026-05-31", value: 47218.00, projected: true },
  // currentMonth = mês de competência ativo
  monthLabel: "Maio / 2026",
};

// =====================================================================
// INVENTÁRIOS — contagens físicas do estoque, precisão e impacto financeiro
// =====================================================================
// Cada inventário registra:
//  - escopo: categorias e/ou operações cobertas
//  - items: snapshot do que era esperado (sistema) vs. o que foi contado (físico)
//  - cálculo agregado: divergências, precisão, impacto financeiro (perdas/sobras)
//  - status: in_progress | finalized | canceled
const INVENTORIES = [
  {
    id: "INV-2026-04-28",
    started_at:  "2026-04-28T09:00:00",
    finished_at: "2026-04-28T11:32:00",
    responsible: "André Oliveira",
    role:        "Estoquista",
    status:      "finalized",
    categories:  ["Hortifruti", "Laticínios", "Carnes"],
    items: [
      { stock_item_id: "INS-0001", name: "Tomate italiano",          cat: "Hortifruti", unit: "kg", expected: 14.2, counted: 13.8, cost: 8.90  },
      { stock_item_id: "INS-0009", name: "Alface americana",         cat: "Hortifruti", unit: "und", expected: 8,    counted: 7,    cost: 4.50  },
      { stock_item_id: "INS-0017", name: "Cebola roxa",              cat: "Hortifruti", unit: "kg", expected: 6.5,  counted: 6.5,  cost: 7.20  },
      { stock_item_id: "INS-0010", name: "Banana nanica",            cat: "Hortifruti", unit: "kg", expected: 12,   counted: 12,   cost: 5.20  },
      { stock_item_id: "INS-0002", name: "Queijo muçarela bola",     cat: "Laticínios", unit: "kg", expected: 4.0,  counted: 3.6,  cost: 42.80 },
      { stock_item_id: "INS-0007", name: "Cheddar fatiado",          cat: "Laticínios", unit: "kg", expected: 1.2,  counted: 0.4,  cost: 64.00 },
      { stock_item_id: "INS-0015", name: "Leite integral 1L",        cat: "Laticínios", unit: "und", expected: 24,   counted: 24,   cost: 5.40  },
      { stock_item_id: "INS-0005", name: "Carne bovina moída 80/20", cat: "Carnes",     unit: "kg", expected: 9.2,  counted: 9.2,  cost: 38.40 },
      { stock_item_id: "INS-0014", name: "Bacon em cubos",           cat: "Carnes",     unit: "kg", expected: 2.8,  counted: 2.5,  cost: 48.90 },
      { stock_item_id: "INS-0018", name: "Calabresa defumada",       cat: "Carnes",     unit: "kg", expected: 2.4,  counted: 2.4,  cost: 36.40 },
    ],
  },
  {
    id: "INV-2026-04-15",
    started_at:  "2026-04-15T08:30:00",
    finished_at: "2026-04-15T10:10:00",
    responsible: "André Oliveira",
    role:        "Estoquista",
    status:      "finalized",
    categories:  ["Embalagens", "Secos", "Mercearia"],
    items: [
      { stock_item_id: "INS-0003", name: "Embalagem isopor 500ml",   cat: "Embalagens", unit: "und", expected: 320,  counted: 295,  cost: 0.42  },
      { stock_item_id: "INS-0016", name: "Pote PP 750ml c/ tampa",   cat: "Embalagens", unit: "und", expected: 410,  counted: 410,  cost: 0.68  },
      { stock_item_id: "INS-0004", name: "Farinha tipo 00",          cat: "Secos",      unit: "kg", expected: 32.0, counted: 31.5, cost: 6.20  },
      { stock_item_id: "INS-0011", name: "Granola sem açúcar",       cat: "Secos",      unit: "kg", expected: 5.8,  counted: 5.8,  cost: 28.40 },
      { stock_item_id: "INS-0013", name: "Azeite extra virgem 500ml",cat: "Mercearia",  unit: "und", expected: 14,   counted: 13,   cost: 32.00 },
    ],
  },
  {
    id: "INV-2026-03-30",
    started_at:  "2026-03-30T08:00:00",
    finished_at: "2026-03-30T12:45:00",
    responsible: "Marina Costa",
    role:        "Operador cozinha",
    status:      "finalized",
    categories:  ["Hortifruti", "Laticínios", "Carnes", "Embalagens", "Secos"],
    items: [
      { stock_item_id: "INS-0001", name: "Tomate italiano",          cat: "Hortifruti", unit: "kg", expected: 16.0, counted: 14.4, cost: 8.90  },
      { stock_item_id: "INS-0017", name: "Cebola roxa",              cat: "Hortifruti", unit: "kg", expected: 8.0,  counted: 8.0,  cost: 7.20  },
      { stock_item_id: "INS-0009", name: "Alface americana",         cat: "Hortifruti", unit: "und", expected: 10,   counted: 9,    cost: 4.50  },
      { stock_item_id: "INS-0002", name: "Queijo muçarela bola",     cat: "Laticínios", unit: "kg", expected: 5.0,  counted: 5.0,  cost: 42.80 },
      { stock_item_id: "INS-0007", name: "Cheddar fatiado",          cat: "Laticínios", unit: "kg", expected: 2.0,  counted: 1.8,  cost: 64.00 },
      { stock_item_id: "INS-0005", name: "Carne bovina moída 80/20", cat: "Carnes",     unit: "kg", expected: 12.0, counted: 11.5, cost: 38.40 },
      { stock_item_id: "INS-0014", name: "Bacon em cubos",           cat: "Carnes",     unit: "kg", expected: 3.0,  counted: 3.0,  cost: 48.90 },
      { stock_item_id: "INS-0003", name: "Embalagem isopor 500ml",   cat: "Embalagens", unit: "und", expected: 500,  counted: 480,  cost: 0.42  },
      { stock_item_id: "INS-0016", name: "Pote PP 750ml c/ tampa",   cat: "Embalagens", unit: "und", expected: 380,  counted: 380,  cost: 0.68  },
      { stock_item_id: "INS-0004", name: "Farinha tipo 00",          cat: "Secos",      unit: "kg", expected: 30.0, counted: 30.0, cost: 6.20  },
      { stock_item_id: "INS-0011", name: "Granola sem açúcar",       cat: "Secos",      unit: "kg", expected: 6.0,  counted: 6.0,  cost: 28.40 },
    ],
  },
  {
    id: "INV-2026-02-26",
    started_at:  "2026-02-26T08:30:00",
    finished_at: "2026-02-26T11:45:00",
    responsible: "André Oliveira",
    role:        "Estoquista",
    status:      "finalized",
    categories:  ["Hortifruti", "Carnes", "Padaria"],
    items: [
      { stock_item_id: "INS-0001", name: "Tomate italiano",     cat: "Hortifruti", unit: "kg", expected: 13.0, counted: 11.8, cost: 8.90  },
      { stock_item_id: "INS-0010", name: "Banana nanica",       cat: "Hortifruti", unit: "kg", expected: 14.0, counted: 13.5, cost: 5.20  },
      { stock_item_id: "INS-0005", name: "Carne moída 80/20",   cat: "Carnes",     unit: "kg", expected: 10.0, counted: 9.2,  cost: 38.40 },
      { stock_item_id: "INS-0014", name: "Bacon em cubos",      cat: "Carnes",     unit: "kg", expected: 2.5,  counted: 2.0,  cost: 48.90 },
      { stock_item_id: "INS-0018", name: "Calabresa defumada",  cat: "Carnes",     unit: "kg", expected: 2.0,  counted: 2.0,  cost: 36.40 },
      { stock_item_id: "INS-0008", name: "Pão brioche burguer", cat: "Padaria",    unit: "und", expected: 120,  counted: 110,  cost: 1.80  },
    ],
  },
  {
    id: "INV-2026-05-07",
    started_at:  "2026-05-07T07:50:00",
    finished_at: null,
    responsible: "André Oliveira",
    role:        "Estoquista",
    status:      "in_progress",
    categories:  ["Hortifruti", "Laticínios"],
    items: [
      { stock_item_id: "INS-0001", name: "Tomate italiano",      cat: "Hortifruti", unit: "kg", expected: 12.4, counted: null, cost: 8.90  },
      { stock_item_id: "INS-0009", name: "Alface americana",     cat: "Hortifruti", unit: "und", expected: 6,    counted: null, cost: 4.50  },
      { stock_item_id: "INS-0017", name: "Cebola roxa",          cat: "Hortifruti", unit: "kg", expected: 7.8,  counted: null, cost: 7.20  },
      { stock_item_id: "INS-0010", name: "Banana nanica",        cat: "Hortifruti", unit: "kg", expected: 14,   counted: 14,   cost: 5.20  },
      { stock_item_id: "INS-0002", name: "Queijo muçarela bola", cat: "Laticínios", unit: "kg", expected: 3.2,  counted: 3.0,  cost: 42.80 },
      { stock_item_id: "INS-0007", name: "Cheddar fatiado",      cat: "Laticínios", unit: "kg", expected: 0.4,  counted: 0.4,  cost: 64.00 },
      { stock_item_id: "INS-0015", name: "Leite integral 1L",    cat: "Laticínios", unit: "und", expected: 18,   counted: null, cost: 5.40  },
    ],
  },
];

// Histórico mensal de precisão · alimenta o gráfico de evolução
const INVENTORY_HISTORY = [
  { month: "Nov/25", value: 86.2 },
  { month: "Dez/25", value: 87.8 },
  { month: "Jan/26", value: 89.1 },
  { month: "Fev/26", value: 88.6 },
  { month: "Mar/26", value: 90.4 },
  { month: "Abr/26", value: 92.1 },
];

// =====================================================================
// SYSTEM USERS · contas com permissão de login
// =====================================================================
// Senha em texto plano só pra protótipo; em produção vai por bcrypt + Auth.
// Roles: superadmin (vê todos os tenants) · owner/admin/manager (do tenant) ·
// kitchen/stock/accountant/viewer (operacionais)
const SYSTEM_USERS = [
  { email: "danilocaioavelino@gmail.com", password: "Danilo1542@@", name: "Danilo Avelino",   role: "superadmin", tenantId: null,  avatar: "DA" },
  { email: "rafa@cozinhacentral.com.br",  password: "rafa123",      name: "Rafa Medeiros",    role: "owner",      tenantId: "ten-1", avatar: "RM" },
  { email: "stefano@cozinhacentral.com.br",password:"stefano123",   name: "Stefano Bianchi",  role: "manager",    tenantId: "ten-1", avatar: "SB" },
  { email: "marina@cozinhacentral.com.br", password:"marina123",    name: "Marina Costa",     role: "kitchen",    tenantId: "ten-1", avatar: "MC" },
  { email: "andre@cozinhacentral.com.br",  password:"andre123",     name: "André Oliveira", role: "stock", tenantId: "ten-1", avatar: "AO" },
];

// =====================================================================
// SYSTEM TENANTS · clientes da plataforma StockKitchen (visão superadmin)
// =====================================================================
const SYSTEM_TENANTS = [
  {
    id: "ten-1", slug: "mobydick", name: "MobyDick Dark Kitchen", legalName: "Cozinha Central SP Ltda",
    plan: "pro", status: "active", users: 6, ops: 4,
    mrr: 489, revenue30d: 218400,
    createdAt: "2025-09-12", lastLogin: "2026-05-09T09:18:00",
    region: "São Paulo · SP", cnpj: "42.580.319/0001-08",
    health: "ok", // ok | warn | crit
    cmvAvg: 32.8,
  },
  {
    id: "ten-2", slug: "burgerlab",  name: "Burger Lab Curitiba",
    plan: "starter", status: "active", users: 3, ops: 1,
    mrr: 189, revenue30d: 84000,
    createdAt: "2026-01-22", lastLogin: "2026-05-09T07:30:00",
    region: "Curitiba · PR", cnpj: "31.904.220/0001-44",
    health: "ok", cmvAvg: 29.1,
  },
  {
    id: "ten-3", slug: "hub-pizzas", name: "Hub das Pizzas SP",
    plan: "enterprise", status: "active", users: 12, ops: 6,
    mrr: 989, revenue30d: 412000,
    createdAt: "2025-04-01", lastLogin: "2026-05-09T09:15:00",
    region: "São Paulo · SP", cnpj: "18.221.560/0001-71",
    health: "warn", cmvAvg: 33.4,
  },
  {
    id: "ten-4", slug: "saudaveis-belo", name: "Saudáveis BH",
    plan: "pro", status: "active", users: 5, ops: 2,
    mrr: 489, revenue30d: 156800,
    createdAt: "2025-11-15", lastLogin: "2026-05-08T22:00:00",
    region: "Belo Horizonte · MG", cnpj: "27.118.402/0001-22",
    health: "ok", cmvAvg: 27.8,
  },
  {
    id: "ten-5", slug: "doces-rio",  name: "Doces do Rio",
    plan: "starter", status: "trial", users: 2, ops: 1,
    mrr: 0, revenue30d: 38400,
    createdAt: "2026-04-28", lastLogin: "2026-05-09T01:42:00",
    region: "Rio de Janeiro · RJ", cnpj: "44.205.881/0001-15",
    health: "ok", cmvAvg: 31.0,
  },
  {
    id: "ten-6", slug: "tapioca-rec", name: "Tapioca Recife",
    plan: "starter", status: "suspended", users: 1, ops: 1,
    mrr: 0, revenue30d: 0,
    createdAt: "2025-07-04", lastLogin: "2026-04-12T08:00:00",
    region: "Recife · PE", cnpj: "36.412.703/0001-09",
    health: "crit", cmvAvg: 41.2,
  },
];

// MRR mensal · últimos 12 meses (visão superadmin)
const SYSTEM_MRR_HISTORY = [
  { month: "Jun/25", mrr: 489 },
  { month: "Jul/25", mrr: 489 },
  { month: "Ago/25", mrr: 989 + 489 },
  { month: "Set/25", mrr: 989 + 489 + 489 },
  { month: "Out/25", mrr: 989 + 489 + 489 },
  { month: "Nov/25", mrr: 989 + 489 + 489 + 489 },
  { month: "Dez/25", mrr: 989 + 489 + 489 + 489 },
  { month: "Jan/26", mrr: 989 + 489 + 489 + 489 + 189 },
  { month: "Fev/26", mrr: 989 + 489 + 489 + 489 + 189 },
  { month: "Mar/26", mrr: 989 + 489 + 489 + 489 + 189 },
  { month: "Abr/26", mrr: 989 + 489 + 489 + 489 + 189 },
  { month: "Mai/26", mrr: 989 + 489 + 489 + 489 + 189 },
];

window.MOCK = {
  OPERATIONS, KPI, STOCK_ITEMS, SUPPLIERS, REQUESTS, SHOPPING, SHOPPING_LISTS, GOODS_RECEIPTS,
  INVENTORIES, INVENTORY_HISTORY,
  CMV_DAILY, CMV_TABLE, TOP_CONSUMED, TECH_SHEETS, RECIPE_CATEGORIES, PREPARATIONS,
  DRE_CATEGORIES, DRE_SUBCATEGORIES, ENTRIES, STOCK_BALANCE, CLOSING_CHECKLIST, REVENUE_ENTRIES, PAYMENT_METHODS,
  SYSTEM_USERS, SYSTEM_TENANTS, SYSTEM_MRR_HISTORY,
  revenueBySource: () => {
    // Agrupa faturamento por fonte para alimentar a DRE
    const bySource = {};
    REVENUE_ENTRIES.forEach((e) => {
      const src = e.source === "ifood" ? "iFood" : e.source === "rappi" ? "Rappi" : e.source === "pdv" ? "PDV" : "Balcão / Manual";
      bySource[src] = (bySource[src] || 0) + e.revenue;
    });
    return bySource;
  },
  opById: (id) => {
    // Usa a lista corrente de window.MOCK.OPERATIONS (substituída por dbGetCurrentContext
    // após login). Cai pro array original se o window ainda não tem MOCK pronto.
    const list = (typeof window !== "undefined" && window.MOCK?.OPERATIONS) || OPERATIONS;
    return list.find((o) => o.id === id)
        || list.find((o) => o.slug === id)
        || { id: id || "all", name: "—", short: "—", color: "#8a9098" };
  },
  // Renomeados na refatoração da DRE (mantemos os antigos como aliases)
  subcategoryById: (id) => DRE_SUBCATEGORIES.find((c) => c.id === id),
  categoryById:    (id) => DRE_CATEGORIES.find((g) => g.id === id),
  catById:         (id) => DRE_SUBCATEGORIES.find((c) => c.id === id),
  groupById:       (id) => DRE_CATEGORIES.find((g) => g.id === id),
  recipeCatById: (id) => RECIPE_CATEGORIES.find((c) => c.id === id),
  prepById: (id) => PREPARATIONS.find((p) => p.id === id),
  supplierByName: (name) => SUPPLIERS.find((s) => s.name === name),
};

// Quando DB está online, esvazia TODOS os arrays MOCK para que páginas exibam
// somente dados reais. Helpers (opById, etc) continuam funcionando com defaults.
window.clearMockData = function clearMockData() {
  const arrayKeys = [
    "OPERATIONS","KPI","STOCK_ITEMS","SUPPLIERS","REQUESTS","SHOPPING","SHOPPING_LISTS","GOODS_RECEIPTS",
    "INVENTORIES","INVENTORY_HISTORY","CMV_DAILY","CMV_TABLE","TOP_CONSUMED","TECH_SHEETS","RECIPE_CATEGORIES","PREPARATIONS",
    "DRE_CATEGORIES","DRE_SUBCATEGORIES","ENTRIES","CLOSING_CHECKLIST","REVENUE_ENTRIES","PAYMENT_METHODS",
    "SYSTEM_USERS","SYSTEM_TENANTS","SYSTEM_MRR_HISTORY",
  ];
  arrayKeys.forEach((k) => { if (Array.isArray(window.MOCK[k])) window.MOCK[k] = []; });
  // Objetos compostos: zera valores
  if (window.MOCK.STOCK_BALANCE) {
    window.MOCK.STOCK_BALANCE = { initial: { value: 0 }, final: { value: 0 } };
  }
};

// =====================================================================
// Busca tolerante (fuzzy) · compartilhada por Estoque, Financeiro, etc.
// =====================================================================
// Normaliza p/ comparação: minúsculas + sem acentos.
function normalizeSearch(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Distância de edição Damerau-Levenshtein (OSA) com corte por `max`: além de
// inserção/remoção/substituição, conta a TROCA de duas letras adjacentes como 1
// edição — o erro de digitação mais comum ("tomtae" → "tomate"). Aborta cedo
// quando uma linha inteira já passa de `max`.
function _editDistance(a, b, max) {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  const d = [];
  for (let i = 0; i <= al; i++) { d[i] = new Array(bl + 1); d[i][0] = i; }
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2][j - 2] + 1); // transposição adjacente
      }
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return d[al][bl];
}

// Tolerância de erros aceitos conforme o tamanho do termo digitado.
function _searchTol(len) {
  if (len <= 2) return 0;   // termos curtíssimos: exige exatidão p/ evitar ruído
  if (len <= 4) return 1;
  if (len <= 7) return 2;
  return 3;
}

// Casa `query` contra `text` aceitando aproximações. Regras (por token da busca):
//   1. substring exata (comportamento antigo, rápido) → casa;
//   2. erro de digitação: palavra do texto dentro da tolerância de edição do
//      token, comparando a palavra inteira OU o prefixo do mesmo tamanho do
//      token (pega erro no meio/fim de nomes longos).
// Todos os tokens precisam casar (AND), então buscas com várias palavras seguem
// restritivas. Ex.: "tomate" casa "tomtae"/"tomats"; "arroz" casa "aroz".
function fuzzyMatch(text, query) {
  const t = normalizeSearch(text);
  const q = normalizeSearch(query).trim();
  if (!q) return true;
  if (t.includes(q)) return true;
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.every((qt) => {
    if (t.includes(qt)) return true;
    const tol = _searchTol(qt.length);
    if (tol === 0) return false;
    return words.some((w) =>
      _editDistance(w, qt, tol) <= tol ||
      (w.length > qt.length && _editDistance(w.slice(0, qt.length), qt, tol) <= tol)
    );
  });
}

window.normalizeSearch = normalizeSearch;
window.fuzzyMatch = fuzzyMatch;

// =====================================================================
// Fuso horário · dia/mês local de São Paulo a partir de um timestamp
// =====================================================================
// Colunas timestamptz (performed_at, finished_at, created_at, closed_at…) chegam
// em UTC. Fatiar a string ISO (slice 0,10 / 0,7) dá o dia/mês em UTC — registros
// perto da meia-noite caem no dia/mês errado e divergem dos limites de período,
// que são calculados no fuso local (SP). Use estes helpers para atribuir
// dia/mês de calendário a partir de um timestamp. (Campos `date` puros, como
// business_date/competence_date, NÃO precisam — já são data de calendário.)
function spDay(iso) {
  if (!iso) return "";
  const s = String(iso);
  // Já é data de calendário (sem horário) → devolve como está. Sem isso,
  // new Date("2026-05-20") é lido como UTC e converter pra SP voltaria 1 dia.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date(s).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
function spMonth(iso) { return iso ? spDay(iso).slice(0, 7) : ""; }
window.spDay = spDay;
window.spMonth = spMonth;
