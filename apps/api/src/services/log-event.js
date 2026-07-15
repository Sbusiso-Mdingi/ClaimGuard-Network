export function logEvent(level, event, details = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service: "api",
    event,
    ...details,
  };

  const rendered = JSON.stringify(payload);
  if (level === "error") {
    console.error(rendered);
  } else {
    console.log(rendered);
  }
}
