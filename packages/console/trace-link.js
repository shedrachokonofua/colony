const TRACE_ID_SLOT = "{trace_id}";

// Builds the run's trace deep link. The configured base either embeds the id
// via a literal `{trace_id}` placeholder (URL-encoded, so Grafana Explore
// JSON params work) or, without a placeholder, gets the id appended verbatim.
export function traceHref(config, run) {
  const base = config?.trace_ui_base_url;
  const id = run?.trace_id;
  if (typeof base !== "string" || !base) return null;
  if (typeof id !== "string" || !id) return null;
  if (base.includes(TRACE_ID_SLOT)) {
    return base.replaceAll(TRACE_ID_SLOT, encodeURIComponent(id));
  }
  return `${base}${id}`;
}
