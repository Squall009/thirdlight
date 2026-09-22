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

## Open the editor

The backend (`node dist/backend/backend.mjs`) is configured through
`THIRDLIGHT_*` environment variables; see the header of
`packages/backend/src/index.ts`. Open
`http://<authoring-origin>/?project=<projectId>` and enter the project's
access token once (or append `#token=<token>` to the URL); the browser keeps
it in localStorage. Tokens are never baked into the served page.
