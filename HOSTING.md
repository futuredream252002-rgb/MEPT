# UK Voice Dictionary — hosting files

This folder is the complete web app source. It builds to a static site, so it
can be hosted on any static hosting service such as GitHub Pages, Netlify,
Vercel, Cloudflare Pages, or an ordinary web server.

## Build

From the project root:

```bash
pnpm install
PORT=4173 BASE_PATH=/ pnpm --filter @workspace/uk-voice-dictionary run build
```

Upload the contents of:

```text
artifacts/uk-voice-dictionary/dist/public
```

to the hosting service's public/output directory.

## SPA routing

The app has a `/saved` page. Configure the host to serve `index.html` for
unknown paths (a single-page-app fallback), otherwise a direct visit to
`/saved` may show a 404.

## Local preview

```bash
PORT=4173 BASE_PATH=/ pnpm --filter @workspace/uk-voice-dictionary run dev
```

The app uses the public Free Dictionary API for lookups, has local fallback
entries, and uses the browser's British English speech voice when available.