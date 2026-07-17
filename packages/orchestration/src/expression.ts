/**
 * The agrippa/v1 template expression language — deliberately non-Turing-complete
 * (ADR-0006): property paths, `==` `!=` `&&` `||` `!`, string/number/boolean/null
 * literals, and parentheses. No loops, no arithmetic, no function calls.
 *
 * Contexts: `inputs.*`, `steps.<id>.outputs.*`, `run.*`, `project.*`.
 */

export type ExpressionContext = Record<string, unknown>;

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(`${message} in expression: ${expression}`);
    this.name = "ExpressionError";
  }
}

type Token =
  | { kind: "path"; value: string[] }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "op"; value: "==" | "!=" | "&&" | "||" | "!" | "(" | ")" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (src.startsWith("==", i) || src.startsWith("!=", i)) {
      tokens.push({ kind: "op", value: src.slice(i, i + 2) as "==" | "!=" });
      i += 2;
      continue;
    }
    if (src.startsWith("&&", i) || src.startsWith("||", i)) {
      tokens.push({ kind: "op", value: src.slice(i, i + 2) as "&&" | "||" });
      i += 2;
      continue;
    }
    if (ch === "!") {
      tokens.push({ kind: "op", value: "!" });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) throw new ExpressionError("unterminated string", src);
      tokens.push({ kind: "string", value: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      const match = /^-?\d+(\.\d+)?/.exec(src.slice(i));
      if (!match) throw new ExpressionError("bad number", src);
      tokens.push({ kind: "number", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_-]*)*/.exec(src.slice(i));
      if (!match) throw new ExpressionError("bad identifier", src);
      const word = match[0];
      i += word.length;
      if (word === "true" || word === "false") {
        tokens.push({ kind: "boolean", value: word === "true" });
      } else if (word === "null") {
        tokens.push({ kind: "null" });
      } else {
        tokens.push({ kind: "path", value: word.split(".") });
      }
      continue;
    }
    throw new ExpressionError(`unexpected character '${ch}'`, src);
  }
  return tokens;
}

type Node =
  | { kind: "literal"; value: unknown }
  | { kind: "path"; segments: string[] }
  | { kind: "not"; operand: Node }
  | { kind: "binary"; op: "==" | "!=" | "&&" | "||"; left: Node; right: Node };

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  parse(): Node {
    const node = this.parseOr();
    if (this.pos < this.tokens.length) throw new ExpressionError("trailing tokens", this.src);
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private takeOp(value: string): boolean {
    const tok = this.peek();
    if (tok?.kind === "op" && tok.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.takeOp("||")) {
      left = { kind: "binary", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseEquality();
    while (this.takeOp("&&")) {
      left = { kind: "binary", op: "&&", left, right: this.parseEquality() };
    }
    return left;
  }

  private parseEquality(): Node {
    let left = this.parsePrimary();
    for (;;) {
      if (this.takeOp("==")) {
        left = { kind: "binary", op: "==", left, right: this.parsePrimary() };
      } else if (this.takeOp("!=")) {
        left = { kind: "binary", op: "!=", left, right: this.parsePrimary() };
      } else {
        return left;
      }
    }
  }

  private parsePrimary(): Node {
    if (this.takeOp("!")) return { kind: "not", operand: this.parsePrimary() };
    if (this.takeOp("(")) {
      const inner = this.parseOr();
      if (!this.takeOp(")")) throw new ExpressionError("missing closing paren", this.src);
      return inner;
    }
    const tok = this.peek();
    if (!tok) throw new ExpressionError("unexpected end of expression", this.src);
    this.pos++;
    switch (tok.kind) {
      case "string":
      case "number":
        return { kind: "literal", value: tok.value };
      case "boolean":
        return { kind: "literal", value: tok.value };
      case "null":
        return { kind: "literal", value: null };
      case "path":
        return { kind: "path", segments: tok.value };
      default:
        throw new ExpressionError(`unexpected token '${tok.value}'`, this.src);
    }
  }
}

export function parseExpression(src: string): Node {
  return new Parser(tokenize(src), src).parse();
}

function resolvePath(segments: string[], ctx: ExpressionContext): unknown {
  let value: unknown = ctx;
  for (const segment of segments) {
    if (value == null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function evalNode(node: Node, ctx: ExpressionContext, src: string): unknown {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "path":
      return resolvePath(node.segments, ctx);
    case "not":
      return !evalNode(node.operand, ctx, src);
    case "binary": {
      const left = evalNode(node.left, ctx, src);
      if (node.op === "&&") return Boolean(left) && Boolean(evalNode(node.right, ctx, src));
      if (node.op === "||") return Boolean(left) || Boolean(evalNode(node.right, ctx, src));
      const right = evalNode(node.right, ctx, src);
      return node.op === "==" ? left === right : left !== right;
    }
  }
}

export function evaluateExpression(src: string, ctx: ExpressionContext): unknown {
  return evalNode(parseExpression(src), ctx, src);
}

/** `when:` semantics — truthy result runs the step. */
export function evaluateCondition(src: string, ctx: ExpressionContext): boolean {
  return Boolean(evaluateExpression(src, ctx));
}

/**
 * `when:` values may be written bare (`inputs.autoOpenPr`) or wrapped
 * (`${inputs.autoOpenPr}`); normalize to the bare expression.
 */
export function normalizeConditionExpression(src: string): string {
  const trimmed = src.trim();
  if (trimmed.startsWith("${") && trimmed.endsWith("}") && !trimmed.slice(2, -1).includes("${")) {
    return trimmed.slice(2, -1).trim();
  }
  return trimmed;
}

const PLACEHOLDER = /\$\{([^}]+)\}/g;

/** Replaces every `${expr}` in a string with the stringified evaluation result. */
export function interpolate(template: string, ctx: ExpressionContext): string {
  return template.replace(PLACEHOLDER, (_, expr: string) => {
    const value = evaluateExpression(expr.trim(), ctx);
    if (value == null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

/** All `${...}` expressions found in a string (for compile-time validation). */
export function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => (m[1] as string).trim());
}

/** Root identifiers referenced by an expression (inputs, steps, run, project). */
export function expressionRoots(src: string): string[] {
  const roots = new Set<string>();
  const walk = (node: Node): void => {
    if (node.kind === "path") {
      const [root] = node.segments;
      if (root) roots.add(root);
    } else if (node.kind === "not") {
      walk(node.operand);
    } else if (node.kind === "binary") {
      walk(node.left);
      walk(node.right);
    }
  };
  walk(parseExpression(src));
  return [...roots];
}
