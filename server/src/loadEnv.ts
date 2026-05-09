import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Carga server/.env (Node no lo hace solo con tsx). */
export function loadEnv() {
  const dir = dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: join(dir, "../.env") });
}
