// Build data/catalog.json from data/books/*.json (run after adding/changing a demo book).
// Usage: node tests/build-catalog.mjs
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const files = (await readdir(`${ROOT}data/books`)).filter((f) => f.endsWith(".json")).sort();
const catalog = [];
for (const f of files) {
  const b = JSON.parse(await readFile(`${ROOT}data/books/${f}`, "utf8"));
  const pick = (k) => ({ ru: b.i18n.ru[k], uk: b.i18n.uk[k], en: b.i18n.en[k] });
  const aliases = new Set(b.aliases || []);
  for (const lang of ["ru", "uk", "en"]) {
    aliases.add(b.i18n[lang].title);
    if (b.i18n[lang].originalTitle) aliases.add(b.i18n[lang].originalTitle);
  }
  catalog.push({ id: b.id, year: b.year, cover: b.cover, title: pick("title"), author: pick("author"), aliases: [...aliases] });
}
await writeFile(`${ROOT}data/catalog.json`, JSON.stringify(catalog, null, 2) + "\n");
console.log(`catalog: ${catalog.length} books`);
