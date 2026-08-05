function isDashCommentStart(source, index) {
  return source[index] === "-"
    && source[index + 1] === "-"
    && (index + 2 >= source.length || /\s/.test(source[index + 2]));
}

function directiveDelimiter(line, current, quote, blockComment) {
  if (quote || blockComment || current.trim()) return null;
  const match = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
  return match?.[1] || null;
}

/**
 * Split MySQL migration source into executable statements.
 *
 * DELIMITER is a mysql-client directive, not server SQL. This parser consumes
 * the directive and preserves semicolons inside compound trigger bodies so the
 * complete CREATE TRIGGER statement is sent through mysql2 in one query.
 */
export function splitOperationalMigrationStatements(sql) {
  const source = String(sql || "").replace(/\r\n?/g, "\n");
  const statements = [];
  let delimiter = ";";
  let current = "";
  let quote = null;
  let blockComment = false;

  const lines = source.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const declaredDelimiter = directiveDelimiter(line, current, quote, blockComment);
    if (declaredDelimiter) {
      delimiter = declaredDelimiter;
      continue;
    }

    const lineSource = lineIndex === lines.length - 1 ? line : `${line}\n`;
    let lineComment = false;

    for (let index = 0; index < lineSource.length; index += 1) {
      const character = lineSource[index];
      const next = lineSource[index + 1] || "";

      if (lineComment) {
        current += character;
        continue;
      }
      if (blockComment) {
        current += character;
        if (character === "*" && next === "/") {
          current += next;
          index += 1;
          blockComment = false;
        }
        continue;
      }
      if (quote) {
        current += character;
        if (character === "\\" && quote !== "`" && index + 1 < lineSource.length) {
          current += next;
          index += 1;
          continue;
        }
        if (character === quote) {
          if (next === quote) {
            current += next;
            index += 1;
          } else {
            quote = null;
          }
        }
        continue;
      }
      if (isDashCommentStart(lineSource, index) || character === "#") {
        lineComment = true;
        current += character;
        if (character === "-" && next === "-") {
          current += next;
          index += 1;
        }
        continue;
      }
      if (character === "/" && next === "*") {
        blockComment = true;
        current += character + next;
        index += 1;
        continue;
      }
      if (["'", "\"", "`"].includes(character)) {
        quote = character;
        current += character;
        continue;
      }
      if (delimiter && lineSource.startsWith(delimiter, index)) {
        const statement = current.trim();
        if (statement) statements.push(statement);
        current = "";
        index += delimiter.length - 1;
        continue;
      }
      current += character;
    }
  }

  if (quote) throw new TypeError("Migration SQL contains an unterminated quoted value.");
  if (blockComment) throw new TypeError("Migration SQL contains an unterminated block comment.");

  const finalStatement = current.trim();
  if (finalStatement) statements.push(finalStatement);
  return statements;
}
