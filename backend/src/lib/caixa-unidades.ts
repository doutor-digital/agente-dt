/** As unidades em que o Caixa pode CRIAR link de pagamento (CAIXA_LINK_UNIDADES). Só a criação depende disto: o status e o aviso de pagamento de links já enviados seguem valendo mesmo se a unidade sair da lista. */

/** Slugs separados por vírgula, em minúsculas, sem coringa. Vazio ou ausente = nenhum; "*" e "todas" não valem. */
export function listaDeUnidades(bruto: string | undefined): Set<string> {
  return new Set(
    (bruto ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !s.includes('*') && s !== 'todas'),
  );
}

/** Slugs com a CRIAÇÃO de link do Caixa ligada (a criação ainda exige INFINITEPAY_ESCRITA_UNIDADES). Vazio = desligada em todas. */
export function unidadesComLinkDoCaixa(e: NodeJS.ProcessEnv = process.env): Set<string> {
  return listaDeUnidades(e.CAIXA_LINK_UNIDADES);
}
