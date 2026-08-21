export function BloquearIcon({
  size = 16,
  className = '',
  color = '#F2496E',
  outline = '#332F2F',
  inner = '#FFFFFF',
}: {
  size?: number | string;
  className?: string;
  color?: string;
  outline?: string;
  inner?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="256" cy="256" r="212" fill={color} stroke={outline} strokeWidth="40" />
      <circle cx="256" cy="256" r="134" fill={inner} stroke={outline} strokeWidth="34" />
      <path
        d="M158 354 354 158"
        stroke={outline}
        strokeWidth="112"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M158 354 354 158"
        stroke={color}
        strokeWidth="74"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
