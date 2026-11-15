# lovelessgaming.com

Source for [lovelessgaming.com](https://lovelessgaming.com): a plain static site with no frameworks or npm packages. A small Node script builds it, and GitHub Pages hosts it.

| Path | What it is |
|---|---|
| `site.config.json` | Site name, tagline, contact email, Medium feed, newsletter link, About text, profile links (empty links are hidden). |
| `content/` | `mods.json` and `books.json`, the data for the Mods and Books pages. See `content/README.md`. |
| `static/` | Stylesheet, favicon and images, copied into the site as they are. |
| `build.mjs` | Builds every page into `dist/`. It also pulls the latest articles from the Medium RSS feed. |
| `serve.mjs` | Local preview of `dist/` at http://localhost:4321. |
| `.github/workflows/deploy.yml` | Builds and deploys on every push, plus once a day to pick up new Medium articles. |

## Build and preview locally

```bash
node build.mjs
node serve.mjs
```

`SKIP_FEEDS=1 node build.mjs` builds without going online.
