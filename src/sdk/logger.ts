/**
 * Structured JSON logging. Designed to work identically in Node and inside
 * a Cloudflare Worker — both have `console.log` and stdout/stderr semantics
 * that route to platform log collectors.
 */
type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(ctx ?? {}),
  };
  // Workers don't have process.stderr; both go via console which Cloudflare
  // captures cleanly. Node also routes console.log/error to the right stream.
  const out = JSON.stringify(line);
  if (level === "error") console.error(out);
  else console.log(out);
}

export const log = {
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => {
    if (typeof process !== "undefined" && process.env?.DEBUG) emit("debug", msg, ctx);
  },
};
