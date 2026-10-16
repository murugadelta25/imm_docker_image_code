import { useId } from 'react';

/**
 * CPLM LogoIcon — from cplm-web-ui src/assets/icons/Logo.svg
 * @param {{ size?: number, className?: string }} props
 */
export default function LogoIcon({ size = 32, className }) {
  const uid = useId().replace(/:/g, '');
  const g = (n) => `logo-${uid}-${n}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 44 44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M7.91992 17.6006L21.9999 21.7806L36.0799 17.6006V26.4006L21.9999 22.2206L7.91992 26.4006V17.6006Z"
        fill={`url(#${g('paint0')})`}
      />
      <path
        d="M4.83984 31.0205L21.8443 21.8449L31.0198 4.84051L39.3798 12.7605L22.1554 22.1561L12.9798 39.1605L4.83984 31.0205Z"
        fill={`url(#${g('paint1')})`}
      />
      <path
        d="M12.9805 4.83984L22.1561 21.8443L39.1605 31.0198L31.0205 39.1598L21.8449 22.1554L4.84047 12.9798L12.9805 4.83984Z"
        fill={`url(#${g('paint2')})`}
      />
      <path
        d="M26.4004 14.5205L22.2204 22.0005L26.4004 29.4805L17.6004 29.4805L21.7804 22.0005L17.6004 14.5205L26.4004 14.5205Z"
        fill={`url(#${g('paint3')})`}
      />
      <rect y="17.5996" width="8.8" height="8.8" rx="1.1" fill="#00ADEF" />
      <rect x="4.40039" y="4.40039" width="8.8" height="8.8" rx="1.1" fill="#B9EB5F" />
      <rect x="17.5996" y="6.59961" width="8.8" height="8.8" rx="1.1" fill="#64D7D7" />
      <rect x="17.5996" y="28.5996" width="8.8" height="8.8" rx="1.1" fill="#64D7D7" />
      <rect x="4.40039" y="30.7998" width="8.8" height="8.8" rx="1.1" fill="#B9EB5F" />
      <rect x="35.1992" y="17.5996" width="8.8" height="8.8" rx="1.1" fill="#00ADEF" />
      <rect x="30.8008" y="30.7998" width="8.8" height="8.8" rx="1.1" fill="#B9EB5F" />
      <rect x="30.8008" y="4.40039" width="8.8" height="8.8" rx="1.1" fill="#B9EB5F" />
      <defs>
        <linearGradient id={g('paint0')} x1="7.91992" y1="22.0006" x2="36.0799" y2="22.0006" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00ADEF" stopOpacity="0.6" />
          <stop offset="0.5" stopColor="#00ADEF" stopOpacity="0" />
          <stop offset="1" stopColor="#00ADEF" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id={g('paint1')} x1="12.0438" y1="31.9566" x2="31.9559" y2="12.0444" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B9EB5F" stopOpacity="0.6" />
          <stop offset="0.5" stopColor="#B9EB5F" stopOpacity="0" />
          <stop offset="1" stopColor="#B9EB5F" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id={g('paint2')} x1="12.0444" y1="12.0438" x2="31.9565" y2="31.9559" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B9EB5F" stopOpacity="0.6" />
          <stop offset="0.5" stopColor="#B9EB5F" stopOpacity="0" />
          <stop offset="1" stopColor="#B9EB5F" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id={g('paint3')} x1="22.0004" y1="14.5205" x2="22.0004" y2="29.4805" gradientUnits="userSpaceOnUse">
          <stop stopColor="#64D7D7" stopOpacity="0.6" />
          <stop offset="0.5" stopColor="#64D7D7" stopOpacity="0" />
          <stop offset="1" stopColor="#64D7D7" stopOpacity="0.6" />
        </linearGradient>
      </defs>
    </svg>
  );
}
