// Fast drop-in replacement for csv-reader 1.0.0: run(input) returns exactly
// csv-reader's reading of {text, header} — {columns, rows, errors} — for every
// input, but reads the text with indexOf-driven chunk scanning instead of one
// character at a time.
//
// The reading policy (identical to the reference):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote, and each CRLF or lone CR inside it
//     is read as LF; what follows the closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//   - a quote that never closes is a literal character and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows are
//     padded with "" (short_row) or cut (long_row) to the first record's
//     width; each error is {code, line, row} in the order met, line the
//     1-based line its record starts on, row its record's index in rows
//     (null for the header).
//
// Speed comes from three things: a whole-record fast path for the common
// record that holds no quote and no stray CR (one scan to the line's end,
// then a split on commas); field readers that jump between special
// characters with indexOf and slice whole runs at once; and two lookahead
// cursors (next quote, next CR) that only ever move forward, so each
// character is scanned a bounded number of times per call.

const COMMA = 0;
const BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;

  function pushErr(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Lookahead cursors: nq is the index of the first '"' at or after nqFrom
  // (or -1 when there is none from nqFrom on), nr the same for '\r'. Parsing
  // moves forward only, except for the unterminated-quote rewind, which the
  // nqFrom/nrFrom guards absorb by rescanning from the rewound position.
  let nq = -2;
  let nqFrom = 0;
  let nr = -2;
  let nrFrom = 0;

  function nextQuote(p) {
    if (nq === -2 || nqFrom > p || (nq !== -1 && nq < p)) {
      nq = text.indexOf('"', p);
      nqFrom = p;
    }
    return nq;
  }

  function nextCR(p) {
    if (nr === -2 || nrFrom > p || (nr !== -1 && nr < p)) {
      nr = text.indexOf('\r', p);
      nrFrom = p;
    }
    return nr;
  }

  // The number of LF characters in text[a..b).
  function countLF(a, b) {
    let n = 0;
    let k = a;
    while (k < b) {
      const j = text.indexOf('\n', k);
      if (j === -1 || j >= b) break;
      n += 1;
      k = j + 1;
    }
    return n;
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field,
  // how it ended, and how many characters were kept onto `value`.
  function readUnquoted(value) {
    let added = 0;
    let seg = pos; // the start of the current verbatim run
    let i = pos;
    for (;;) {
      const ic = text.indexOf(',', i);
      const il = text.indexOf('\n', i);
      const r = nextCR(i);
      if (r !== -1 && (ic === -1 || r < ic) && (il === -1 || r < il)) {
        // A CR is the next special character.
        if (text.charCodeAt(r + 1) === 10) {
          if (r > seg) {
            value += text.slice(seg, r);
            added += r - seg;
          }
          pos = r + 2;
          line += 1;
          return { value, ended: BREAK, added };
        }
        pushErr('stray_cr');
        if (r > seg) {
          value += text.slice(seg, r);
          added += r - seg;
        }
        i = seg = r + 1;
        pos = i;
        continue;
      }
      if (ic === -1 && il === -1) {
        if (len > seg) {
          value += text.slice(seg, len);
          added += len - seg;
        }
        pos = len;
        return { value, ended: END, added };
      }
      if (il === -1 || (ic !== -1 && ic < il)) {
        if (ic > seg) {
          value += text.slice(seg, ic);
          added += ic - seg;
        }
        pos = ic + 1;
        return { value, ended: COMMA, added };
      }
      if (il > seg) {
        value += text.slice(seg, il);
        added += il - seg;
      }
      pos = il + 1;
      line += 1;
      return { value, ended: BREAK, added };
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    let i = open + 1;
    let seg = i; // the start of the current verbatim run inside the quotes
    let value = '';
    let brk = 0; // line breaks inside the quoted content, counted as met
    let closed = false;
    for (;;) {
      const q = nextQuote(i);
      const r = nextCR(i);
      if (q === -1 && r === -1) break;
      if (r === -1 || (q !== -1 && q < r)) {
        // A quote is the next special character.
        if (text.charCodeAt(q + 1) === 34) {
          // A doubled quote: one literal quote.
          if (q > seg) {
            value += text.slice(seg, q);
            brk += countLF(seg, q);
          }
          value += '"';
          seg = i = q + 2;
          continue;
        }
        if (q > seg) {
          value += text.slice(seg, q);
          brk += countLF(seg, q);
        }
        closed = true;
        pos = q + 1;
        break;
      }
      // A CR is the next special character: CRLF and a lone CR are each
      // read as one LF.
      if (r > seg) {
        value += text.slice(seg, r);
        brk += countLF(seg, r);
      }
      value += '\n';
      brk += 1;
      seg = i = r + (text.charCodeAt(r + 1) === 10 ? 2 : 1);
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted. `line` was never advanced by
      // the scan, so nothing needs restoring.
      pushErr('unterminated_quote');
      pos = open + 1;
      return readUnquoted('"');
    }
    line += brk;
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) pushErr('quote_junk');
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let lastQuoted = false;

    // Whole-record fast path: the record up to the next LF holds no quote
    // and no CR but the CR of its own CRLF, so it is a run of unquoted
    // fields split on commas.
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? len : nl;
    const q = nextQuote(pos);
    const r = nextCR(pos);
    if (
      (q === -1 || q >= segEnd) &&
      (r === -1 || r >= segEnd || (nl !== -1 && r === segEnd - 1))
    ) {
      const contentEnd = nl !== -1 && r === segEnd - 1 ? segEnd - 1 : segEnd;
      fields = [];
      let fstart = pos;
      for (;;) {
        const c = text.indexOf(',', fstart);
        if (c === -1 || c >= contentEnd) {
          fields.push(text.slice(fstart, contentEnd));
          break;
        }
        fields.push(text.slice(fstart, c));
        fstart = c + 1;
      }
      pos = nl === -1 ? len : nl + 1;
      if (nl !== -1) line += 1;
    } else {
      fields = [];
      let field;
      do {
        lastQuoted = text.charCodeAt(pos) === 34;
        field = lastQuoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({
        code: 'short_row',
        line: recordLine,
        row: recordRow,
        fields: fields.length,
      });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({
        code: 'long_row',
        line: recordLine,
        row: recordRow,
        extra: fields.splice(width),
      });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors };
}
