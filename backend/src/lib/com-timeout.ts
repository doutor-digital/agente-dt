/** Rejeita se a promessa não responder em `ms` (e limpa o relógio nos dois desfechos). Sem dependências: qualquer módulo pode usar. */
export function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout de ${ms} ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
