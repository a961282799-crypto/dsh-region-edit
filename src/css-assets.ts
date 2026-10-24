/** Rewrite resource tokens without treating CSS comments or ordinary strings as URLs. */
export async function rewriteCssAssets(css: string, replace: (url: string, stylesheet: boolean) => Promise<string | undefined>): Promise<string> {
  const decode = (value: string) => value.replace(/\\(?:([\da-f]{1,6})\s?|([\s\S]))/gi, (_all, hex: string | undefined, character: string) => {
    if (!hex) return /[\r\n\f]/.test(character) ? '' : character;
    const code = parseInt(hex, 16); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  });
  const quotedEnd = (start: number) => {
    let end = start + 1;
    while (end < css.length) { if (css[end] === '\\') end += 2; else if (css[end++] === css[start]) break; }
    return Math.min(end, css.length);
  };
  let result = '', i = 0, importing = false;
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const closing = css.indexOf('*/', i + 2), end = closing < 0 ? css.length : closing + 2;
      result += css.slice(i, end); i = end; continue;
    }
    const start = i, char = css[i]!;
    if (char === '@' && /^@import(?![\w-])/i.test(css.slice(i))) {
      result += css.slice(i, i + 7); i += 7; importing = true; continue;
    }
    if (char === '"' || char === "'") {
      const end = quotedEnd(i);
      const replacement = importing ? await replace(decode(css.slice(i + 1, end - 1)), true) : undefined;
      result += replacement === undefined ? css.slice(i, end) : `url(${JSON.stringify(replacement)})`;
      i = end; importing = false; continue;
    }
    if ((char === 'u' || char === 'U') && /^url\(/i.test(css.slice(i)) && (i === 0 || !/[\w-]/.test(css[i - 1]!))) {
      let valueStart = i + 4; while (/\s/.test(css[valueStart] ?? '') && valueStart < css.length) valueStart++;
      let end: number, value: string;
      if (css[valueStart] === '"' || css[valueStart] === "'") {
        end = quotedEnd(valueStart); value = css.slice(valueStart + 1, end - 1);
        while (end < css.length && /\s/.test(css[end]!)) end++;
      } else {
        end = valueStart;
        while (end < css.length && css[end] !== ')') end += css[end] === '\\' ? 2 : 1;
        value = css.slice(valueStart, end).trim();
      }
      if (css[end] === ')') {
        const replacement = await replace(decode(value), importing);
        result += replacement === undefined ? css.slice(start, end + 1) : `url(${JSON.stringify(replacement)})`;
        i = end + 1; importing = false; continue;
      }
    }
    if (char === ';' || char === '{' || char === '}') importing = false;
    result += char; i++;
  }
  return result;
}
