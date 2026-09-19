import pino from "pino";
import { getEnv } from "../config/env.js";

let logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (logger) return logger;
  let level = "info";
  try {
    level = getEnv().LOG_LEVEL;
  } catch {
    level = process.env.LOG_LEVEL ?? "info";
  }
  logger = pino({
    level,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
  return logger;
}
