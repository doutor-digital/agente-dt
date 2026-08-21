export function Splash() {
  return (
    <div className="h-screen w-screen relative flex flex-col items-center justify-center gap-6 bg-zinc-950 text-zinc-100 overflow-hidden">
      <div className="absolute inset-0 grid-mesh opacity-60 pointer-events-none" />
      <div
        className="absolute inset-x-0 top-0 h-[380px] pointer-events-none"
        style={{
          background:
            'radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--b-500) 14%, transparent), transparent 70%)',
        }}
      />

      <div className="relative flex flex-col items-center gap-5">
        <img
          src="/logo-dd.png"
          alt="Doutor Digital"
          className="w-16 h-16 object-contain rounded-2xl ring-1 ring-zinc-800 bg-zinc-900 p-2"
        />
        <div className="text-center">
          <div className="text-sm font-semibold tracking-tight text-zinc-100">Agente DT</div>
          <div className="text-[11px] text-zinc-500 mt-0.5">Preparando seu console…</div>
        </div>

        <div className="w-40 h-[3px] rounded-full bg-zinc-800 overflow-hidden">
          <div className="h-full w-full animate-sheen" />
        </div>
      </div>
    </div>
  );
}
