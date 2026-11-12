// Markdown to HTML for chat text, with no dependencies. Covers what Claude writes: headings,
// paragraphs, emphasis, inline and fenced code, links, lists (nested, numbered, task), block
// quotes, tables and rules. Raw HTML is shown as text, never rendered, and links only open
// http(s) and mailto URLs.

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!|~<>])/g;

const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => !line.trim();

// ---------- inline ----------

const link = (url, label) =>
  `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

// Code spans, escapes and links become placeholders (private-use U+E000) first so the emphasis rules can't touch them.
function inline(text) {
  const saved = [];
  const hold = (html) => `\uE000${saved.push(html) - 1}\uE000`;
  let s = text
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) =>
      hold(`<code>${escapeHtml(code)}</code>`),
    )
    .replace(ESCAPABLE, (_, c) => hold(escapeHtml(c)))
    .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, label, url) =>
      hold(link(url, escapeHtml(label))),
    )
    .replace(/https?:\/\/[^\s<>()"'\uE000]*[^\s<>()"'.,;:!?\uE000]/g, (url) =>
      hold(link(url, escapeHtml(url))),
    );
  s = escapeHtml(s)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/\n/g, "<br>");
  // A link label can hold a code span, so restore until no placeholder is left.
  while (s.includes("\uE000")) s = s.replace(/\uE000(\d+)\uE000/g, (_, i) => saved[i]);
  return s;
}

// ---------- tables ----------

// Splits "| a | `b|c` | d \| e |" on the pipes that aren't escaped or inside code.
function cells(line) {
  const out = [];
  let cell = "";
  let ticks = 0;
  const row = line.trim().replace(/^\|/, "");
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === "\\" && row[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (c === "`") {
      ticks = ticks ? 0 : 1;
      cell += c;
    } else if (c === "|" && !ticks) {
      out.push(cell.trim());
      cell = "";
    } else {
      cell += c;
    }
  }
  if (cell.trim()) out.push(cell.trim());
  return out;
}

const startsTable = (lines, i) =>
  lines[i].includes("|") &&
  i + 1 < lines.length &&
  TABLE_SEPARATOR.test(lines[i + 1]) &&
  /\|/.test(lines[i + 1]) &&
  lines[i + 1].includes("-");

// Alignment is a class, not a style attribute: the app's CSP blocks inline styles.
function table(lines, i) {
  const head = cells(lines[i]);
  const align = cells(lines[i + 1]).map((c) =>
    c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : c.startsWith(":") ? "left" : "",
  );
  const row = (values, tag) =>
    `<tr>${head
      .map((_, k) => {
        const cls = align[k] ? ` class="align-${align[k]}"` : "";
        return `<${tag}${cls}>${inline(values[k] ?? "")}</${tag}>`;
      })
      .join("")}</tr>`;
  const body = [];
  let j = i + 2;
  while (j < lines.length && !isBlank(lines[j]) && lines[j].includes("|"))
    body.push(row(cells(lines[j++]), "td"));
  const html = `<div class="md-table"><table><thead>${row(head, "th")}</thead><tbody>${body.join("")}</tbody></table></div>`;
  return [html, j];
}

// ---------- lists ----------

const ordered = (marker) => /\d/.test(marker);

// One list: every item at this indent with the same kind of marker, each with its indented lines.
function list(lines, i) {
  const first = lines[i].match(ITEM);
  const indent = first[1].length;
  const isOrdered = ordered(first[2]);
  const items = [];
  let loose = false;
  let j = i;
  while (j < lines.length) {
    const m = lines[j].match(ITEM);
    if (!m || m[1].length !== indent || ordered(m[2]) !== isOrdered) break;
    const contentIndent = indent + m[2].length + 1;
    const body = [m[3] ?? ""];
    j++;
    while (j < lines.length) {
      const line = lines[j];
      if (isBlank(line)) {
        const next = lines.slice(j).find((l) => !isBlank(l));
        if (next === undefined || indentOf(next) <= indent) {
          const sibling = next?.match(ITEM);
          if (sibling && sibling[1].length === indent && ordered(sibling[2]) === isOrdered) loose = true;
          break;
        }
        loose = true;
        body.push("");
      } else if (indentOf(line) > indent) {
        body.push(line.slice(Math.min(indentOf(line), contentIndent)));
      } else {
        break;
      }
      j++;
    }
    while (j < lines.length && isBlank(lines[j])) {
      const next = lines.slice(j).find((l) => !isBlank(l));
      const sibling = next?.match(ITEM);
      if (!sibling || sibling[1].length !== indent || ordered(sibling[2]) !== isOrdered) break;
      j++;
    }
    items.push(body);
  }

  const html = items.map((body) => {
    const task = body[0].match(/^\[([ xX])\]\s+/);
    if (task) body[0] = body[0].slice(task[0].length);
    const box = task ? `<span class="task">${task[1] === " " ? "☐" : "☑"}</span> ` : "";
    return `<li${task ? ' class="task-item"' : ""}>${box}${blocks(body, !loose)}</li>`;
  });
  const start = Number.parseInt(first[2], 10);
  const tag = isOrdered ? `ol${start !== 1 ? ` start="${start}"` : ""}` : "ul";
  return [`<${tag}>${html.join("")}</${isOrdered ? "ol" : "ul"}>`, j];
}

// ---------- blocks ----------

const startsBlock = (lines, i) =>
  FENCE.test(lines[i]) ||
  HEADING.test(lines[i]) ||
  RULE.test(lines[i]) ||
  QUOTE.test(lines[i]) ||
  ITEM.test(lines[i]) ||
  startsTable(lines, i);

// `tight`: list items without blank lines, whose text isn't wrapped in paragraphs.
function blocks(lines, tight = false) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const code = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
      i++; // the closing fence, if any; an unclosed fence runs to the end
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : "";
      out.push(`<pre class="code"${lang}>${escapeHtml(code.join("\n"))}</pre>`);
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(lines[i].replace(QUOTE, ""));
      out.push(`<blockquote>${blocks(quoted)}</blockquote>`);
      continue;
    }

    if (ITEM.test(line)) {
      const [html, next] = list(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    if (startsTable(lines, i)) {
      const [html, next] = table(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    const para = [line.trim()];
    for (i++; i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i); i++)
      para.push(lines[i].trim());
    out.push(tight ? inline(para.join("\n")) : `<p>${inline(para.join("\n"))}</p>`);
  }
  return out.join("");
}

// Leading tabs count as 4 spaces, except inside fenced code.
function expandTabs(text) {
  let fence = null;
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(FENCE);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2]) fence = null;
      return line;
    }
    if (m) fence = m[1];
    return line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    "));
  });
}

export function renderMarkdown(text) {
  const html = blocks(expandTabs(String(text ?? "")));
  return html ? `<div class="md">${html}</div>` : "";
}
