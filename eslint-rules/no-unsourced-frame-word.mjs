/**
 * market-signal/no-unsourced-frame-word
 *
 * "กรอบ" is the card's word for ONE object: the rectangle drawn on the zone
 * bar, whose edges are `frame.support` / `frame.resistance` buffered by
 * `MARKET_SIGNAL_ZONE.triggerAtrMultiple` ATR. Nothing else in the payload is
 * a กรอบ, and the engine measures at least one other boundary that is easy to
 * mistake for one — the confirmed swing pivot behind `breakoutDirection()`,
 * buffered by a 0.1% ratio instead.
 *
 * The two disagree on purpose. `zones.pendingBreakout` is the state where a
 * close is through the pivot but not yet through the frame trigger, so a card
 * can truthfully hold both "price is through" and "the frame has not moved" at
 * the same moment. That is only legible to a reader if the two facts are given
 * different nouns. It has now gone wrong twice: once in a reason translation
 * ("ราคาปิดออกนอกกรอบแล้ว" under a bar reading "ราคายังอยู่ในกรอบเดิม"), and
 * once on a flag chip ("ออกนอกกรอบก่อนงบ", raised from `breakout || breakdown`).
 * Both were pivot facts wearing the frame's word.
 *
 * WHAT COUNTS AS PROOF. A string may say "กรอบ" if the code around it reads
 * `zones` — the frame's own payload field. That is deliberately a cheap test
 * with an honest failure mode: it cannot tell whether a sentence is ABOUT the
 * frame, only whether the frame was in the author's hands when they wrote it.
 * Component JSX passes on its own, because a component rendering the zone bar
 * has `zones` in scope. Module-level copy tables never do, so every table entry
 * that says "กรอบ" without reading anything is listed in `allow` by its
 * qualified name (`TABLE.key`) with a comment giving its provenance. That list
 * is the point: it is where somebody has to write down WHY a boundary is the
 * frame, one entry at a time, and a reviewer can check the claim against
 * `calculations.ts`. Silence is not an exception.
 *
 * WHAT IT LOOKS AT. Every string the file can hand a reader: string literals,
 * template chunks, and JSX text. Not comments — this block would fail itself.
 */

const FRAME_WORD = 'กรอบ';
const SOURCE = 'zones';

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
]);

/** The reader-facing text of a node, or null if it is not reader-facing. */
function readerText(node) {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (node.type === 'TemplateElement') return node.value?.cooked ?? node.value?.raw ?? null;
  if (node.type === 'JSXText') return node.value;
  return null;
}

/**
 * `TABLE.key`, the name a reviewer can look up.
 *
 * Built from the property keys between the string and the declaration that
 * names the table, so a nested table reads `OUTER.inner.key`. A string that is
 * not in a table at all falls back to the variable it is assigned to.
 */
function qualifiedName(node, ancestors, sourceCode) {
  const parts = [];
  const chain = [...ancestors, node];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index];
    const child = index === chain.length - 1 ? null : chain[index + 1];
    if (node.type === 'Property' && node.value === child) {
      if (node.key.type === 'Literal') parts.push(String(node.key.value));
      else if (node.key.type === 'Identifier' && !node.computed) parts.push(node.key.name);
      else parts.push(sourceCode.getText(node.key));
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      parts.push(node.id.name);
      break;
    }
  }
  if (parts.length) return parts.reverse().join('.');
  // Not in a table: a string returned straight out of a named helper. The
  // function's name is what a reviewer would look up, so it is the name the
  // allow list uses.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index];
    if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') return node.id.name;
  }
  return '';
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reserve the word "กรอบ" for copy written where the zone frame (`zones`) is in scope, so the frame and the confirmed-pivot boundary never share a noun.',
    },
    schema: [{
      type: 'object',
      properties: {
        allow: {
          type: 'array',
          items: { type: 'string' },
          description: 'Qualified copy-entry names (`TABLE.key`) that are the frame but read nothing. Each one needs a comment saying how it is pinned to the frame.',
        },
      },
      additionalProperties: false,
    }],
    messages: {
      unsourced:
        '"{{word}}" is the zone frame’s word, but nothing around "{{name}}" reads `zones`. '
        + 'If this is the frame, read it from `zones`; if it is the confirmed-pivot boundary '
        + '(anything raised from `breakoutDirection()`), give it its own noun. '
        + 'If it is genuinely the frame with nothing to read, add "{{name}}" to the rule’s `allow` list with its provenance.',
    },
  },

  create(context) {
    const allow = new Set(context.options[0]?.allow ?? []);
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      Program(program) {
        /** Positions of every `zones` identifier, to test containment against. */
        const zoneReads = [];
        const hits = [];
        const ancestors = [];

        const visit = (node) => {
          if (node === null || typeof node !== 'object' || typeof node.type !== 'string') return;

          if (node.type === 'Identifier' && node.name === SOURCE) zoneReads.push(node.range[0]);

          const text = readerText(node);
          if (text !== null && text.includes(FRAME_WORD)) {
            hits.push({ node, ancestors: [...ancestors] });
          }

          ancestors.push(node);
          for (const [key, value] of Object.entries(node)) {
            // `parent` walks back up; `tokens` and `comments` hang off Program
            // and hold token objects whose `type` looks like a node type —
            // a JSXText token would otherwise be reported a second time, with
            // Program as its only ancestor and so no function to check.
            if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
            if (Array.isArray(value)) {
              for (const item of value) visit(item);
            } else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
              visit(value);
            }
          }
          ancestors.pop();
        };
        visit(program);

        for (const { node, ancestors: chain } of hits) {
          const enclosing = chain.filter((item) => FUNCTION_TYPES.has(item.type));
          const inScope = enclosing.some((fn) => zoneReads.some(
            (at) => at >= fn.range[0] && at < fn.range[1],
          ));
          if (inScope) continue;

          const name = qualifiedName(node, chain, sourceCode) || '(unnamed string)';
          if (allow.has(name)) continue;

          context.report({ node, messageId: 'unsourced', data: { word: FRAME_WORD, name } });
        }
      },
    };
  },
};

export default rule;
