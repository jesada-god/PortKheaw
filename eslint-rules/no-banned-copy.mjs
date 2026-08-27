/**
 * portkheaw/no-banned-copy
 *
 * The phrases in `NEVER_SAY` must not reach a reader, on any of the five pages
 * Phase 1 covers. Each one either claims a narrator the product does not have
 * ("ระบบประเมินว่า", "AI วิเคราะห์ว่า") or sells the reader something
 * ("เครื่องมือนี้จะช่วยให้คุณ"). The list and the reasoning live in
 * `src/lib/presentation/banned-copy.ts`; this rule is only the enforcement.
 *
 * It exists because the list did not have one. It was a `const` inside
 * `MarketSignalSection.test.tsx`, so exactly one component in the product was
 * held to it — and while that card was being kept clean, a Tools card two
 * folders away shipped "เครื่องมือนี้จะช่วยให้คุณ" and the stock page grew a
 * banner reading "การวิเคราะห์ด้วย AI — กำลังจะมา".
 *
 * WHAT IT LOOKS AT: every string the file can hand a reader — string literals,
 * template chunks, and JSX text. Deliberately NOT comments, for the same reason
 * `no-unsourced-frame-word` skips them: a comment recording that a phrase was
 * removed is the note explaining the fix, and a rule that could not tell it
 * from the phrase itself would forbid documenting its own enforcement.
 *
 * There is no allow list, and that is the difference from the frame-word rule.
 * That one asks "is this word sourced" and has legitimate answers; this one
 * asks "does the product say this", and the answer is no.
 */

const DEFAULT_BANNED = [
  'ระบบประเมินว่า',
  'จากการวิเคราะห์ปัจจัย',
  'มีความเป็นไปได้ว่า',
  'เครื่องมือนี้จะช่วยให้คุณ',
  'AI วิเคราะห์ว่า',
  'การวิเคราะห์ด้วย AI',
];

/** The reader-facing text of a node, or null if it is not reader-facing. */
function readerText(node) {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (node.type === 'TemplateElement') return node.value?.cooked ?? node.value?.raw ?? null;
  if (node.type === 'JSXText') return node.value;
  return null;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep phrases that claim an unnamed narrator, forecast, or sell the reader out of user-facing copy.',
    },
    schema: [{
      type: 'object',
      properties: {
        banned: {
          type: 'array',
          items: { type: 'string' },
          description: 'The phrases to reject. Defaults to NEVER_SAY from src/lib/presentation/banned-copy.ts.',
        },
      },
      additionalProperties: false,
    }],
    messages: {
      banned:
        'This copy says "{{phrase}}", which PortKheaw does not say. '
        + 'If it attributes a reading to a system ("ระบบประเมินว่า", "AI วิเคราะห์ว่า"), name the service '
        + 'that produced it instead. If it forecasts ("มีความเป็นไปได้ว่า"), state what IS. '
        + 'If it sells ("เครื่องมือนี้จะช่วยให้คุณ"), say what the thing does. '
        + 'See src/lib/presentation/banned-copy.ts.',
    },
  },

  create(context) {
    const banned = context.options[0]?.banned ?? DEFAULT_BANNED;

    return {
      Program(program) {
        const visit = (node) => {
          if (node === null || typeof node !== 'object' || typeof node.type !== 'string') return;

          const text = readerText(node);
          if (text !== null) {
            for (const phrase of banned) {
              if (text.includes(phrase)) {
                context.report({ node, messageId: 'banned', data: { phrase } });
                break;
              }
            }
          }

          for (const [key, value] of Object.entries(node)) {
            /*
             * `parent` walks back up, and `tokens`/`comments` hang off Program
             * holding token objects whose `type` looks like a node type — a
             * JSXText token would otherwise be reported twice, and a comment
             * would be scanned as though it were copy.
             */
            if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
            if (Array.isArray(value)) {
              for (const item of value) visit(item);
            } else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
              visit(value);
            }
          }
        };
        visit(program);
      },
    };
  },
};

export default rule;
