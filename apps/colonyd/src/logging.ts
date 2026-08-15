export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export function consoleLogger(service: string): Logger {
  const fmt = (level: string, fields: Record<string, unknown>, msg: string) =>
    `[${service} ${new Date().toISOString()} ${level}] ${msg} ${JSON.stringify(fields)}`;
  return {
    info: (fields, message) => console.log(fmt("info", fields, message)),
    warn: (fields, message) => console.warn(fmt("warn", fields, message)),
    error: (fields, message) => console.error(fmt("error", fields, message)),
  };
}
