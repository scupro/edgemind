// Netlify Scheduled Function: dispatches due 排程 tasks (POST /api/cron/tick in-process, HMAC-authenticated).
// Every 15 minutes by default. Ticks with nothing due are answered from the object-storage hint and never wake Neon
// (scheduler/hint.ts); change the expression below if you need finer granularity (e.g. "*/5 * * * *").
import { handleNetlifyCron } from "../../server/src/platform/netlify";

export default handleNetlifyCron;

export const config = { schedule: "*/15 * * * *" };
