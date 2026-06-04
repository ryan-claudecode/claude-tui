/**
 * MathService — the no-shell calculator: safely evaluate an arithmetic
 * expression (no `eval`, a hand-written recursive-descent parser), convert an
 * integer between bases (2/8/10/16 or any 2–36), and compute summary statistics
 * over a list of numbers. Pure and stateless.
 */

export interface Stats {
  count: number
  sum: number
  mean: number
  median: number
  min: number
  max: number
  range: number
  variance: number
  stddev: number
}

export class MathService {
  private readonly constants: Record<string, number> = {
    pi: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
  }

  private readonly funcs: Record<string, (x: number) => number> = {
    abs: Math.abs,
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    ln: Math.log,
    log: Math.log10,
    log2: Math.log2,
    exp: Math.exp,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    sign: Math.sign,
  }

  /**
   * Evaluate an arithmetic expression. Supports + - * / % ^ (or **), unary
   * minus, parentheses, the constants pi/e/tau, and single-arg functions
   * (sqrt, sin, ln, ...). Throws a clear error on malformed input.
   */
  evaluate(expr: string): { result: number; expression: string } {
    const tokens = this.tokenize(expr)
    const parser = new Parser(tokens, this.constants, this.funcs)
    const result = parser.parse()
    return { result, expression: expr }
  }

  /**
   * Convert an integer string from `fromBase` to every common base. `fromBase`
   * 2–36. Returns the value in binary, octal, decimal, and hex (plus the parsed
   * decimal number).
   */
  convertBase(
    value: string,
    fromBase: number,
  ): { decimal: number; binary: string; octal: string; hex: string } {
    if (fromBase < 2 || fromBase > 36) throw new Error(`fromBase must be 2–36, got ${fromBase}`)
    const cleaned = value.trim().replace(/^0[xbo]/i, "")
    const n = parseInt(cleaned, fromBase)
    if (isNaN(n)) throw new Error(`"${value}" is not a valid base-${fromBase} integer`)
    return {
      decimal: n,
      binary: n.toString(2),
      octal: n.toString(8),
      hex: n.toString(16),
    }
  }

  /** Summary statistics over a list of numbers. */
  stats(numbers: number[]): Stats {
    if (numbers.length === 0) throw new Error("Cannot compute stats over an empty list")
    const sorted = [...numbers].sort((a, b) => a - b)
    const count = numbers.length
    const sum = numbers.reduce((a, b) => a + b, 0)
    const mean = sum / count
    const median =
      count % 2 === 0
        ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
        : sorted[(count - 1) / 2]
    const min = sorted[0]
    const max = sorted[count - 1]
    const variance = numbers.reduce((a, b) => a + (b - mean) ** 2, 0) / count
    return {
      count,
      sum,
      mean,
      median,
      min,
      max,
      range: max - min,
      variance,
      stddev: Math.sqrt(variance),
    }
  }

  private tokenize(expr: string): string[] {
    const tokens: string[] = []
    const re = /\s*([A-Za-z]\w*|\d*\.?\d+(?:[eE][+-]?\d+)?|\*\*|[-+*/%^(),])\s*/g
    let pos = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(expr)) !== null) {
      if (m.index !== pos) break
      tokens.push(m[1])
      pos = re.lastIndex
    }
    if (pos !== expr.length) {
      throw new Error(`Unexpected character at position ${pos} in "${expr}"`)
    }
    return tokens
  }
}

/** Recursive-descent parser for the arithmetic grammar (no eval). */
class Parser {
  private i = 0

  constructor(
    private tokens: string[],
    private constants: Record<string, number>,
    private funcs: Record<string, (x: number) => number>,
  ) {}

  parse(): number {
    if (this.tokens.length === 0) throw new Error("Empty expression")
    const v = this.expr()
    if (this.i !== this.tokens.length) {
      throw new Error(`Unexpected token "${this.tokens[this.i]}"`)
    }
    return v
  }

  private peek(): string | undefined {
    return this.tokens[this.i]
  }

  private next(): string {
    return this.tokens[this.i++]
  }

  // expr := term (('+' | '-') term)*
  private expr(): number {
    let v = this.term()
    while (this.peek() === "+" || this.peek() === "-") {
      const op = this.next()
      const rhs = this.term()
      v = op === "+" ? v + rhs : v - rhs
    }
    return v
  }

  // term := factor (('*' | '/' | '%') factor)*
  private term(): number {
    let v = this.factor()
    while (this.peek() === "*" || this.peek() === "/" || this.peek() === "%") {
      const op = this.next()
      const rhs = this.factor()
      if (op === "*") v *= rhs
      else if (op === "/") v /= rhs
      else v %= rhs
    }
    return v
  }

  // factor := unary ('^' | '**') factor   (right-associative)
  private factor(): number {
    const base = this.unary()
    if (this.peek() === "^" || this.peek() === "**") {
      this.next()
      return base ** this.factor()
    }
    return base
  }

  // unary := ('-' | '+') unary | primary
  private unary(): number {
    if (this.peek() === "-") {
      this.next()
      return -this.unary()
    }
    if (this.peek() === "+") {
      this.next()
      return this.unary()
    }
    return this.primary()
  }

  // primary := number | constant | func '(' expr ')' | '(' expr ')'
  private primary(): number {
    const t = this.peek()
    if (t === undefined) throw new Error("Unexpected end of expression")

    if (t === "(") {
      this.next()
      const v = this.expr()
      if (this.next() !== ")") throw new Error("Missing closing parenthesis")
      return v
    }

    if (/^[A-Za-z]/.test(t)) {
      this.next()
      if (this.peek() === "(") {
        const fn = this.funcs[t]
        if (!fn) throw new Error(`Unknown function "${t}"`)
        this.next()
        const arg = this.expr()
        if (this.next() !== ")") throw new Error("Missing closing parenthesis")
        return fn(arg)
      }
      const c = this.constants[t.toLowerCase()]
      if (c === undefined) throw new Error(`Unknown identifier "${t}"`)
      return c
    }

    const n = Number(this.next())
    if (isNaN(n)) throw new Error(`Invalid number "${t}"`)
    return n
  }
}
