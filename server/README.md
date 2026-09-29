# annotate-ai comment service

The service stores projects, comments, replies and image bytes in one SQLite database. It is intentionally independent from the browser bundle.

`POST /v1/comments` accepts an optional client-generated `id` (a `c` followed by lowercase letters, digits or hyphens, 11–80 characters total). Retrying the same request returns the existing comment; reusing an ID for different content returns `409`. Existing callers may omit `id` and receive a server-generated one.

```sh
ANNOTATE_DB_PATH=./data/annotate.sqlite PORT=18767 bun server/index.ts
bun server/cli.ts create-project --name "方案系统" --origin http://127.0.0.1:8767
```

Use the generated key as `X-Annotate-Key` for comment API requests. Image URLs include the same public site key as `?key=...` so they can be used by an `<img>` element. The registered origin list controls browser CORS; requests without `Origin` are accepted for CLI and server-side callers.

Static integration assets are available at `/embed.js`, `/embed.css`, `/emoji-data.json`, and `/annotate.js`. The first three are read from `dist/`; `annotate.js` is read from the repository root.
