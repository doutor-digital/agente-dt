/** `BancoConvites` em memória, só para teste (mesma regra atômica do banco de verdade: o envio só vale se o convite ainda está aberto). */
import type { BancoConvites, ConviteListado } from './convites.js';
import type { RespostasFormulario } from './formulario.js';

interface Linha extends ConviteListado {
  codigoHash: string;
  respostas: RespostasFormulario | null;
}

export function bancoConvitesFalso(): BancoConvites & { linhas: Linha[] } {
  const linhas: Linha[] = [];
  let n = 0;
  return {
    linhas,
    async criar(d) {
      const id = `c${String(++n).padStart(4, '0')}abcdefgh`;
      linhas.push({ id, codigoHash: d.codigoHash, rotulo: d.rotulo, criadoPor: d.criadoPor, criadoEm: new Date(), expiraEm: d.expiraEm, enviadoEm: null, importadoEm: null, slugSugerido: null, respostas: null });
      return { id };
    },
    async achar(codigoHash) {
      const l = linhas.find((x) => x.codigoHash === codigoHash);
      return l ? { id: l.id, expiraEm: l.expiraEm, enviadoEm: l.enviadoEm } : null;
    },
    async enviar(d) {
      const l = linhas.find((x) => x.codigoHash === d.codigoHash);
      if (!l || l.enviadoEm || l.expiraEm.getTime() <= d.agora.getTime()) return null;
      l.enviadoEm = d.agora;
      l.respostas = d.respostas;
      l.slugSugerido = d.slugSugerido;
      return { id: l.id };
    },
    async listar() {
      return [...linhas].reverse();
    },
    async revogar(id, agora) {
      const l = linhas.find((x) => x.id === id);
      if (!l || l.enviadoEm || l.expiraEm.getTime() <= agora.getTime()) return false;
      l.expiraEm = agora;
      return true;
    },
  };
}
