/**
 * Minimal exact rational number for the sync layer.
 *
 * The Python engine (python/hornscribe/rhythm/timewarp.py, beatmap.py) keeps
 * all score positions as exact `fractions.Fraction` quarterLength values and
 * only treats seconds as floats. This module mirrors that contract so the
 * TypeScript port never accumulates binary floating-point drift in musical
 * positions: `Fraction(float)` semantics are reproduced by
 * {@link Rational.fromFloat}, which decomposes the IEEE-754 double exactly.
 *
 * Only the operations the TimeWarp/BeatMap slice needs are implemented.
 */
export class Rational {
  /** Normalized numerator (sign lives here). */
  readonly num: bigint
  /** Normalized denominator, always > 0. */
  readonly den: bigint

  private constructor(num: bigint, den: bigint) {
    if (den === 0n) throw new Error('Rational: denominator must not be 0')
    if (den < 0n) {
      num = -num
      den = -den
    }
    const g = gcd(abs(num), den)
    this.num = num / g
    this.den = den / g
  }

  static of(num: bigint | number, den: bigint | number = 1n): Rational {
    return new Rational(BigInt(num), BigInt(den))
  }

  static zero(): Rational {
    return new Rational(0n, 1n)
  }

  /**
   * Exact conversion of a finite IEEE-754 double — the equivalent of
   * Python's `Fraction(float_value)`. Rejects NaN/Infinity like
   * `Fraction()` does (ValueError/OverflowError there, Error here).
   */
  static fromFloat(value: number): Rational {
    if (!Number.isFinite(value)) {
      throw new Error(`Rational.fromFloat: value must be finite, got ${value}`)
    }
    if (value === 0) return Rational.zero()
    const buf = new DataView(new ArrayBuffer(8))
    buf.setFloat64(0, value)
    const bits = buf.getBigUint64(0)
    const sign = (bits >> 63n) === 1n ? -1n : 1n
    const expField = Number((bits >> 52n) & 0x7ffn)
    const mantissaField = bits & ((1n << 52n) - 1n)
    let num: bigint
    let e2: number
    if (expField === 0) {
      // subnormal
      num = mantissaField
      e2 = -1074
    } else {
      num = mantissaField | (1n << 52n)
      e2 = expField - 1075
    }
    num *= sign
    if (e2 >= 0) {
      return new Rational(num << BigInt(e2), 1n)
    }
    return new Rational(num, 1n << BigInt(-e2))
  }

  /** True when the value is a safe integer (cheap common path). */
  static from(value: number | bigint | Rational): Rational {
    if (value instanceof Rational) return value
    if (typeof value === 'bigint') return Rational.of(value)
    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      return Rational.of(value)
    }
    return Rational.fromFloat(value)
  }

  add(o: Rational): Rational {
    return new Rational(this.num * o.den + o.num * this.den, this.den * o.den)
  }

  sub(o: Rational): Rational {
    return new Rational(this.num * o.den - o.num * this.den, this.den * o.den)
  }

  mul(o: Rational): Rational {
    return new Rational(this.num * o.num, this.den * o.den)
  }

  div(o: Rational): Rational {
    if (o.num === 0n) throw new Error('Rational: division by zero')
    return new Rational(this.num * o.den, this.den * o.num)
  }

  neg(): Rational {
    return new Rational(-this.num, this.den)
  }

  cmp(o: Rational): number {
    const d = this.num * o.den - o.num * this.den
    return d < 0n ? -1 : d > 0n ? 1 : 0
  }

  lt(o: Rational): boolean {
    return this.cmp(o) < 0
  }
  le(o: Rational): boolean {
    return this.cmp(o) <= 0
  }
  gt(o: Rational): boolean {
    return this.cmp(o) > 0
  }
  ge(o: Rational): boolean {
    return this.cmp(o) >= 0
  }
  eq(o: Rational): boolean {
    return this.num === o.num && this.den === o.den
  }

  /** float(self) — nearest double; fine for seconds/DOM geometry. */
  toNumber(): number {
    return Number(this.num) / Number(this.den)
  }

  toString(): string {
    return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`
  }
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a
  let y = b
  while (y !== 0n) {
    const t = y
    y = x % y
    x = t
  }
  return x === 0n ? 1n : x
}
