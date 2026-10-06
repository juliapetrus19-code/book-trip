// Read bundled demo books (data/books/<id>.json) on the server, e.g. for demo portraits.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError, ID_RE } from "./http.js";

let dirsForTests = null;
const cache = new Map(); // id → parsed book (or null when missing)

/** Tests point the loader at a temporary directory; pass null to restore the defaults. */
export function setDemoDirForTests(dir) {
  dirsForTests = dir ? [dir] : null;
  cache.clear();
}

function candidates(id) {
  if (dirsForTests) return dirsForTests.map((d) => join(d, `${id}.json`));
  // process.cwd() is the project root on Vercel and in the dev server; the module-relative URL
  // covers bundlers that move the function (vercel.json includes data/books/** for the portrait).
  return [join(process.cwd(), "data", "books", `${id}.json`), new URL(`../../data/books/${id}.json`, import.meta.url)];
}

/** The parsed demo book, or null when there is no such book. */
export async function loadDemoBook(id) {
  if (!ID_RE.test(id)) return null;
  if (cache.has(id)) return cache.get(id);
  let book = null;
  for (const file of candidates(id)) {
    try {
      book = JSON.parse(await readFile(file, "utf8"));
      break;
    } catch (err) {
      if (err && err.code !== "ENOENT") console.error(`[demo] cannot read ${id}: ${err.message}`);
    }
  }
  if (book && (typeof book !== "object" || book.id !== id)) book = null;
  if (cache.size > 200) cache.clear();
  cache.set(id, book);
  return book;
}

/** The English portrait prompt of a demo character; throws not_found when unknown. */
export async function demoPortraitPrompt(bookId, charId) {
  const book = await loadDemoBook(bookId);
  const character = book && Array.isArray(book.characters) ? book.characters.find((c) => c && c.id === charId) : null;
  const prompt = character && typeof character.portraitPrompt === "string" ? character.portraitPrompt.trim() : "";
  if (!prompt) throw new HttpError("not_found", "Unknown demo book or character");
  return prompt.slice(0, 600);
}
