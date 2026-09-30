// Prisma configuration for the backend package.
// The Prisma schema lives in the shared database package; the generated
// client is emitted into this package's node_modules so `nest build` and
// `node dist/...` resolve @prisma/client with full generated types.
// Runs automatically on `npm install` via the "postinstall" script.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: '../database/prisma/schema.prisma',
});
