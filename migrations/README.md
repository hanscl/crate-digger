# Migrations

Drizzle migrations for the Postgres + pgvector database.

## First-time setup

```sh
pnpm db:init      # creates pgvector extension + generates + applies migrations
```

The pgvector extension is created via `src/db/init-extension.ts` (called by
`pnpm db:init`); migrations themselves are generated from `src/db/schema.ts`
via `drizzle-kit generate` and applied via `drizzle-kit migrate`.

## Adding a migration

After editing `src/db/schema.ts`:

```sh
pnpm db:generate  # writes a new migrations/NNNN_*.sql
pnpm db:migrate   # applies it
```

Inspect the generated SQL and commit it.
