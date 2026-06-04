export interface ColorResult {
  hex: string
  rgb: { r: number; g: number; b: number; a: number }
  hsl: { h: number; s: number; l: number; a: number }
  rgbString: string
  hslString: string
}

/**
 * ColorService — the no-shell color converter for frontend work: hand it a
 * color in any common notation (hex #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba(),
 * or hsl()/hsla()) and get it back in every format at once. Pure, synchronous,
 * stateless. Saves a round-trip to a browser devtools color picker when Claude
 * is tweaking a stylesheet.
 */
export class ColorService {
  /** Parse any supported color notation and return it in hex, rgb, and hsl. */
  convert(input: string): ColorResult {
    const s = input.trim()
    let rgba: { r: number; g: number; b: number; a: number }
    if (s.startsWith("#")) {
      rgba = this.parseHex(s)
    } else if (/^rgba?\(/i.test(s)) {
      rgba = this.parseRgb(s)
    } else if (/^hsla?\(/i.test(s)) {
      rgba = this.parseHsl(s)
    } else {
      throw new Error(`Unrecognized color: '${input}' (expected hex, rgb(), or hsl())`)
    }
    const hsl = this.rgbToHsl(rgba.r, rgba.g, rgba.b)
    return {
      hex: this.toHex(rgba),
      rgb: rgba,
      hsl: { ...hsl, a: rgba.a },
      rgbString:
        rgba.a < 1
          ? `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${this.fmtAlpha(rgba.a)})`
          : `rgb(${rgba.r}, ${rgba.g}, ${rgba.b})`,
      hslString:
        rgba.a < 1
          ? `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${this.fmtAlpha(rgba.a)})`
          : `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
    }
  }

  private parseHex(s: string): { r: number; g: number; b: number; a: number } {
    let h = s.slice(1)
    if (h.length === 3 || h.length === 4) {
      h = [...h].map((c) => c + c).join("")
    }
    if (h.length !== 6 && h.length !== 8) {
      throw new Error(`Invalid hex color: '${s}'`)
    }
    if (!/^[0-9a-fA-F]+$/.test(h)) throw new Error(`Invalid hex color: '${s}'`)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? this.round(parseInt(h.slice(6, 8), 16) / 255, 3) : 1,
    }
  }

  private parseRgb(s: string): { r: number; g: number; b: number; a: number } {
    const nums = this.numbers(s)
    if (nums.length < 3) throw new Error(`Invalid rgb color: '${s}'`)
    return {
      r: this.clampByte(nums[0]),
      g: this.clampByte(nums[1]),
      b: this.clampByte(nums[2]),
      a: nums.length >= 4 ? this.clampUnit(nums[3]) : 1,
    }
  }

  private parseHsl(s: string): { r: number; g: number; b: number; a: number } {
    const nums = this.numbers(s)
    if (nums.length < 3) throw new Error(`Invalid hsl color: '${s}'`)
    const h = ((nums[0] % 360) + 360) % 360
    const sat = this.clampPct(nums[1]) / 100
    const lig = this.clampPct(nums[2]) / 100
    const rgb = this.hslToRgb(h, sat, lig)
    return { ...rgb, a: nums.length >= 4 ? this.clampUnit(nums[3]) : 1 }
  }

  private rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const l = (max + min) / 2
    let h = 0
    let s = 0
    if (max !== min) {
      const d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      switch (max) {
        case rn:
          h = (gn - bn) / d + (gn < bn ? 6 : 0)
          break
        case gn:
          h = (bn - rn) / d + 2
          break
        default:
          h = (rn - gn) / d + 4
      }
      h /= 6
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
  }

  private hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    const hue = h / 360
    if (s === 0) {
      const v = Math.round(l * 255)
      return { r: v, g: v, b: v }
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    return {
      r: Math.round(this.hueToRgb(p, q, hue + 1 / 3) * 255),
      g: Math.round(this.hueToRgb(p, q, hue) * 255),
      b: Math.round(this.hueToRgb(p, q, hue - 1 / 3) * 255),
    }
  }

  private hueToRgb(p: number, q: number, t: number): number {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }

  private toHex(rgba: { r: number; g: number; b: number; a: number }): string {
    const h = (n: number) => n.toString(16).padStart(2, "0")
    const base = `#${h(rgba.r)}${h(rgba.g)}${h(rgba.b)}`
    return rgba.a < 1 ? base + h(Math.round(rgba.a * 255)) : base
  }

  /** Pull all numeric tokens out of a functional-notation color string. */
  private numbers(s: string): number[] {
    return (s.match(/-?\d*\.?\d+/g) ?? []).map(Number)
  }

  private clampByte(n: number): number {
    return Math.max(0, Math.min(255, Math.round(n)))
  }

  private clampPct(n: number): number {
    return Math.max(0, Math.min(100, n))
  }

  private clampUnit(n: number): number {
    return this.round(Math.max(0, Math.min(1, n)), 3)
  }

  private fmtAlpha(a: number): string {
    return String(this.round(a, 3))
  }

  private round(n: number, places: number): number {
    const f = 10 ** places
    return Math.round(n * f) / f
  }
}
