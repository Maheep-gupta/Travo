// Lightweight entry: demo backend + shared client types. Pulls in neither
// supabase-js nor zod, so clients can load it without the Supabase stack.
export * from "./api.js";
export * from "./storage.js";
export { createDemoApi, type DemoApiOptions } from "./demo-api.js";
