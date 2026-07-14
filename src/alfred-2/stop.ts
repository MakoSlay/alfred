import { stopAlfred2Process } from "./process.ts";

const result = await stopAlfred2Process();
console.log(result.message);
process.exit(result.ok ? 0 : 1);
