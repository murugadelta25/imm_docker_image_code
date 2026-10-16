/** Collect production lines from factory config for machine location dropdowns. */
export function getFactoryLines(config) {
  const lines = [];
  for (const factory of config?.factory?.factories || []) {
    for (const dept of factory.departments || []) {
      for (const line of dept.lines || []) {
        if (!line.name) continue;
        const label = [factory.name, dept.name, line.name].filter(Boolean).join(' / ');
        lines.push({
          id: line.id,
          name: line.name,
          label,
          factoryId: factory.id,
          deptId: dept.id,
        });
      }
    }
  }
  return lines;
}
