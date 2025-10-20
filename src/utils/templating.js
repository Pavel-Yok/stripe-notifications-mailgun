export function replacePlaceholders(str, data) {
  return str.replace(/\{\{\s*([.\w]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let cur = data;
    for (const p of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, p)) {
        cur = cur[p];
      } else {
        return {{}}; // leave unresolved so you notice it
      }
    }
    return String(cur);
  });
}
