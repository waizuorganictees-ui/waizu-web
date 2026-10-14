// Genera la web que se publica en waizu.es (carpeta _site/).
//
// La fuente sigue siendo index.html. Este script crea, además, una página por
// cada dirección de la lista <script id="waizu-paginas"> (/catalogo/,
// /contacto/…), cada una con su título, descripción, canonical, Open Graph,
// datos estructurados y una copia estática del contenido. La copia la leen los
// buscadores y asistentes de IA que no ejecutan JavaScript; quien visita la web
// ve exactamente la misma página de siempre (la copia se oculta y se retira en
// cuanto arranca la web).
//
// Uso:  node herramientas/generar-paginas.mjs [carpeta-de-salida]
// Lo ejecuta GitHub Actions en cada cambio de master (.github/workflows/publicar.yml).
// Variable opcional: CHROMIUM_PATH, para usar un Chromium ya instalado.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SALIDA = path.resolve(process.argv[2] || path.join(RAIZ, '_site'));
const DOMINIO = 'https://waizu.es';
const NO_PUBLICAR = new Set(['herramientas', 'node_modules', '_site', 'README.md', 'serve.js']); // y los archivos que empiezan por punto

const fuente = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
const { paginas } = JSON.parse(
  fuente.match(/<script type="application\/json" id="waizu-paginas">([\s\S]*?)<\/script>/)[1],
);
const grafo = JSON.parse(
  fuente.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
)['@graph'];

const errores = [];
const aviso = (ruta, texto) => errores.push(`${ruta}: ${texto}`);

// ---------- 1. Copiar los archivos de la web ----------
fs.rmSync(SALIDA, { recursive: true, force: true });
fs.mkdirSync(SALIDA, { recursive: true });
for (const nombre of fs.readdirSync(RAIZ)) {
  if (nombre.startsWith('.') || NO_PUBLICAR.has(nombre) || path.join(RAIZ, nombre) === SALIDA) continue;
  fs.cpSync(path.join(RAIZ, nombre), path.join(SALIDA, nombre), { recursive: true });
}

// ---------- 2. Servidor local: cada dirección devuelve index.html ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.txt': 'text/plain' };
const rutas = new Set(paginas.map((p) => p.ruta));
const servidor = createServer((req, res) => {
  const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rutas.has(ruta)) {
    res.writeHead(200, { 'content-type': TIPOS['.html'] });
    return res.end(fuente);
  }
  const archivo = path.join(RAIZ, ruta);
  if (!archivo.startsWith(RAIZ) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(archivo).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(archivo).pipe(res);
});
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${servidor.address().port}`;

// ---------- 3. Pintar cada sección en un navegador y guardar su contenido ----------
const navegador = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const contexto = await navegador.newContext({ viewport: { width: 1280, height: 900 }, locale: 'es-ES' });
await contexto.addInitScript(() => {
  window.__waizuPrerender = true; // desplegables abiertos (ver index.html)
  try { window.localStorage.setItem('waizu-cookies', 'rejected'); } catch (e) {}
});
// Instagram y la analítica no forman parte de la copia estática.
await contexto.route(/workers\.dev|cloudflareinsights\.com/, (r) => r.abort());

const copias = {};
for (const p of paginas) {
  const pagina = await contexto.newPage();
  pagina.on('pageerror', (e) => aviso(p.ruta, `error de JavaScript: ${e.message}`));
  if (process.env.DEPURAR) { pagina.on('console', (m) => console.log(p.ruta, m.type(), m.text())); pagina.on('requestfailed', (r) => console.log(p.ruta, 'falló', r.url())); pagina.on('response', (r) => r.status() >= 400 && console.log(p.ruta, r.status(), r.url())); }
  await pagina.goto(base + p.ruta, { waitUntil: 'load' });
  await pagina.waitForSelector('#dc-root h1', { state: 'attached', timeout: 30000 });
  await pagina.waitForTimeout(600);
  copias[p.ruta] = await pagina.evaluate(() => {
    const raiz = document.getElementById('dc-root').cloneNode(true);
    raiz.querySelectorAll('script, template, noscript').forEach((n) => n.remove());
    // Las fotos de la copia no se descargan: quien tiene JavaScript ya ve las de la
    // web, y a los buscadores les basta con el texto alternativo.
    raiz.querySelectorAll('img, source').forEach((n) => {
      for (const a of ['src', 'srcset']) if (n.hasAttribute(a)) { n.setAttribute('data-' + a, n.getAttribute(a)); n.removeAttribute(a); }
      n.removeAttribute('fetchpriority');
    });
    raiz.querySelectorAll('*').forEach((n) => {
      for (const a of [...n.attributes]) if (/^(style-|sc-|hint-|ref$)/.test(a.name)) n.removeAttribute(a.name);
    });
    return {
      html: raiz.innerHTML,
      h1: [...raiz.querySelectorAll('h1')].map((h) => h.textContent.trim()),
      texto: raiz.textContent.replace(/\s+/g, ' ').trim().length,
    };
  });
  await pagina.close();
}
await navegador.close();
servidor.close();

// ---------- 4. Escribir cada página ----------
const escapar = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const nodo = (tipo) => grafo.find((n) => n['@type'] === tipo);

function datosEstructurados(p) {
  const url = DOMINIO + p.ruta;
  const webPage = {
    '@type': p.vista === 'contacto' ? 'ContactPage' : p.vista === 'faq' ? 'FAQPage' : 'WebPage',
    '@id': `${url}#pagina`,
    url,
    name: p.titulo,
    description: p.descripcion,
    inLanguage: 'es-ES',
    isPartOf: { '@id': `${DOMINIO}/#web` },
    about: { '@id': `${DOMINIO}/#negocio` },
  };
  if (p.vista === 'home') return grafo.filter((n) => n['@type'] !== 'FAQPage');
  if (p.vista === 'contacto') return [nodo('ClothingStore'), webPage];
  if (p.vista === 'faq') {
    const faq = nodo('FAQPage');
    return faq ? [{ ...webPage, ...faq, '@id': `${url}#pagina`, url, name: p.titulo }] : [webPage];
  }
  return [webPage];
}

function sustituir(html, re, nuevo, ruta, que) {
  if (!re.test(html)) aviso(ruta, `no se encontró ${que} en index.html`);
  return html.replace(re, nuevo);
}

for (const p of paginas) {
  const url = DOMINIO + p.ruta;
  const copia = copias[p.ruta];
  if (copia.h1.length !== 1) aviso(p.ruta, `tiene ${copia.h1.length} H1 (debe tener uno)`);
  if (copia.texto < 200) aviso(p.ruta, 'la copia estática casi no tiene texto');
  if (p.titulo.length > 60) aviso(p.ruta, `título de ${p.titulo.length} caracteres (máximo 60)`);
  if (p.descripcion.length > 155) aviso(p.ruta, `descripción de ${p.descripcion.length} caracteres (máximo 155)`);

  let html = fuente;
  // <base href="/"> hace que assets/… y uploads/… se lean desde la raíz en todas las
  // direcciones, también después de cambiar de sección sin recargar.
  if (!html.includes('<base href="/">')) aviso(p.ruta, 'falta <base href="/"> en el <head> de index.html');
  html = sustituir(html, /<title>[^<]*<\/title>/, `<title>${escapar(p.titulo)}</title>`, p.ruta, 'el <title>');
  html = sustituir(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapar(p.descripcion)}">`, p.ruta, 'la description');
  html = sustituir(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`, p.ruta, 'el canonical');
  html = sustituir(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`, p.ruta, 'og:url');
  html = sustituir(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escapar(p.titulo)}">`, p.ruta, 'og:title');
  html = sustituir(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapar(p.descripcion)}">`, p.ruta, 'og:description');
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': datosEstructurados(p) }, null, 1);
  html = html.replace(/(<script type="application\/ld\+json">)[\s\S]*?(<\/script>)/, () => `<script type="application/ld+json">\n${ld}\n</script>`);
  html = sustituir(html, /<body>/, () => `<body>\n<div id="waizu-prerender"><!-- Copia estática generada por herramientas/generar-paginas.mjs. No editar aquí: se cambia en index.html. -->${copia.html}</div>`, p.ruta, '<body>');

  const destino = path.join(SALIDA, p.ruta, 'index.html');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, html);
}

// ---------- 5. Sitemap ----------
let lastmod;
try {
  lastmod = execSync('git log -1 --format=%cs -- index.html', { cwd: RAIZ }).toString().trim();
} catch (e) {}
lastmod ||= new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paginas.map((p) => `  <url><loc>${DOMINIO}${p.ruta}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;
fs.writeFileSync(path.join(SALIDA, 'sitemap.xml'), sitemap);

// ---------- 6. Resumen ----------
for (const p of paginas) console.log(`${p.ruta.padEnd(28)} H1: ${copias[p.ruta].h1.join(' / ')}  (${copias[p.ruta].texto} caracteres)`);
if (errores.length) {
  console.error('\nProblemas encontrados:\n- ' + errores.join('\n- '));
  process.exit(1);
}
console.log(`\n${paginas.length} páginas generadas en ${path.relative(RAIZ, SALIDA) || SALIDA}`);
