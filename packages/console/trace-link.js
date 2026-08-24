export function traceHref(config, run) {
  const base = config?.trace_ui_base_url;
  const id = run?.trace_id;
  if (typeof base !== "string" || !base) return null;
  if (typeof id !== "string" || !id) return null;
  return `${base}${id}`;
}
