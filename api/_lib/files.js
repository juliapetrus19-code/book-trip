// Read project files (index.html, og.png, data/catalog.json) from a function. process.cwd() is the
// project root on Vercel and in the dev server; the module-relative URL covers bundlers that move the
// function (vercel.json lists these files in includeFiles).
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

let rootForTests = null;

/** Tests point the reader at a temporary directory; pass null to restore the defaults. */
export function setProjectRootForTests(dir) {
  rootForTests = dir || null;
}

function candidates(rel) {
  if (rootForTests) return [join(rootForTests, rel)];
  return [join(process.cwd(), rel), new URL(`../../${rel}`, import.meta.url)];
}

/** UTF-8 contents, or null when the file is missing everywhere. */
export async function readProjectFile(rel) {
  for (const file of candidates(rel)) {
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      if (err && err.code !== "ENOENT") console.error(`[files] cannot read ${rel}: ${err.message}`);
    }
  }
  return null;
}

export async function projectFileExists(rel) {
  for (const file of candidates(rel)) {
    try {
      await access(file);
      return true;
    } catch { /* next */ }
  }
  return false;
}
