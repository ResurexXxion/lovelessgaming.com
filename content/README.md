# content/

The site's data. Edit these files (or ask Claude to), then publish. Empty lists show a "coming soon" note on the site.

## mods.json

- `releases`: one entry per mod you've released, newest first:

```json
{
  "name": "Mod name",
  "game": "Kingdom Come: Deliverance II",
  "summary": "One or two sentences on what it does.",
  "version": "1.0.0",
  "updated": "2026-11-14",
  "image": "/img/mods/mod-name.jpg",
  "links": [
    { "label": "Nexus Mods", "url": "https://www.nexusmods.com/..." }
  ]
}
```

- `games`: the games shown under "Games I mod".

## books.json

- `books`: one entry per book, newest first:

```json
{
  "title": "Book title",
  "subtitle": "Optional subtitle",
  "cover": "/img/books/book-title.jpg",
  "blurb": "The back-cover description.",
  "published": "2026-12-01",
  "links": [
    { "label": "Kindle", "url": "https://www.amazon.com/dp/..." },
    { "label": "Paperback", "url": "https://www.amazon.com/dp/..." }
  ]
}
```

Images go in `../static/img/` (`static/img/mods/`, `static/img/books/`), and the paths above start with `/img/`.

## Medium articles

There's no file for these. The build reads your Medium RSS feed (`mediumFeed` in `../site.config.json`, e.g. `https://medium.com/feed/@yourname`) and the GitHub workflow rebuilds once a day, so new articles show up on their own.
