// ============================================================================
// Splash — tela de carregamento centralizada com a logo do Agente DT.
// Mostrada enquanto o UnitContext faz o primeiro fetch das units.
// ============================================================================

const LOGO_URL = 'https://i.postimg.cc/9fkz8kVx/DESIGN-(1).png';

export function Splash() {
  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 gap-6">
      <img
        src={LOGO_URL}
        alt="Agente DT"
        className="w-48 h-48 object-contain animate-pulse drop-shadow-[0_0_30px_rgba(124,77,255,0.35)]"
      />
      <div className="text-xs uppercase tracking-[0.3em] text-zinc-500 font-display">
        Carregando…
      </div>
    </div>
  );
}
