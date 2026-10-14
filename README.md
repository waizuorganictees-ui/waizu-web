# Waizu

Landing page de Waizu — ropa personalizada a mano en algodón 100% orgánico con DTF, en Guadalajara.

Exportada desde el diseño hecho en [Claude Design](https://claude.ai/design) y publicada como sitio estático: `index.html` + los recursos en `assets/` (imágenes y fuentes) y `uploads/` (fotos del catálogo), sin paso de build.

## Desarrollo local

Hay que servirlo por HTTP (abrir `index.html` directamente con `file://` no funciona):

```bash
npx serve .
```

## Secciones y publicación

Cada sección tiene su propia dirección (`/catalogo/`, `/contacto/`, `/privacidad/`…). La lista está en `<script id="waizu-paginas">`, dentro del `<head>` de `index.html`, con el título y la descripción de cada página. Para añadir o renombrar una sección se cambia ahí.

`index.html` sigue siendo el único archivo que se edita. Al subir cambios a `master`, GitHub Actions (`.github/workflows/publicar.yml`) ejecuta `herramientas/generar-paginas.mjs`, que crea una página por dirección con su título, descripción, datos estructurados y una copia del contenido para buscadores, y publica el resultado en GitHub Pages. Esas páginas generadas no están en el repositorio.

Para generarlas en local:

```bash
cd herramientas && npm ci && npx playwright install chromium && cd ..
node herramientas/generar-paginas.mjs   # crea _site/
npx serve _site
```
