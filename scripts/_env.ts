// Scripts run outside Next.js, so they load .env themselves.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: defaults in src/lib/config.ts and src/lib/db.ts apply
}
