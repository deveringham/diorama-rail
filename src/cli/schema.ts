// npm run schema — writes docs/schema.json (JSON Schema of the layout input format).

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { layoutJsonSchema } from "../model/schema";

const out = resolve(import.meta.dirname, "../../docs/schema.json");
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify(layoutJsonSchema(), null, 2) + "\n");
console.log(`wrote ${out}`);
