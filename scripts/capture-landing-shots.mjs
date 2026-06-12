// Captura prints reais do app para a landing page (landing/shots/*.png).
// Uso:  SK_URL=http://localhost:5174 SK_EMAIL=... SK_PASS=... node scripts/capture-landing-shots.mjs
// Usa o Edge instalado via puppeteer-core — não baixa navegador.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const URL_BASE = process.env.SK_URL || "http://localhost:5174";
const EMAIL = process.env.SK_EMAIL;
const PASS = process.env.SK_PASS;
if (!EMAIL || !PASS) { console.error("Defina SK_EMAIL e SK_PASS"); process.exit(1); }

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const edge = EDGE_PATHS.find((p) => fs.existsSync(p));
if (!edge) { console.error("Edge não encontrado"); process.exit(1); }

const OUT = path.resolve("landing/shots");
fs.mkdirSync(OUT, { recursive: true });

// rotas do shell (viewport desktop) — slug → nome do arquivo
const ROUTES = [
  ["dashboard", "dashboard"],
  ["estoque", "estoque"],
  ["fichas-tecnicas", "fichas"],
  ["requisicoes", "requisicoes"],
  ["compras", "compras"],
  ["cmv", "cmv"],
  ["financeiro", "financeiro"],
  ["dre", "dre"],
  ["faturamento", "faturamento"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: edge,
  headless: "new",
  args: ["--hide-scrollbars", "--force-device-scale-factor=2"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 880, deviceScaleFactor: 2 });

  console.log("abrindo", URL_BASE);
  await page.goto(URL_BASE, { waitUntil: "networkidle2", timeout: 60000 });

  // login
  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.type('input[type="email"]', EMAIL, { delay: 15 });
  await page.type('input[type="password"]', PASS, { delay: 15 });
  await page.keyboard.press("Enter");
  console.log("login enviado, aguardando app…");

  // espera o shell montar (sidebar com "Dashboard") e os dados carregarem
  await page.waitForFunction(
    () => !document.querySelector('input[type="password"]') && document.body.innerText.includes("Dashboard"),
    { timeout: 60000 }
  );
  await sleep(9000); // primeiras queries do Supabase

  for (const [slug, name] of ROUTES) {
    await page.evaluate((s) => { window.location.hash = `/${s}`; }, slug);
    await sleep(7000); // queries da página
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("ok:", name);
  }

  // tela mobile (#/mobile) em viewport de celular
  const mob = await browser.newPage();
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto(`${URL_BASE}/#/mobile`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(8000);
  await mob.screenshot({ path: path.join(OUT, "mobile.png") });
  console.log("ok: mobile");

  console.log("concluído →", OUT);
} finally {
  await browser.close();
}
