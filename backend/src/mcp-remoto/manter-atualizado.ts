/**
 * Listas que o conector relê do banco de tempos em tempos (quem pode o quê), e a espera da PRIMEIRA carga.
 *
 *  - `manterAtualizado`: carrega, aplica, reagenda — com UMA consulta em curso por lista: a próxima só é agendada quando a anterior TERMINA (banco travado não
 *    empilha consultas presas no pool do Prisma). O limite de tempo só libera quem espera a 1ª carga.
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

export function manterAtualizado<T>(carregar: () => Promise<T>, aplicar: (v: T) => void, nome: string, o: OpcoesDaManutencao = {}): Promise<void> {
  const { limiteMs = 20_000, tentarDeNovoMs = 30_000, renovarMs = 10 * 60_000 } = o;
  let primeira: () => void = () => undefined;
  const aPrimeiraCarga = new Promise<void>((r) => (primeira = r));
  /**
   * UMA consulta em curso por lista, sempre. O limite de tempo só LIBERA quem espera (a 1ª carga); a consulta antiga continua valendo — se terminar tarde,
   * aplica — e a próxima só é agendada QUANDO ELA ACABAR. Com o banco travado, nada empilha consulta presa no pool do Prisma que a Sofia e os workers dividem.
   */
  let emCurso = false;
  const rodar = () => {
    if (emCurso) return;
    emCurso = true;
    let liberou = false;
    const liberar = () => {
      if (!liberou) {
        liberou = true;
        primeira();
      }
    };
    const limite = setTimeout(() => {
      o.log?.warn({ nome, limiteMs }, `mcp-remoto: ${nome}: a carga passou de ${limiteMs} ms; sigo sem esperar e só consulto de novo quando ela acabar`);
      liberar();
    }, limiteMs);
    limite.unref();
    let p: Promise<T>;
    try {
      p = carregar();
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (v) => {
        clearTimeout(limite);
        emCurso = false;
        aplicar(v);
        liberar();
        setTimeout(rodar, renovarMs).unref();
      },
      (err) => {
        clearTimeout(limite);
        emCurso = false;
        o.log?.warn({ err }, `mcp-remoto: não consegui ler ${nome}; tento de novo`);
        liberar();
        setTimeout(rodar, tentarDeNovoMs).unref();
      },
    );
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
