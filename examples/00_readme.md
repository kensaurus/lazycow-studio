# examples

Placeholder content, so a new studio has something to try. Nothing here is a real business.

| Folder | What is in it |
|:--|:--|
| `cafe-kumo/` | A made-up cafe: its brand (name, link, hashtags, copy rules), two themes, a word bank and a profile. Copy the four files into your data folder (default `./data`) before the first `npm run review`, and the studio opens as Cafe Kumo. Delete them, or change them in **Settings › Keys & AI › This project**, when you start your own. |
| `public/` | (Owner's checkout only; not exported.) Files the public export uses in place of the owner's own (`scripts/public-export.json`, `replace`). `public/shared/channels.json` is `shared/channels.json` with neutral "who posts" lines. `test/public-export.test.mjs` keeps the two in step. |

The files in `cafe-kumo/` were written by the studio itself (`studio.brand.save_brand`, `studio.assemble.save_theme`, `studio.wording.save_line`), so they have exactly the shape the studio reads.
