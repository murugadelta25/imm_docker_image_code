import { useTheme } from '../context/ThemeContext';

/**
 * IMM dashboard page title + factory/zone/equipment breadcrumb.
 * (Refresh / 5-sec / clock controls removed — PageHeader owns those.)
 */
export default function ImmDashboardSelector({
  mode = 'factory',
  factoryName = '',
  factories = [],
  selectedFactoryId,
  onFactoryChange,
  zoneName = '',
  zones = [],
  selectedZoneId,
  onZoneChange,
  equipmentName = '',
  equipmentList = [],
  selectedEquipmentId,
  onEquipmentChange,
}) {
  const { theme: t } = useTheme();

  const title =
    mode === 'factory' ? 'Factory Dashboard'
      : mode === 'zone' ? 'Zone Dashboard'
        : mode === 'equipment' ? 'Equipment Dashboard'
          : 'IMM Dashboard';

  const s = {
    left: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    },
    title: {
      color: t.titleColor || t.text,
      fontSize: 18,
      fontWeight: 800,
      margin: 0,
      whiteSpace: 'nowrap',
    },
    crumb: { color: t.textMuted, fontSize: 13, fontWeight: 600 },
    select: {
      background: t.surface2,
      border: `1px solid ${t.border}`,
      color: t.accent,
      borderRadius: 8,
      padding: '6px 10px',
      fontWeight: 700,
      fontSize: 13,
      cursor: 'pointer',
      maxWidth: 220,
    },
  };

  const showFactoryPick = factories.length > 1 && typeof onFactoryChange === 'function';
  const showZonePick = mode === 'zone' && zones.length > 0 && typeof onZoneChange === 'function';
  const showEquipPick = mode === 'equipment' && equipmentList.length > 0 && typeof onEquipmentChange === 'function';

  return (
    <div style={s.left}>
      <span style={s.title}>{title}</span>

      {showFactoryPick ? (
        <select
          style={s.select}
          value={selectedFactoryId || ''}
          onChange={(e) => onFactoryChange(e.target.value)}
          aria-label="Factory"
        >
          {factories.map((f) => (
            <option key={f.id} value={f.id}>{f.name || f.id}</option>
          ))}
        </select>
      ) : (
        factoryName ? <span style={s.crumb}>{factoryName}</span> : null
      )}

      {(mode === 'zone' || mode === 'equipment') && (showZonePick || zoneName) && (
        <>
          {(factoryName || showFactoryPick) ? <span style={s.crumb}>/</span> : null}
          {showZonePick ? (
            <select
              style={s.select}
              value={selectedZoneId || ''}
              onChange={(e) => onZoneChange(e.target.value)}
              aria-label="Zone"
            >
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name || z.id}</option>
              ))}
            </select>
          ) : (
            <span style={s.crumb}>{zoneName}</span>
          )}
        </>
      )}

      {mode === 'equipment' && (showEquipPick || equipmentName) && (
        <>
          {(zoneName || showZonePick || factoryName || showFactoryPick) ? <span style={s.crumb}>/</span> : null}
          {showEquipPick ? (
            <select
              style={s.select}
              value={String(selectedEquipmentId || '')}
              onChange={(e) => onEquipmentChange(e.target.value)}
              aria-label="Equipment"
            >
              {!selectedEquipmentId && <option value="">Select equipment…</option>}
              {equipmentList.map((eq) => (
                <option key={eq.id} value={eq.id}>{eq.name || eq.id}</option>
              ))}
            </select>
          ) : (
            <span style={s.crumb}>{equipmentName}</span>
          )}
        </>
      )}
    </div>
  );
}
