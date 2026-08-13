// Registers `module-trace-hook.mjs` for the process it is `--import`ed into.
// The trace destination comes from `AXI_MODULE_TRACE`.
import { register } from "node:module";

register(new URL("./module-trace-hook.mjs", import.meta.url).href, {
  data: { out: process.env.AXI_MODULE_TRACE },
});
