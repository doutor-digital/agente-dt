// ============================================================================
// BloquearIcon — o sinal de proibido da ação de bloquear horário.
//
// Desenhado em SVG em vez de importado como PNG por dois motivos práticos:
// escala sem borrar em qualquer tamanho (o mesmo ícone aparece a 12px na lista
// e a 20px no botão) e acompanha o tema — as cores são props, então ele pode
// ficar acinzentado quando o botão está desabilitado sem virar outro arquivo.
//
// A construção é em camadas, de fora pra dentro: anel escuro, anel vermelho,
// miolo claro e a barra diagonal — desenhada duas vezes, a de baixo mais
// grossa e escura, o que produz o contorno sem precisar de filtro.
// ============================================================================

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
      {/* anel externo: vermelho com contorno escuro */}
      <circle cx="256" cy="256" r="212" fill={color} stroke={outline} strokeWidth="40" />
      {/* miolo claro */}
      <circle cx="256" cy="256" r="134" fill={inner} stroke={outline} strokeWidth="34" />
      {/* barra diagonal — escura embaixo faz o contorno */}
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
