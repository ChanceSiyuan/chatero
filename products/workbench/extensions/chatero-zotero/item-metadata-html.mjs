const METADATA_ROWS = [
  ["title", "Title"],
  ["itemType", "Type"],
  ["date", "Date"],
  ["year", "Year"],
  ["creators", "Creators"],
  ["publicationTitle", "Publication"],
  ["doi", "DOI"],
  ["url", "URL"],
  ["tags", "Tags"],
  ["abstractNote", "Abstract"],
];

function escape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderItemMetadataHTML(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("item metadata must be an object");
  }
  const rows = [];
  for (const [field, label] of METADATA_ROWS) {
    const value = metadata[field];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    const display = Array.isArray(value) ? value.map(escape).join(", ") : escape(value);
    rows.push(`<dt>${escape(label)}</dt><dd>${display}</dd>`);
  }
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>Chatero Item Details</title>",
    "</head>",
    "<body>",
    `<dl>${rows.join("")}</dl>`,
    "</body>",
    "</html>",
  ].join("\n");
}
