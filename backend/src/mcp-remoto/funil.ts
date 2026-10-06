/**
 * O funil cruzado: lead do Kommo → paciente da franquia → agendou → compareceu → tratamento.
 * Função PURA (sem rede, sem banco): recebe as listas já lidas e devolve as contagens. É aqui
 * que mora a regra de casamento, e é isto que os testes prendem.
 *
 * Como casa (medido em 06/10/2026, ver memória do projeto):
 *  - lead → paciente: TELEFONE (o da conversa do lead × o WhatsApp do cadastro na franquia);
 *    se não houver, o VÍNCULO gravado pelo sincronizador (spine_lead_links.spine_id_client).
 *    O vínculo sozinho cobre pouco (Serra: 710 vínculos, 39 com paciente), por isso é reforço.
 *  - paciente → agenda: pelo NOME (a agenda da franquia não traz idClient — só o nome);
 *  - paciente → tratamento: pelo idClient (o tratamento traz).
 * Quem não casou NÃO conta como "não agendou": entra em `semCasamento`. O relatório mostra a
 * cobertura junto com as taxas, pra ninguém ler furo de dado como resultado.
 *
 * Contagem: `leads` e `casadoPor` contam LEADS; as etapas da franquia contam PACIENTES (dois leads
 * da mesma pessoa = um paciente). Quando há dois, vale o lead MAIS ANTIGO (primeiro contato): é
 * dele a origem e é da criação dele que a agenda começa a contar.
 * Dois pacientes com o mesmo nome (homônimos) não herdam a agenda um do outro: a agenda só tem
 * nome, então o casamento paciente → agenda fica em aberto pra eles (`homonimosSemAgenda`). Mas
 * mesmo nome com o MESMO telefone é cadastro duplicado da mesma pessoa (comum na franquia), não
 * homônimo. E quem foi cadastrado antes da data de corte não está na lista de pacientes: se a agenda
 * tem consulta com aquele nome ANTES do cadastro do paciente casado, é outra pessoa — homônimo também.
 */

export interface LeadDoFunil {
  id: number;
  /** dia de criação no fuso da unidade, AAAA-MM-DD */
  criadoEm: string;
  origem: string;
  /** todos os números conhecidos do lead (contato do Kommo, conversa com a IA): casa por qualquer um */
  telefones: string[];
  idClientVinculo: number | null;
}

export interface PacienteDaFranquia {
  idClient: number;
  nome: string;
  telefone: string | null;
  /** dia do cadastro na franquia, AAAA-MM-DD (quando a franquia manda) */
  criadoEm?: string | null;
}

export interface AgendamentoDaFranquia {
  nomePaciente: string;
  /** dia da consulta no fuso da unidade */
  dia: string;
  status: string;
  idStatus?: number | null;
}

export interface TratamentoDaFranquia {
  idClient: number | null;
  /** dia de criação no fuso da unidade */
  criado: string;
  preco: number | null;
}

interface Etapas {
  leads: number;
  viraramPaciente: number;
  agendaram: number;
  compareceram: number;
  fecharamTratamento: number;
}

export interface Funil extends Etapas {
  valorDosTratamentos: number;
  pacientesComMaisDeUmLead: number;
  homonimosSemAgenda: number;
  cobertura: { comTelefoneOuVinculo: number; semTelefoneNemVinculo: number; semCasamento: number };
  casadoPor: { telefone: number; vinculo: number };
  taxas: { pacientePorLead: number | null; agendouPorLead: number | null; compareceuPorAgendou: number | null; tratamentoPorCompareceu: number | null };
  porOrigem: Record<string, Etapas>;
}

/** Igual ao `chaveTelefone` do cérebro: dígitos sem DDI e sem o 9 que ora vem, ora não. */
export function chaveTelefone(bruto: string | null | undefined): string | null {
  const so = String(bruto ?? '').replace(/\D/g, '');
  if (so.length < 10) return null;
  const semDdi = so.startsWith('55') && so.length > 11 ? so.slice(2) : so;
  if (semDdi.length < 10) return null;
  const ddd = semDdi.slice(0, 2);
  let resto = semDdi.slice(2);
  if (resto.length === 9 && resto.startsWith('9')) resto = resto.slice(1);
  return `${ddd}${resto}`;
}

/** Igual ao `normalizarNome` do cérebro: sem acento, minúsculo, só letras e números. */
export function normalizarNome(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STATUS_ATENDIDO = 42;
/** "Atendido"; não pega "Não compareceu". */
export function compareceu(a: AgendamentoDaFranquia): boolean {
  if (a.idStatus === STATUS_ATENDIDO) return true;
  const s = normalizarNome(a.status);
  return /\batendid/.test(s) || (/\bcompareceu\b/.test(s) && !/\bnao compareceu\b/.test(s));
}

const taxa = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const zerado = (): Etapas => ({ leads: 0, viraramPaciente: 0, agendaram: 0, compareceram: 0, fecharamTratamento: 0 });

export function cruzarFunil(e: {
  leads: LeadDoFunil[];
  pacientes: PacienteDaFranquia[];
  agenda: AgendamentoDaFranquia[];
  tratamentos: TratamentoDaFranquia[];
}): Funil {
  const pacientePorTelefone = new Map<string, PacienteDaFranquia>();
  const telefonesAmbiguos = new Set<string>();
  const pacientePorId = new Map<number, PacienteDaFranquia>();
  /** cadastros duplicados da mesma pessoa (mesmo nome E mesmo telefone): todos os idClient dela */
  const idsDaPessoa = new Map<number, number[]>();
  for (const p of e.pacientes) {
    pacientePorId.set(p.idClient, p);
    idsDaPessoa.set(p.idClient, [p.idClient]);
    const k = chaveTelefone(p.telefone);
    if (!k) continue;
    const ja = pacientePorTelefone.get(k);
    if (!ja) {
      pacientePorTelefone.set(k, p);
    } else if (normalizarNome(ja.nome) === normalizarNome(p.nome)) {
      // mesma pessoa cadastrada duas vezes: junta os ids (o tratamento pode estar em qualquer um)
      const grupo = [...(idsDaPessoa.get(ja.idClient) ?? [ja.idClient]), p.idClient];
      for (const id of grupo) idsDaPessoa.set(id, grupo);
    } else {
      // pessoas diferentes no mesmo número (mãe e filha): ambíguo, não casa ninguém por ele
      telefonesAmbiguos.add(k);
    }
  }
  for (const k of telefonesAmbiguos) pacientePorTelefone.delete(k);
  // homônimo = mesmo nome com telefones DIFERENTES; mesmo telefone (ou sem telefone) é cadastro duplicado
  const nomesRepetidos = new Set<string>();
  const telefonesPorNome = new Map<string, Set<string>>();
  for (const p of e.pacientes) {
    const k = normalizarNome(p.nome);
    const tel = chaveTelefone(p.telefone);
    if (!tel) continue;
    const tels = telefonesPorNome.get(k) ?? new Set<string>();
    tels.add(tel);
    telefonesPorNome.set(k, tels);
    if (tels.size > 1) nomesRepetidos.add(k);
  }
  const agendaPorNome = new Map<string, AgendamentoDaFranquia[]>();
  for (const a of e.agenda) {
    const k = normalizarNome(a.nomePaciente);
    if (k) agendaPorNome.set(k, [...(agendaPorNome.get(k) ?? []), a]);
  }
  const tratamentosPorId = new Map<number, TratamentoDaFranquia[]>();
  for (const t of e.tratamentos) {
    if (t.idClient !== null) tratamentosPorId.set(t.idClient, [...(tratamentosPorId.get(t.idClient) ?? []), t]);
  }

  const total = zerado();
  const porOrigem: Record<string, Etapas> = {};
  const casadoPor = { telefone: 0, vinculo: 0 };
  let comChave = 0;
  let semCasamento = 0;
  let valor = 0;
  let repetidos = 0;
  let homonimos = 0;
  const contados = new Set<number>(); // um paciente com dois leads conta uma vez nas etapas da franquia
  // o mais antigo primeiro: com dois leads da mesma pessoa, a origem e o ponto de partida são do primeiro contato
  const emOrdem = [...e.leads].sort((a, b) => a.criadoEm.localeCompare(b.criadoEm) || a.id - b.id);

  for (const lead of emOrdem) {
    const o = (porOrigem[lead.origem] ??= zerado());
    total.leads++;
    o.leads++;

    const chaves = [...new Set(lead.telefones.map(chaveTelefone).filter((x): x is string => !!x))];
    if (chaves.length || lead.idClientVinculo) comChave++;
    let paciente: PacienteDaFranquia | undefined;
    for (const k of chaves) {
      paciente = pacientePorTelefone.get(k);
      if (paciente) break;
    }
    if (paciente) casadoPor.telefone++;
    else if (lead.idClientVinculo && pacientePorId.has(lead.idClientVinculo)) {
      paciente = pacientePorId.get(lead.idClientVinculo);
      casadoPor.vinculo++;
    }
    if (!paciente) {
      semCasamento++;
      continue;
    }
    if (contados.has(paciente.idClient)) {
      repetidos++;
      continue;
    }
    for (const id of idsDaPessoa.get(paciente.idClient) ?? [paciente.idClient]) contados.add(id);

    total.viraramPaciente++;
    o.viraramPaciente++;
    // só o que aconteceu A PARTIR da criação do lead: consulta antiga é de outro ciclo
    const nome = normalizarNome(paciente.nome);
    const agendaDoNome = agendaPorNome.get(nome) ?? [];
    const cadastro = paciente.criadoEm;
    // consulta com esse nome antes do cadastro deste paciente: é de um homônimo mais antigo
    const homonimo = nomesRepetidos.has(nome) || (!!cadastro && agendaDoNome.some((a) => a.dia < cadastro));
    if (homonimo) homonimos++;
    const agenda = homonimo ? [] : agendaDoNome.filter((a) => a.dia >= lead.criadoEm);
    if (agenda.length) {
      total.agendaram++;
      o.agendaram++;
    }
    if (agenda.some(compareceu)) {
      total.compareceram++;
      o.compareceram++;
    }
    const trats = (idsDaPessoa.get(paciente.idClient) ?? [paciente.idClient])
      .flatMap((id) => tratamentosPorId.get(id) ?? [])
      .filter((t) => t.criado >= lead.criadoEm);
    if (trats.length) {
      total.fecharamTratamento++;
      o.fecharamTratamento++;
      valor += trats.reduce((s, t) => s + (t.preco ?? 0), 0);
    }
  }

  return {
    ...total,
    valorDosTratamentos: Math.round(valor * 100) / 100,
    pacientesComMaisDeUmLead: repetidos,
    homonimosSemAgenda: homonimos,
    cobertura: { comTelefoneOuVinculo: comChave, semTelefoneNemVinculo: total.leads - comChave, semCasamento },
    casadoPor,
    taxas: {
      pacientePorLead: taxa(total.viraramPaciente, total.leads),
      agendouPorLead: taxa(total.agendaram, total.leads),
      compareceuPorAgendou: taxa(total.compareceram, total.agendaram),
      tratamentoPorCompareceu: taxa(total.fecharamTratamento, total.compareceram),
    },
    porOrigem: Object.fromEntries(Object.entries(porOrigem).sort((a, b) => b[1].leads - a[1].leads)),
  };
}
