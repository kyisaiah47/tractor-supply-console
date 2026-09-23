// The weekly job from the command line. Schedule it with cron in production:
//   0 6 * * 1  cd /app && npm run job:weekly
import "./_env";
import { pool } from "../src/lib/db";
import { runWeeklyJob } from "../src/lib/weekly";

runWeeklyJob({ useLlm: process.argv.includes("--no-llm") ? false : true })
  .then((b) => {
    console.log(`weekly brief (${b.author}) as of ${b.asOf}\n\n${b.body}`);
    return pool.end();
  })
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
