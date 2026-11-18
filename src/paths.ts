import { resolve } from "node:path";

/** Project-root `data/` dir, independent of the process working directory (works from src/ and dist/). */
export const DATA_DIR = process.env.GAZELLE_DATA_DIR ?? resolve(import.meta.dirname, "..", "data");
export const dataFile = (name: string) => resolve(DATA_DIR, name);
