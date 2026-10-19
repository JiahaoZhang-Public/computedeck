import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Technical abbreviations, units and keyboard/version notation are language-neutral.
const neutral = new Set(['GPU', 'CPU', 'SSH', 'AI', '⌘K', 'v', '/h']);
// Exact, file-scoped exceptions: brand text and executable/example input values only.
const examples: Record<string, string[]> = {
  'App.tsx': ['Compute', 'Deck'],
  'TokenGate.tsx': ['computedeck token'],
  'forms.tsx': ['gpu-box-01', 'gpu-box', '~/.ssh/id_ed25519', 'RTX 4090'],
  'pages/Nodes.tsx': ['lab-gateway', '~/.local/bin/computedeck'],
  'pages/Notify.tsx': ['alice, bob', 'llm-*'],
  'pages/Marketplace.tsx': ['· ComputeDeck'],
};

function literals(code: string) {
  const file = ts.createSourceFile(
    'view.tsx',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: { text: string; line: number }[] = [];
  function add(node: ts.Node, text: string) {
    if (/[A-Za-z]/.test(text))
      found.push({
        text: text.trim(),
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
  }
  function expression(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isConditionalExpression(node)) {
      expression(node.whenTrue);
      expression(node.whenFalse);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      expression(node.right);
    } else if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind,
      )
    ) {
      expression(node.left);
      expression(node.right);
    } else if (ts.isParenthesizedExpression(node)) expression(node.expression);
    else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text);
      for (const span of node.templateSpans) add(span.literal, span.literal.text);
    }
  }
  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) add(node, node.text);
    if (
      ts.isJsxAttribute(node) &&
      ['title', 'placeholder', 'aria-label'].includes(node.name.getText())
    ) {
      if (node.initializer) {
        if (ts.isJsxExpression(node.initializer)) {
          if (node.initializer.expression) expression(node.initializer.expression);
        } else expression(node.initializer);
      }
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression)
      expression(node.expression);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

it('finds visible text and attribute literals without treating translation keys as prose', () => {
  const found = literals(
    `<><dt>Slurm Account</dt><input title="Details" placeholder={'Lab gateway'} aria-label={ready ? 'Ready' : 'Wait'} />{'Hard-coded'}{t('job.account')}<span className="drawer-body">{job.name}</span></>`,
  );
  expect(found.map(({ text }) => text)).toEqual([
    'Slurm Account',
    'Details',
    'Lab gateway',
    'Ready',
    'Wait',
    'Hard-coded',
  ]);
});

it('keeps visible JSX text and title/placeholder/aria-label literals translated', () => {
  const files = ['', 'pages/'].flatMap((directory) =>
    readdirSync(new URL(`./${directory}`, import.meta.url))
      .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
      .map((name) => directory + name),
  );
  const untranslated = files.flatMap((name) =>
    literals(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
      .filter(({ text }) => !neutral.has(text) && !examples[name]?.includes(text))
      .map(({ text, line }) => `${name}:${line}: ${text}`),
  );
  expect(untranslated).toEqual([]);
});
