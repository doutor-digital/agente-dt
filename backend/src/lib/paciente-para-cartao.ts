/**
 * A PESSOA da franquia espelhada no cartão do Kommo.
 *
 * O sincronizador já trazia a *consulta* — data, situação, categoria, fisioterapeuta.
 * Não trazia nada sobre a *pessoa*, e o Kommo tinha os campos criados e vazios esperando:
 * `⚥ Sexo` em 21%, `◷ Data de nascimento`, `⌂ Estado`, `⚑ Origem na franquia` e
 * `✓ Status do paciente` em **zero**.
 *
 * Decisão do João (26/09/2026), e é a única exceção à regra de nunca sobrescrever:
 * **em sexo e nascimento, a franquia ganha do que estiver no cartão.** Esses dois são
 * cadastro conferido com o paciente na frente; o que estava lá era dedução da IA ou da
 * lista de nomes. Nos outros campos vale a regra de sempre — só preenche o que está vazio.
 *
 * `## ENDEREÇO` do cartão é SEPARADOR visual (o `##` no nome é a marca), não campo —
 * escrever ali escreveria no título do bloco. O endereço vai para `⌂ Endereço`, que o
 * instalador cria onde não existir. E-mail mora na entidade CONTATO, não no lead: é outro
 * caminho de escrita e não entra aqui.
 *
 * Idade É gravada (decisão do João, 26/09) — a recepção quer ler a idade na tela, não uma
 * data. O problema de gravar idade é que ela envelhece sozinha: quem tem 45 hoje some com
 * 46 no aniversário e o cartão continua dizendo 45.
 *
 * A saída é `idadeADesencalhar`: a cada passagem do sincronizador a idade é recalculada a
 * partir da DATA que já está no cartão, e corrigida se divergir. Isso não custa chamada à
 * franquia nenhuma — o dado já está ali. Por isso a data também é gravada, mesmo sendo a
 * idade o que aparece no dia a dia.
 */

export interface FichaDaFranquia {
  gender?: string | null;
  birthdate?: string | null;
  addressNumber?: string | null;
  addressCity?: string | null;
  addressUf?: string | null;
  address?: string | null;
  email?: string | null;
  source?: string | null;
  status?: string | null;
}

export interface EscritaDoPaciente {
  /** Nome do campo no Kommo, como ele aparece na conta. */
  campo: string;
  tipo: 'text' | 'textarea' | 'select' | 'date' | 'numeric';
  valor: string | number;
  motivo: string;
  /** Pode passar por cima de um valor que já existe? Só sexo e nascimento podem. */
  sobrescreve: boolean;
}

/** A franquia escreve "M", "F", "Masculino", "feminino"… Normaliza para o que o Kommo aceita. */
export function sexoDaFranquia(bruto: string | null | undefined): 'Feminino' | 'Masculino' | null {
  const s = String(bruto ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'f' || s.startsWith('fem') || s.startsWith('mulher')) return 'Feminino';
  if (s === 'm' || s.startsWith('mas') || s.startsWith('homem')) return 'Masculino';
  return null; // "outro", "não informado" ou lixo: melhor vazio que errado
}

/**
 * Data de nascimento em epoch (segundos), que é o que o campo `date` do Kommo quer.
 * Aceita ISO e dd/mm/aaaa, que é como a franquia alterna.
 */
export function nascimentoEmEpoch(bruto: string | null | undefined): number | null {
  const s = String(bruto ?? '').trim();
  if (!s) return null;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : s.slice(0, 10);
  const d = new Date(`${iso}T12:00:00Z`); // meio-dia evita o campo virar o dia anterior por fuso
  if (Number.isNaN(d.getTime())) return null;
  const ano = d.getUTCFullYear();
  // Uma data de nascimento fora desta faixa é erro de digitação, não paciente.
  if (ano < 1900 || ano > new Date().getUTCFullYear()) return null;
  return Math.floor(d.getTime() / 1000);
}

/** Idade hoje, a partir da data de nascimento. Calculada na hora — nunca gravada. */
export function idadeHoje(epochNascimento: number | null, agora = new Date()): number | null {
  if (!epochNascimento) return null;
  const n = new Date(epochNascimento * 1000);
  let anos = agora.getUTCFullYear() - n.getUTCFullYear();
  const mes = agora.getUTCMonth() - n.getUTCMonth();
  if (mes < 0 || (mes === 0 && agora.getUTCDate() < n.getUTCDate())) anos--;
  return anos >= 0 && anos < 130 ? anos : null;
}

/**
 * O que gravar no cartão a partir da ficha.
 *
 * `valorAtual` responde "o que já está nesse campo do cartão?" — devolve `null` quando
 * vazio. Quem chama decide como buscar; aqui só se decide o que escrever.
 */
export function escritasDoPaciente(
  ficha: FichaDaFranquia,
  valorAtual: (campo: string) => string | null,
): EscritaDoPaciente[] {
  const out: EscritaDoPaciente[] = [];
  const vazio = (c: string) => {
    const v = valorAtual(c);
    return v === null || String(v).trim() === '';
  };

  // --- os dois em que a franquia manda, mesmo com valor no cartão ---
  const sexo = sexoDaFranquia(ficha.gender);
  if (sexo && valorAtual('⚥ Sexo') !== sexo) {
    out.push({
      campo: '⚥ Sexo', tipo: 'select', valor: sexo, sobrescreve: true,
      motivo: vazio('⚥ Sexo') ? 'vazio no cartão' : 'a franquia é o cadastro',
    });
  }
  const nasc = nascimentoEmEpoch(ficha.birthdate);
  if (nasc) {
    out.push({
      campo: '◷ Data de nascimento', tipo: 'date', valor: nasc, sobrescreve: true,
      motivo: vazio('◷ Data de nascimento') ? 'vazio no cartão' : 'a franquia é o cadastro',
    });
    const idade = idadeHoje(nasc);
    if (idade !== null && String(valorAtual('# Idade') ?? '') !== String(idade)) {
      out.push({
        campo: '# Idade', tipo: 'numeric', valor: idade, sobrescreve: true,
        motivo: vazio('# Idade') ? 'vazio no cartão' : 'a idade mudou desde a última gravação',
      });
    }
  }

  // --- os demais: só preenchem buraco ---
  // Rua e número vêm separados da franquia e não servem de nada apartados; juntar aqui
  // evita dois campos meia-boca no cartão.
  const rua = [String(ficha.address ?? '').trim(), String(ficha.addressNumber ?? '').trim()]
    .filter(Boolean)
    .join(', ');
  const simples: Array<[string, string | null | undefined, EscritaDoPaciente['tipo']]> = [
    ['⌂ Endereço', rua, 'text'],
    ['⌂ Cidade', ficha.addressCity, 'textarea'],
    ['⌂ Estado', ficha.addressUf, 'text'],
    ['⚑ Origem na franquia', ficha.source, 'text'],
    ['✓ Status do paciente', ficha.status, 'select'],
  ];
  for (const [campo, valor, tipo] of simples) {
    const v = String(valor ?? '').trim();
    if (!v || !vazio(campo)) continue;
    out.push({ campo, tipo, valor: v, sobrescreve: false, motivo: 'vazio no cartão' });
  }
  return out;
}

/**
 * Corrige a idade a partir da data que JÁ está no cartão, sem consultar a franquia.
 *
 * Chamado em toda passagem do sincronizador, inclusive nos cartões que não têm buraco
 * nenhum — é o que impede a idade de envelhecer em silêncio. Devolve `null` quando não há
 * o que corrigir.
 */
export function idadeADesencalhar(
  valorAtual: (campo: string) => string | null,
  agora = new Date(),
): EscritaDoPaciente | null {
  const bruto = valorAtual('◷ Data de nascimento');
  if (!bruto) return null;
  // O Kommo devolve o campo `date` como epoch em segundos, em texto.
  const epoch = Number(bruto);
  const nasc = Number.isFinite(epoch) && epoch > 0 ? epoch : nascimentoEmEpoch(bruto);
  const idade = idadeHoje(nasc, agora);
  if (idade === null) return null;
  if (String(valorAtual('# Idade') ?? '') === String(idade)) return null;
  return {
    campo: '# Idade', tipo: 'numeric', valor: idade, sobrescreve: true,
    motivo: 'recalculada da data de nascimento do próprio cartão',
  };
}
