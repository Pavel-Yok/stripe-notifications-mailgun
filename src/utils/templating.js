export function replacePlaceholders(str, data) {
  // Supports {{key}} and {{key|Default Text}} and dotted keys {{brand.brandName}}
  return str.replace(/\{\{\s*([.\w]+)(?:\|([^}]+))?\s*\}\}/g, (_, key, defVal) => {
    const parts = key.split('.');
    let cur = data, found = true;

    for (const p of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, p)) {
        cur = cur[p];
      } else {
        found = false;
        break;
      }
    }

    if (found && cur != null) return String(cur);

    // Not found → use default if provided, otherwise leave as-is so you notice
    return typeof defVal === 'string' ? defVal.trim() : `{{${key}}}`;
  });
}
