import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "../config/env.js";
import { connectDatabase } from "../db/client.js";

const database = connectDatabase(loadEnv().DATABASE_URL);
await migrate(database.db, { migrationsFolder: "./src/db/migrations" });
await database.close();
console.info("Migraciones aplicadas");
