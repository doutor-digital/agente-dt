/**
 * A URL que vai para o log de debug do servidor, sem o que é segredo no endereço: o token do cofre de arquivos, o código do formulário «nova clínica»
 * (`/nova-clinica/<codigo>` e `/api/public/nova-clinica/<codigo>`) e as chaves em `?k=` / `?access_token=`.
 */
export function mascararUrlDoLog(url: string): string {
  return url
    .replace(/^(\/arquivos\/(?:enviar|baixar)\/)[^/?]+/, '$1[token]')
    .replace(/^(\/infinitepay\/webhook\/[^/?]+\/[^/?]+\/)[^/?]+/, '$1[assinatura]')
    .replace(/^(\/focus-nfe\/webhook\/[^/?]+\/)[^/?]+/, '$1[assinatura]')
    .replace(/(\/nova-clinica\/)[^/?#\s]+/, '$1[codigo]')
    .replace(/([?&]k=)[^&]+/, '$1[chave]')
    .replace(/([?&]access_token=)[^&]+/, '$1[chave]');
}
