# Thirdlight

A self-hosted browser game editor built on three.js. Goal and scope:
[docs/architecture/charter.md](docs/architecture/charter.md). Current state:
[docs/STATUS.md](docs/STATUS.md).

## Develop

```sh
npm ci --include=dev        # this host exports NODE_ENV=production
npm run build               # checks + bundles into dist/
npm test                    # unit and integration tests (vitest)
npm run test:e2e            # browser tests (Playwright) against dist/
```

## Run it

```sh
npm start                   # builds dist/ if needed, starts the backend, prints the editor URL
```

Full deployment notes (LAN access, the owner token, MCP, backup/restore,
independent games, upgrades): [docs/deployment.md](docs/deployment.md).

## Open the editor

The backend (`node dist/backend/backend.mjs`) is configured through
`THIRDLIGHT_*` environment variables; see the header of
`packages/backend/src/index.ts`. There is one owner token
(`THIRDLIGHT_OWNER_TOKEN`) for the browser, the MCP server and the admin
routes. Open `http://<authoring-origin>/`, enter the token once (or append
`#token=<token>` to the URL; the browser keeps it in localStorage), then pick
a project or create one from a template. The token is never baked into the
served page.
