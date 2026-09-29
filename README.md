# annotate-ai

A self-hosted visual review layer based on [reviewjs/annotate](https://github.com/reviewjs/annotate). People can pin a point, mark a region or highlight text, then discuss it in a thread. Comments, replies and uploaded image bytes live in the service's SQLite database. Emoji selection uses `emoji-picker-element`; image selection uses Uppy; Markdown is rendered with Marked and sanitized with DOMPurify.

## Run locally

Requires Bun 1.3 and Node.js for the browser bundle build.

```sh
npm ci
npm run build
ANNOTATE_DB_PATH=./data/annotate.sqlite PORT=18767 npm run serve
```

In another terminal, register a calling site. Run once per site and save the returned key:

```sh
ANNOTATE_DB_PATH=./data/annotate.sqlite \
  ANNOTATE_PUBLIC_URL=http://127.0.0.1:18767 \
  bun server/cli.ts create-project \
  --name 'My site' \
  --origin http://127.0.0.1:8767
```

Copy the printed script tag into the site's HTML. For example:

```html
<script src="http://127.0.0.1:18767/embed.js" data-key="SITE_KEY" defer></script>
```

That is the calling project's entire integration. The key is a **publishable site identifier** because browser source exposes it. Registered origins restrict browser access; they do not authenticate individual reviewers. People enter a display name when they first start reviewing.

The page key defaults to the path plus hash route, so tabs and single-page app routes have separate threads. Set `window.AnnotateConfig.page` before the script if a site needs a custom page identity. `data-position="bottom-left"` moves the launcher when the host page already uses the right corner.

For internal views that do not change the URL, put `data-annotate-view` on the visible view container and dispatch `annotate:viewchange` after switching it. Use a stable key for each graph, subprocess, or dialog; an empty value keeps the base page. Hidden or missing anchors are not drawn and return when their elements become visible. Comment links include the `annotateView` query parameter, which the host page must restore on load.

```js
viewContainer.dataset.annotateView = 'atlas/subprocess/s01_reply/S01';
document.dispatchEvent(new Event('annotate:viewchange'));
```

SVG graph cells with `data-cell-id` are anchored to that cell and follow its pan or zoom transform. A plain `<canvas>` has no DOM nodes for its internal shapes, so annotations can anchor to the canvas element only; precise shape anchoring requires an adapter to the drawing library.

For the company-service-framework local preview, use the project-specific SQLite file and bind only to loopback:

```sh
mkdir -p data
ANNOTATE_HOST=127.0.0.1 ANNOTATE_DB_PATH=./data/annotate.sqlite PORT=18767 ./bin/annotate-server
```

The site's localhost pages select this service and its separate publishable key. `data/` is ignored by Git. To run it in the background, redirect stdout/stderr to `data/local-server.log` and save the process ID in `data/local-server.pid`; stop that process when no longer needed.

## Service

`GET /health` checks availability. The browser bundle and emoji data are self-hosted at `/embed.js`, `/embed.css`, `/annotate.js` and `/emoji-data.json`. Comment and image endpoints are under `/v1/`; see [server/README.md](server/README.md) for the request contract. Images are limited to JPEG, PNG, WebP and GIF at 5 MiB each, checked by file signature and stored as SQLite BLOBs. No object store is used.

To run an independent container with a persistent SQLite volume:

```sh
npm run build
docker compose -f deploy/compose.yaml up -d --build
```

The database location is controlled by `ANNOTATE_DB_PATH`; the server listens on `PORT` (default `18767`). Back up the SQLite database and its WAL state together using SQLite's backup API or a stopped container.

The independent 5.77 instance is at `http://192.168.5.77:18767/`. Its source releases live under `~/annotate-ai/releases/` on that host; Compose uses the fixed `annotate-ai` project name, so a new release keeps the same `annotate-ai_annotate-data` SQLite volume. To publish a committed revision from this repository, archive the commit into a new release directory on 5.77, then run `docker compose -f deploy/compose.yaml up -d --build --wait` there. Check `/health`, load `/embed.js`, and read back an existing comment before considering the update complete. Do not change the separate dashboard or dev-gateway project to publish this service.

## Development checks

```sh
npm run build
bun test tests/server.test.ts
```

The upstream Playwright suite in `tests/annotate.spec.js` was written for localStorage mode and is retained for migration, not used as hosted-service acceptance evidence.

## Credits and license

This fork builds on reviewjs/annotate by Akash Goswami under the MIT license. The original license is preserved in [LICENSE](LICENSE). Dependencies retain their own licenses.
