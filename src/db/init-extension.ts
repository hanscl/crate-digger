import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  console.log("pgvector extension ensured");
} finally {
  await sql.end();
}
