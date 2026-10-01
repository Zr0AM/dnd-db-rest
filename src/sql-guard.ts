/**
 * Conservative read-only check for the raw `POST /query` route.
 *
 * This is a guard against accidental or casual misuse by a token holder, not a SQL
 * parser: anything it cannot positively recognise as a single SELECT / WITH statement
 * is refused. Data and schema changes go through `wrangler d1 execute`.
 */

/** Keywords that start (or hide inside a CTE) a statement that could change data or schema. */
const FORBIDDEN_KEYWORDS = /\b(insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze)\b/i;

/** Internal tables and pragma table-valued functions, wherever they appear in the statement. */
const FORBIDDEN_NAMES = /\b(sqlite_|d1_|_cf_)|\bpragma_/i;

/**
 * Splits a statement into:
 *  - `text`: the SQL with comments replaced by a space (string literals kept), used to
 *    look for blocked table names even inside quoted names;
 *  - `code`: the same, but string literals and quoted identifiers are emptied, used to
 *    look at the real keywords and statement separators.
 */
function scan(sql: string): { text: string; code: string } {
    let text = '';
    let code = '';
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];

        if (ch === '-' && next === '-') {
            const end = sql.indexOf('\n', i);
            i = end === -1 ? sql.length : end;
            text += ' ';
            code += ' ';
        } else if (ch === '/' && next === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end === -1 ? sql.length : end + 2;
            text += ' ';
            code += ' ';
        } else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
            // Quoted literal/identifier. A doubled quote character is an escaped quote.
            const close = ch === '[' ? ']' : ch;
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === close) {
                    if (close !== ']' && sql[j + 1] === close) {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j++;
            }
            text += sql.slice(i, j + 1);
            code += ' ' + close + close + ' ';
            i = j + 1;
        } else {
            text += ch;
            code += ch;
            i++;
        }
    }
    return { text, code };
}

/**
 * Returns true when `sql` is a single read-only statement: it starts with SELECT or WITH,
 * has no other statement after a `;`, contains none of the write/DDL keywords (outside
 * quotes and comments) and does not reference internal tables (sqlite_*, d1_*, _cf_*).
 */
export function isReadOnlyQuery(sql: string): boolean {
    const { text, code } = scan(sql);

    // A single trailing `;` (and whitespace) is fine, nothing may follow a `;`
    const statement = code.trim().replace(/;\s*$/, '');
    if (statement.includes(';')) return false;

    if (!/^(select|with)\b/i.test(statement)) return false;

    // REPLACE is a legitimate scalar function: `replace(x, 'a', 'b')`
    const withoutReplaceFunction = statement.replace(/\breplace\s*\(/gi, ' ');
    if (FORBIDDEN_KEYWORDS.test(withoutReplaceFunction)) return false;

    if (FORBIDDEN_NAMES.test(text)) return false;

    return true;
}
