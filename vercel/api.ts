// Vercel Function entry (Node.js runtime). scripts/build-vercel.mjs bundles this file with esbuild into
// .vercel/output/functions/api.func/index.mjs; vercel.json points Vercel at that prebuilt output.
// Node (req, res) handler → Web Request/Response via @hono/node-server, response streaming included (SSE).
import { getRequestListener } from "@hono/node-server";
import { handleVercel } from "../server/src/platform/vercel";

export default getRequestListener(handleVercel);
