/**
 * Listas que o conector relê do banco de tempos em tempos (quem pode o quê), e a espera da PRIMEIRA carga.
 *
 *  - `manterAtualizado`: carrega, aplica, reagenda. Cada carga tem LIMITE DE TEMPO: um banco pendurado não pode impedir a nova tentativa de ser agendada
 *    (antes, `carregar()` que nunca respondia deixava a lista vazia para sempre).
 *  - `esperaDaPrimeiraCarga`: o que cada pedido espera antes de montar as ferramentas. Espera no máximo `limiteMs` UMA vez; depois da 1ª espera (acabou o
 *    prazo ou as cargas terminaram) marca «pronto» e nunca mais espera — pedido nenhum fica preso atrás de banco lento.
 */
export interface OpcoesDaManutencao {
  /** quanto uma carga pode demorar antes de contar como falha */
  limiteMs?: number;
  /** depois de falhar */
  tentarDeNovoMs?: number;
  /** depois de dar certo */
  renovarMs?: number;
  log?: { warn(o: object, m?: string): void };
}

export const comLimiteDeTempo = <T>(p: Promise<T>, ms: number, nome: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${nome}: a carga passou de ${ms} ms`)), ms);
    t.unref?.();
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

export function manterAtualizado<T>(carregar: () => Promise<T>, aplicar: (v: T) => void, nome: string, o: OpcoesDaManutencao = {}): Promise<void> {
  const { limiteMs = 20_000, tentarDeNovoMs = 30_000, renovarMs = 10 * 60_000 } = o;
  let primeira: () => void = () => undefined;
  const aPrimeiraCarga = new Promise<void>((r) => (primeira = r));
  const rodar = () => {
    let p: Promise<T>;
    try {
      p = comLimiteDeTempo(carregar(), limiteMs, nome);
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then((v) => {
      aplicar(v);
      primeira();
      setTimeout(rodar, renovarMs).unref();
    }).catch((err) => {
      o.log?.warn({ err }, `mcp-remoto: não consegui ler ${nome}; tento de novo`);
      primeira(); // a tentativa terminou (falhando ou estourando o tempo): quem espera não fica preso
      setTimeout(rodar, tentarDeNovoMs).unref();
    });
  };
  rodar();
  return aPrimeiraCarga;
}

export function esperaDaPrimeiraCarga(cargas: Array<Promise<unknown>>, limiteMs = 3000): () => Promise<void> {
  let pronto = false;
  let emCurso: Promise<void> | null = null;
  return () => {
    if (pronto) return Promise.resolve();
    emCurso ??= Promise.race([Promise.all(cargas), new Promise((r) => setTimeout(r, limiteMs).unref())]).then(() => {
      pronto = true;
    });
    return emCurso;
  };
}
