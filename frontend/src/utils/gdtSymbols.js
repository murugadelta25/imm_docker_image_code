/** Engineering / GD&T symbols for specification entry (Process Control Sheet). */

export const SPEC_SYMBOL_GROUPS = [
  {
    label: 'Common',
    symbols: [
      { char: '±', name: 'Plus-minus' },
      { char: '°', name: 'Degree' },
      { char: '⌀', name: 'Diameter' },
      { char: 'Ø', name: 'Diameter (alt)' },
      { char: '×', name: 'Multiply / chamfer' },
      { char: 'µ', name: 'Micro' },
      { char: '²', name: 'Squared' },
      { char: '³', name: 'Cubed' },
    ],
  },
  {
    label: 'GD&T',
    symbols: [
      { char: '─', name: 'Straightness' },
      { char: '▭', name: 'Flatness' },
      { char: '○', name: 'Circularity' },
      { char: '⌭', name: 'Cylindricity' },
      { char: '⌒', name: 'Profile of a line' },
      { char: '⌓', name: 'Profile of a surface' },
      { char: '∠', name: 'Angularity' },
      { char: '⊥', name: 'Perpendicularity' },
      { char: '∥', name: 'Parallelism' },
      { char: '⊕', name: 'Position' },
      { char: '◎', name: 'Concentricity' },
      { char: '≡', name: 'Symmetry' },
      { char: '↗', name: 'Circular runout' },
      { char: '⇉', name: 'Total runout' },
    ],
  },
  {
    label: 'Frame / tolerance',
    symbols: [
      { char: '|', name: 'Frame separator' },
      { char: '〈', name: 'Left angle bracket' },
      { char: '〉', name: 'Right angle bracket' },
      { char: '≤', name: 'Less or equal' },
      { char: '≥', name: 'Greater or equal' },
      { char: '+', name: 'Plus tolerance' },
      { char: '−', name: 'Minus (en dash style)' },
      { char: '/', name: 'Limit separator' },
    ],
  },
];

export const SPEC_SYMBOL_SNIPPETS = [
  { label: '± tol', insert: '± ' },
  { label: '⌀ dia', insert: '⌀' },
  { label: 'CH ×°', insert: 'CH  × 45°' },
  { label: '≡ frame', insert: '≡ |  | A' },
  { label: '⊥ frame', insert: '⊥ |  | A' },
  { label: '⊕ frame', insert: '⊕ |  | A' },
];
