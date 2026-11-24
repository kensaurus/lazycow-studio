/**
 * FILE: server/ui.mjs
 * PURPOSE: The page the studio serves, put together from its parts (BL-121). server/editor.html is the shell: the head,
 *          the header markup and one line `<!--ui:css/…-->` or `<!--ui:js/…-->` where each part goes. The parts live in
 *          server/ui/css (the styles, in order) and server/ui/js (the script, one file per page or tool, in order).
 *          They are joined into ONE <style> and ONE <script>, exactly as the single file was, so every part shares one
 *          script scope: a function in one part may call one in a later part, as before.
 * DEPENDENCIES: node:fs, node:path
 * USAGE: import { assemblePage, pageFiles } from "./ui.mjs";
 *        assemblePage(ROOT) -> the page's HTML; pageFiles(ROOT) -> the shell and every part, in order (the build id).
 * NOTES: Read fresh on every page load (no restart needed for a page change). test/ui-parts.test.mjs checks that every
 *        include names a part and every part is included once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const INCLUDE = /^<!--ui:([a-z0-9/._-]+)-->\r?\n/gm;

/** The shell's include names, in order. */
export function includes(root) {
  const shell = readFileSync(join(root, "server", "editor.html"), "utf8");
  return [...shell.matchAll(INCLUDE)].map((m) => m[1]);
}

/** The page: the shell with each include line replaced by its part. */
export function assemblePage(root) {
  const shell = readFileSync(join(root, "server", "editor.html"), "utf8");
  return shell.replace(INCLUDE, (_, part) => {
    if (part.includes("..")) throw new Error(`bad include: ${part}`);
    return readFileSync(join(root, "server", "ui", part), "utf8");
  });
}

/** Every file the page is made of: the shell first, then the parts in the order they are included. */
export function pageFiles(root) {
  return [join(root, "server", "editor.html"), ...includes(root).map((p) => join(root, "server", "ui", p))];
}
