import { useTheme } from '../../context/ThemeContext';

/** CPLM-aligned form field label wrapper (ModelChange / DataEntry pattern). */
export default function FormField({ label, children, style }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
      {label && (
        <label style={{ color: t.textDim, fontSize: 11, fontWeight: 500 }}>{label}</label>
      )}
      {children}
    </div>
  );
}
