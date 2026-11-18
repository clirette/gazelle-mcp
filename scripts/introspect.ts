// Dump the live schema (types used by this server) to docs/schema.json. Usage: npm run introspect
import { writeFile } from "node:fs/promises";
import { gql } from "../src/gazelle/graphql.js";

const data = await gql<unknown>(`{ __schema { queryType { name } types {
  name kind enumValues { name }
  inputFields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
  fields { name args { name type { kind name ofType { kind name ofType { kind name } } } }
           type { kind name ofType { kind name ofType { kind name } } } } } } }`);
await writeFile("docs/schema.json", JSON.stringify(data, null, 1));
console.log("Wrote docs/schema.json");
