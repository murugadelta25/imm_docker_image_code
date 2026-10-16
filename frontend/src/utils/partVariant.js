/** Part number / variant label for production planning and data entry. */

export function partToPlanningVariant(part) {
  if (!part) return '';
  return (part.part_no || part.model_variant || '').trim();
}

/** Map stored plan.model_variant to canonical part number when possible. */
export function resolvePlanningVariant(modelVariant, parts = []) {
  const mv = (modelVariant || '').trim();
  if (!mv) return '';

  const byPartNo = parts.find((p) => (p.part_no || '').trim() === mv);
  if (byPartNo?.part_no) return byPartNo.part_no.trim();

  const byVariant = parts.find((p) => (p.model_variant || '').trim() === mv);
  if (byVariant?.part_no) return byVariant.part_no.trim();

  return mv;
}

export function planModelVariant(plan, parts = []) {
  return resolvePlanningVariant(plan?.model_variant, parts);
}
