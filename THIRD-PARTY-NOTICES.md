# Third-party notices

DQ Dental CAD is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)
and [NOTICE](NOTICE)). It depends at runtime on the open-source packages
below. Each is distributed under its own license, whose full text ships in
the package (`node_modules/<package>/LICENSE`). When you redistribute a build
of this software, keep those license texts with it.

| Package | License | Used by | Source |
|---|---|---|---|
| manifold-3d | Apache-2.0 | geometry kernel (booleans, repair) | https://github.com/elalish/manifold |
| comlink | Apache-2.0 | worker RPC | https://github.com/GoogleChromeLabs/comlink |
| @prisma/client | Apache-2.0 | server database access | https://github.com/prisma/prisma |
| three | MIT | client 3D rendering | https://github.com/mrdoob/three.js |
| react, react-dom | MIT | client UI | https://github.com/facebook/react |
| zustand | MIT | client state | https://github.com/pmndrs/zustand |
| i18next, react-i18next | MIT | client translations | https://github.com/i18next/i18next |
| fastify | MIT | server | https://github.com/fastify/fastify |
| @fastify/cors | MIT | server | https://github.com/fastify/fastify-cors |
| ajv | MIT | server and traceability schema validation | https://github.com/ajv-validator/ajv |

Development-only tools (TypeScript, Vite, Vitest, Playwright, ESLint and
their dependencies) are not part of a built application and are not listed.

The tooth-library anatomy in `packages/tooth-library` is generated
procedurally by this project's own code (`assetKind: 'generator'`). It
contains no scanned or third-party licensed anatomy, and is covered by this
project's Apache-2.0 license.

The anonymized clinical scans in `test-fixtures/real-scans/` are excluded
from the Apache-2.0 grant (see [NOTICE](NOTICE)). They are test data for this
repository only.

To regenerate the list of runtime dependencies, read the `dependencies`
field of each workspace's `package.json` (the `@dqcad/*` packages are this
project's own).
