# LUREQO CRM — React migration

The application now has a React/Vite shell and a compatibility runtime for the existing CRM implementation.

## Compatibility contract
- Backend/API, Prisma schema, PostgreSQL data and Telegram/WhatsApp engines are unchanged.
- Existing `public/legacy/app.js` is loaded by the React runtime after the new shell is ready. It remains the source of truth for mature CRM workflows during the migration so existing features are not silently dropped.
- The new React navigation calls the existing `goToView()` API and preserves the existing authentication/permissions enforced by the server.
- This is intentionally a compatibility-first migration. A full line-by-line rewrite of every legacy workflow should be done module-by-module after this version is verified in production.

## Railway
Deploy the repository root. The Dockerfile builds TypeScript and the Vite frontend, then serves both from the same Fastify service.
