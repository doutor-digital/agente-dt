// ============================================================================
// LoginArt — ilustração vetorial da tela de login.
// Conceito: a Sofia (agente de IA no WhatsApp) conversa e alimenta o funil do
// Kommo CRM, sob a marca Doutor Digital. Vetor (SVG), tema verde/escuro.
// ============================================================================

const G = '#2EE686'; // verde primário
const GD = '#17a866'; // verde profundo
const CARD = '#241f31';
const LINE = '#46405a';

export function LoginArt({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 500 440"
      className={className}
      role="img"
      aria-label="Agente de IA da Doutor Digital conectado ao Kommo CRM"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="glow" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor={G} stopOpacity="0.18" />
          <stop offset="100%" stopColor={G} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="btn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={G} />
          <stop offset="100%" stopColor={GD} />
        </linearGradient>
      </defs>

      {/* brilho de fundo */}
      <ellipse cx="250" cy="205" rx="240" ry="200" fill="url(#glow)" />
      {/* chão */}
      <ellipse cx="250" cy="392" rx="180" ry="20" fill={G} opacity="0.06" />

      {/* ── fluxo de automação: IA → funil ─────────────────────────────── */}
      <path
        d="M205 175 C 270 150, 300 150, 335 168"
        stroke={G}
        strokeWidth="2"
        strokeDasharray="4 7"
        strokeLinecap="round"
        opacity="0.6"
      />
      <circle cx="335" cy="168" r="3.5" fill={G} />
      <circle cx="205" cy="175" r="3.5" fill={G} />

      {/* ── Kommo CRM: funil de leads (cards empilhados) ───────────────── */}
      <g>
        {[
          { y: 150, w: 150, label: 'Lead novo' },
          { y: 202, w: 128, label: 'Qualificado' },
          { y: 254, w: 106, label: 'Avaliação' },
        ].map((c, i) => (
          <g key={i} transform={`translate(${330 + (150 - c.w) / 2}, ${c.y})`}>
            <rect width={c.w} height="40" rx="9" fill={CARD} stroke={LINE} />
            <circle cx="21" cy="20" r="10" fill={G} opacity={0.9 - i * 0.18} />
            <rect x="38" y="12" width={c.w - 54} height="6" rx="3" fill="#4a4360" />
            <rect x="38" y="24" width={c.w - 78} height="5" rx="2.5" fill="#3a3450" />
          </g>
        ))}
        {/* setas do funil */}
        <path d="M405 192 l0 8 m-4 -4 l4 4 l4 -4" stroke={G} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
        <path d="M405 244 l0 8 m-4 -4 l4 4 l4 -4" stroke={G} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
        <text x="405" y="316" textAnchor="middle" fontFamily="PT Sans, Arial" fontSize="13" fill={G} opacity="0.85" fontWeight="700">
          Kommo CRM
        </text>
      </g>

      {/* ── Sofia: avatar do agente de IA (fone de atendimento) ────────── */}
      <g>
        {/* antena */}
        <line x1="120" y1="96" x2="120" y2="112" stroke={G} strokeWidth="3" strokeLinecap="round" />
        <circle cx="120" cy="90" r="6" fill={G} />
        {/* cabeça */}
        <rect x="58" y="112" width="124" height="112" rx="26" fill={CARD} stroke={G} strokeWidth="2.5" />
        {/* tela do rosto */}
        <rect x="74" y="128" width="92" height="66" rx="16" fill="#1b1725" stroke={LINE} />
        {/* olhos */}
        <circle cx="103" cy="160" r="8" fill={G} />
        <circle cx="137" cy="160" r="8" fill={G} />
        {/* sorriso */}
        <path d="M104 178 q16 12 32 0" stroke={G} strokeWidth="2.5" strokeLinecap="round" />
        {/* fone / headset de atendimento */}
        <path d="M52 168 a68 68 0 0 1 136 0" stroke={G} strokeWidth="3" fill="none" strokeLinecap="round" />
        <rect x="46" y="162" width="14" height="26" rx="6" fill={G} />
        <rect x="180" y="162" width="14" height="26" rx="6" fill={G} />
        {/* microfone */}
        <path d="M186 186 q6 22 -22 30" stroke={G} strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <circle cx="163" cy="218" r="4.5" fill={G} />
      </g>

      {/* ── bolhas de conversa (WhatsApp) ──────────────────────────────── */}
      <g>
        <path d="M196 108 h58 a12 12 0 0 1 12 12 v22 a12 12 0 0 1 -12 12 h-42 l-12 11 v-11 a12 12 0 0 1 -4 -9 v-25 a12 12 0 0 1 0 -12 z"
          fill={CARD} stroke={G} strokeWidth="2" transform="translate(0,0)" />
        <circle cx="216" cy="131" r="3" fill={G} />
        <circle cx="228" cy="131" r="3" fill={G} />
        <circle cx="240" cy="131" r="3" fill={G} />
      </g>

      {/* ── marca Doutor Digital (badge com a logo real) ───────────────── */}
      <g transform="translate(96, 300)">
        <rect x="-8" y="-8" width="64" height="64" rx="16" fill={CARD} stroke={LINE} />
        <image href="/logo-dd.png" x="2" y="2" width="44" height="44" />
      </g>
      <text x="176" y="332" fontFamily="PT Sans, Arial" fontSize="15" fill="#e8e6ef" fontWeight="700">
        Doutor Digital
      </text>
      <text x="176" y="352" fontFamily="PT Sans, Arial" fontSize="12" fill="#8a83a0">
        Agente de IA · Sofia
      </text>
    </svg>
  );
}
