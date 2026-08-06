export function enumLabel(value, fallback = "Not set") {
  return String(value || fallback)
    .toLowerCase()
    .split(/[-_]+/)
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}
